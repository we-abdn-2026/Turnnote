// notes.generate 的 Main 编排（#17）：用户显式触发 → generating → AI provider → 校验 → 一次提交。
// 只发送已保存的转写和 meeting.keywords，不读取音频。失败只记录稳定错误码，转写和已有版本不变。
import type { ErrorCode, JobProgress, MeetingDetail } from '@shared/contracts';
import { canStartJob } from '@shared/lifecycle';
import { ok, requireCondition, TurnnoteError } from '@shared/result';
import type { MeetingStore, ProcessingJob } from '../storage/database';
import { DeepSeekError, requestChatCompletion, type AiProviderOptions } from './deepseek';
import { generateNote, type ChunkLimits } from './note-pipeline';
import type { CredentialStore } from '../platform/credentials';

export interface GenerationOptions {
  /** 凭证存储；按 settings.noteProvider 读取对应 provider 的 API Key */
  credentials?: CredentialStore;
  /** provider 请求选项（baseUrl、超时、测试 fetch 注入） */
  provider?: AiProviderOptions;
  emitMeeting: (meeting: MeetingDetail) => void;
  emitProgress: (progress: JobProgress) => void;
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
      const { noteProvider, noteModel } = store.getSettings();
      const note = await generateNote({
        segments: store.getSegments(job.meetingId),
        keywords: meeting.keywords,
        limits: options.limits,
        request: (messages) =>
          requestChatCompletion(
            { apiKey, model: noteModel, messages, signal },
            { ...options.provider, provider: noteProvider },
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
      if (!signal.aborted && store.completeGeneration(job.id, note)) emit(store.get(job.meetingId));
    } catch (error) {
      if (store.failJob(job.id, failureCode(error))) emit(store.get(job.meetingId));
    }
  }

  async function generate(id: string): Promise<MeetingDetail> {
    requireCondition(!closing, 'INTERRUPTED');
    requireCondition(
      canStartJob(store.get(id), 'generating', store.getSegments(id).length > 0),
      'INVALID_STATE',
    );
    const { noteProvider } = store.getSettings();
    const apiKey = options.credentials?.get(noteProvider)?.trim();
    requireCondition(apiKey, 'API_KEY_MISSING');
    requireCondition(!closing, 'INTERRUPTED');
    const job = store.beginGeneration(id);
    const snapshot = store.get(id);
    const abort = new AbortController();
    const done = Promise.resolve()
      .then(() => run(job, apiKey, abort.signal))
      .catch(() => {})
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
