// notes.generate 的 Main 编排（#17）：用户显式触发 → generating → DeepSeek → 校验 → 一次提交。
// 只发送已保存的转写和 meeting.keywords，不读取音频。失败只记录稳定错误码，转写和已有版本不变。
import type { ErrorCode, JobProgress, MeetingDetail } from '@shared/contracts';
import { canStartJob } from '@shared/lifecycle';
import { ok, requireCondition, TurnnoteError } from '@shared/result';
import type { MeetingStore, ProcessingJob } from '../storage/database';
import { DeepSeekError, requestChatCompletion, type DeepSeekOptions } from './deepseek';
import { generateNote, type ChunkLimits } from './note-pipeline';

export interface GenerationOptions {
  /** 系统凭证存储中的 API Key（#16）；未提供或返回 null 时 generate 返回 API_KEY_MISSING */
  apiKey?: () => string | null | Promise<string | null>;
  emitMeeting: (meeting: MeetingDetail) => void;
  emitProgress: (progress: JobProgress) => void;
  deepseek?: DeepSeekOptions;
  limits?: ChunkLimits;
}

export function createGenerationService(store: MeetingStore, options: GenerationOptions) {
  const runs = new Map<
    string,
    { meetingId: string; abort: AbortController; done: Promise<void> }
  >();
  let closing = false;

  function emit(meeting: MeetingDetail): void {
    try {
      options.emitMeeting(structuredClone(meeting));
    } catch {
      /* Event delivery cannot undo a committed transition. */
    }
  }
  function failureCode(error: unknown): ErrorCode {
    if (error instanceof DeepSeekError || error instanceof TurnnoteError) return error.code;
    return 'INTERNAL';
  }
  async function run(job: ProcessingJob, apiKey: string, signal: AbortSignal): Promise<void> {
    try {
      if (!store.isJobCurrent(job.id) || signal.aborted) return;
      const meeting = store.get(job.meetingId);
      const { deepseekModel } = store.getSettings();
      const note = await generateNote({
        segments: store.getSegments(job.meetingId),
        keywords: meeting.keywords,
        limits: options.limits,
        request: (messages) =>
          requestChatCompletion(
            { apiKey, model: deepseekModel, messages, signal },
            options.deepseek,
          ),
        onProgress: (percent) => {
          if (!store.isJobCurrent(job.id) || signal.aborted) return;
          try {
            options.emitProgress({
              meetingId: job.meetingId,
              jobId: job.id,
              kind: 'generating',
              percent,
            });
          } catch {
            /* A closed window cannot fail generation. */
          }
        },
      });
      // 生成期间的用户编辑使 completeGeneration 抛出 CONFLICT，由 catch 结束任务
      if (!signal.aborted && store.completeGeneration(job.id, note)) emit(store.get(job.meetingId));
    } catch (error) {
      // 只保留错误码；请求正文、模型输出和凭证不进入数据库或事件
      if (store.failJob(job.id, failureCode(error))) emit(store.get(job.meetingId));
    }
  }

  async function generate(id: string): Promise<MeetingDetail> {
    requireCondition(!closing, 'INTERRUPTED');
    // 先检查状态，避免无效请求时读取系统凭证；beginGeneration 在事务中再次检查
    requireCondition(
      canStartJob(store.get(id), 'generating', store.getSegments(id).length > 0),
      'INVALID_STATE',
    );
    const apiKey = (await options.apiKey?.())?.trim();
    requireCondition(apiKey, 'API_KEY_MISSING');
    requireCondition(!closing, 'INTERRUPTED');
    const job = store.beginGeneration(id);
    const snapshot = store.get(id);
    const abort = new AbortController();
    // Register before publishing; listeners may immediately delete the meeting.
    const done = Promise.resolve()
      .then(() => run(job, apiKey, abort.signal))
      .catch(() => {
        // If even failure persistence is unavailable, startup recovery ends the running job.
      })
      .finally(() => runs.delete(job.id));
    runs.set(job.id, { meetingId: id, abort, done });
    emit(snapshot);
    return snapshot;
  }

  return {
    handlers: { generate: async (id: string) => ok(await generate(id)) },
    async releaseMeeting(id: string): Promise<void> {
      const active = [...runs.values()].filter((run) => run.meetingId === id);
      active.forEach((run) => run.abort.abort());
      await Promise.all(active.map((run) => run.done));
    },
    async shutdown(): Promise<void> {
      closing = true;
      const active = [...runs.entries()];
      for (const [jobId, run] of active) {
        // Persist before abort; a late response can never commit over interruption.
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
