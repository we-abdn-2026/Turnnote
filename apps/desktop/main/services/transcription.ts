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
    schedule(id: string): void {
      if (closing) return;
      cancelScheduled(id);
      const timer = setTimeout(() => {
        if (closing || pending.get(id) !== timer) return;
        pending.delete(id);
        // Deletion or manual start/cancel may invalidate this captured notification.
        try {
          if (store.get(id).status === 'captured') start(id);
        } catch {
          /* Deleted meetings or unavailable storage cannot launch a sidecar. */
        }
      }, 0);
      pending.set(id, timer);
    },
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
