import type { CapturePermissions } from '@shared/contracts';
import type { InvokeHandlers } from '@shared/invoke';
import { ok, requireCondition } from '@shared/result';
import type { MeetingStore } from '../storage/database';
import { createStorageHandlers } from '../storage/handlers';
import { createRecordingHandlers } from '../platform/recording';
import { createTranscriptionService, type TranscriptionOptions } from './transcription';
import { createGenerationService, type GenerationOptions } from './generation';
import { createAudioRetention } from './audio-retention';
import { createExportHandlers, type ExportOptions } from './export';
import { createImportHandlers, type ImportOptions } from './import-audio';
import type { CredentialStore } from '../platform/credentials';

/** The same Main composition is exercised in integration tests and Electron. */
export function createSessionServices(
  store: MeetingStore,
  options: TranscriptionOptions &
    Omit<GenerationOptions, 'emitMeeting' | 'emitProgress'> & {
      permissions: () => CapturePermissions;
      credentials?: CredentialStore;
      /** 未提供时 exports.markdown 返回 NOT_IMPLEMENTED（例如无窗口的测试环境） */
      exports?: ExportOptions;
      /** 未提供时 meetings.importAudio 返回 NOT_IMPLEMENTED（例如无窗口的测试环境） */
      importAudio?: Pick<ImportOptions, 'chooseFile'>;
    },
) {
  let shutdown: Promise<void> | undefined;
  let closing = false;
  const emitMeeting: TranscriptionOptions['emitMeeting'] = (meeting) => {
    try {
      options.emitMeeting(structuredClone(meeting));
    } catch {
      /* Window delivery cannot change storage or resource cleanup. */
    }
  };
  const retention = createAudioRetention(store, options.audioDirectory, options.logger);
  const transcription = createTranscriptionService(store, {
    ...options,
    emitMeeting,
    afterTranscribed: retention.tryRelease,
  });
  const generation = createGenerationService(store, {
    ...options,
    credentials: options.credentials,
    emitMeeting,
  });
  const recording = createRecordingHandlers(
    store,
    options.audioDirectory,
    emitMeeting,
    options.permissions,
    transcription.schedule,
  );
  const storage = createStorageHandlers(
    store,
    options.audioDirectory,
    emitMeeting,
    async (id) => {
      await Promise.all([
        recording.releaseMeeting(id),
        transcription.releaseMeeting(id),
        generation.releaseMeeting(id),
      ]);
    },
    options.credentials,
  );
  const handlers: InvokeHandlers = {
    ...storage,
    ...recording.handlers,
    transcription: transcription.handlers,
    notes: { ...storage.notes, ...generation.handlers },
    meetings: {
      ...storage.meetings,
      ...(options.importAudio &&
        createImportHandlers(store, {
          audioDirectory: options.audioDirectory,
          chooseFile: options.importAudio.chooseFile,
          emit: emitMeeting,
          schedule: transcription.schedule,
        })),
      // 取消保留时，已转写会议的音频立即按策略清理；开启保留不会恢复已删除的音频。
      setRetainAudio: async (id, retain) => {
        const result = await storage.meetings!.setRetainAudio!(id, retain);
        if (retain || !retention.tryRelease(id)) return result;
        const meeting = store.get(id);
        emitMeeting(meeting);
        return ok(meeting);
      },
    },
    ...(options.exports && { exports: createExportHandlers(store, options.exports) }),
  };
  // Once quitting begins, no IPC call can create resources after shutdown's snapshot.
  for (const methods of Object.values(handlers)) {
    for (const [name, method] of Object.entries(methods)) {
      Object.assign(methods, {
        [name]: (...args: Parameters<typeof method>) => {
          requireCondition(!closing, 'INTERRUPTED');
          return method(...args);
        },
      });
    }
  }
  return {
    handlers,
    async recover() {
      await recording.recover();
      retention.sweep();
    },
    interruptRecording: recording.shutdown,
    shutdown(): Promise<void> {
      closing = true;
      shutdown ??= Promise.allSettled([
        recording.shutdown(),
        transcription.shutdown(),
        generation.shutdown(),
      ]).then(() => {});
      return shutdown;
    },
  };
}
