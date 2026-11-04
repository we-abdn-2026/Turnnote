import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { JobProgress, MeetingDetail } from '@shared/contracts';
import { ok, requireCondition, TurnnoteError } from '@shared/result';
import type { MeetingStore, ProcessingJob } from '../storage/database';
import { SidecarError, transcribe, type SidecarCommand } from './sidecar';
import type { SafeLogger } from '../safe-logger';

export interface TranscriptionOptions {
  audioDirectory: string;
  modelsDirectory: string;
  sidecar: () => SidecarCommand;
  emitMeeting: (meeting: MeetingDetail) => void;
  emitProgress: (progress: JobProgress) => void;
  pingTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** 本地转写模型是否就绪；未就绪时不创建任务，会议保持 captured。缺省视为就绪 */
  modelReady?: () => boolean;
  /** 转写提交后调用（#27 音频清理）；实现不得抛出 */
  afterTranscribed?: (meetingId: string) => void;
  logger?: SafeLogger;
}

export function createTranscriptionService(store: MeetingStore, options: TranscriptionOptions) {
  const audioRoot = realpathSync(options.audioDirectory);
  const pending = new Map<string, NodeJS.Timeout>();
  const runs = new Map<
    string,
    { meetingId: string; abort: AbortController; done: Promise<void> }
  >();
  let closing = false;

  function cancelScheduled(id: string): void {
    clearTimeout(pending.get(id));
    pending.delete(id);
  }
  function emit(meeting: MeetingDetail): void {
    try {
      options.emitMeeting(structuredClone(meeting));
    } catch {
      /* Event delivery cannot undo a committed transition. */
    }
  }
  function audioPath(id: string): string {
    const audio = store.getAudio(id);
    requireCondition(audio, 'AUDIO_NOT_FOUND');
    try {
      requireCondition(lstatSync(audio.filePath).isFile(), 'AUDIO_NOT_FOUND');
      const path = realpathSync(audio.filePath);
      const child = relative(audioRoot, path);
      requireCondition(
        child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child),
        'AUDIO_NOT_FOUND',
      );
      return path;
    } catch {
      throw new TurnnoteError('AUDIO_NOT_FOUND');
    }
  }
  async function run(job: ProcessingJob, signal: AbortSignal): Promise<void> {
    try {
      if (!store.isJobCurrent(job.id) || signal.aborted) return;
      const settings = store.getSettings();
      const path = audioPath(job.meetingId);
      const result = await transcribe({
        sidecar: options.sidecar(),
        jobId: job.id,
        audioPath: path,
        language: settings.transcriptionLanguage,
        modelPath: join(options.modelsDirectory, settings.transcriptionModel),
        signal,
        pingTimeoutMs: options.pingTimeoutMs,
        idleTimeoutMs: options.idleTimeoutMs,
        onProgress: (percent) => {
          if (!store.isJobCurrent(job.id) || signal.aborted) return;
          try {
            options.emitProgress({
              meetingId: job.meetingId,
              jobId: job.id,
              kind: 'transcribing',
              percent,
            });
          } catch {
            /* A closed window cannot fail transcription. */
          }
        },
      });
      if (!signal.aborted && store.completeTranscription(job.id, result.segments)) {
        // 转写已提交；清理失败只记录，不改变任务结果。事件在清理后发布，hasAudio 才是最终值。
        options.afterTranscribed?.(job.meetingId);
        emit(store.get(job.meetingId));
      }
    } catch (error) {
      // Only catalogued codes survive; stderr, paths and SQLite diagnostics stay private.
      const code =
        error instanceof SidecarError || error instanceof TurnnoteError ? error.code : 'INTERNAL';
      if (error instanceof SidecarError) {
        options.logger?.sidecarFailure(code, error.stderrTail, error);
      } else {
        options.logger?.error('main', 'transcription_failed', code, error);
      }
      if (store.failJob(job.id, code)) emit(store.get(job.meetingId));
    }
  }
  function start(id: string): MeetingDetail {
    requireCondition(!closing, 'INTERRUPTED');
    // 模型未就绪时不建任务：不会出现莫名的失败，下载完成后由 resumePending 自动补上
    requireCondition(options.modelReady?.() ?? true, 'MODEL_NOT_READY');
    const job = store.beginTranscription(id);
    cancelScheduled(id);
    const snapshot = store.get(id);
    const abort = new AbortController();
    // Register before publishing; callbacks may immediately cancel, retry or delete.
    const done = Promise.resolve()
      .then(() => run(job, abort.signal))
      .catch(() => {
        // If even failure persistence is unavailable, startup recovery ends the running job.
        // Never leak an unhandled rejection or raw storage diagnostics from a background task.
      })
      .finally(() => runs.delete(job.id));
    runs.set(job.id, { meetingId: id, abort, done });
    emit(snapshot);
    return snapshot;
  }

  function schedule(id: string): void {
    if (closing) return;
    cancelScheduled(id);
    const timer = setTimeout(() => {
      if (closing || pending.get(id) !== timer) return;
      pending.delete(id);
      // Deletion or manual start/cancel may invalidate this captured notification.
      try {
        if (store.get(id).status === 'captured') start(id);
      } catch {
        /* Deleted meetings, unavailable storage or a model that is not ready cannot launch a sidecar. */
      }
    }, 0);
    pending.set(id, timer);
  }
  /**
   * 为「从未尝试过转写」的 captured 会议补发自动转写：模型下载完成时、以及启动恢复时调用。
   * 用户取消过的会议已有 transcribing 任务记录，不会被擅自重新启动。
   */
  function resumePending(): void {
    for (const { id } of store.list()) {
      try {
        if (store.get(id).status !== 'captured') continue;
        if (store.getJobs(id).some((job) => job.kind === 'transcribing')) continue;
        schedule(id);
      } catch {
        /* 单个会议读取失败不影响其他会议 */
      }
    }
  }

  return {
    handlers: {
      start: async (id: string) => ok(start(id)),
      cancel: async (id: string, jobId: string) => {
        const snapshot = store.cancelTranscription(id, jobId);
        cancelScheduled(id);
        const active = runs.get(jobId);
        active?.abort.abort();
        emit(snapshot);
        await active?.done;
        return ok(snapshot);
      },
      getSegments: async (id: string) => ok(store.getSegments(id)),
    },
    schedule,
    resumePending,
    async releaseMeeting(id: string): Promise<void> {
      cancelScheduled(id);
      const active = [...runs.values()].filter((run) => run.meetingId === id);
      active.forEach((run) => run.abort.abort());
      await Promise.all(active.map((run) => run.done));
    },
    async shutdown(): Promise<void> {
      closing = true;
      for (const id of pending.keys()) cancelScheduled(id);
      const active = [...runs.entries()];
      for (const [jobId, run] of active) {
        // Persist before abort; late done can never commit over interruption.
        try {
          if (store.failJob(jobId, 'INTERRUPTED')) emit(store.get(run.meetingId));
        } catch {
          /* Startup recovery handles jobs whose interruption could not be persisted. */
        } finally {
          run.abort.abort();
        }
      }
      await Promise.all(active.map(([, run]) => run.done));
    },
  };
}
