import type { CapturePermissions } from '@shared/contracts';
import type { InvokeHandlers } from '@shared/invoke';
import { requireCondition } from '@shared/result';
import type { MeetingStore } from '../storage/database';
import { createStorageHandlers } from '../storage/handlers';
import { createRecordingHandlers } from '../platform/recording';
import { createTranscriptionService, type TranscriptionOptions } from './transcription';

/** The same Main composition is exercised in integration tests and Electron. */
export function createSessionServices(
  store: MeetingStore,
  options: TranscriptionOptions & { permissions: () => CapturePermissions },
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
  const transcription = createTranscriptionService(store, { ...options, emitMeeting });
  const recording = createRecordingHandlers(
    store,
    options.audioDirectory,
    emitMeeting,
    options.permissions,
    transcription.schedule,
  );
  const storage = createStorageHandlers(store, options.audioDirectory, emitMeeting, async (id) => {
    await Promise.all([recording.releaseMeeting(id), transcription.releaseMeeting(id)]);
  });
  const handlers: InvokeHandlers = {
    ...storage,
    ...recording.handlers,
    transcription: transcription.handlers,
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
    recover: recording.recover,
    interruptRecording: recording.shutdown,
    shutdown(): Promise<void> {
      closing = true;
      shutdown ??= Promise.allSettled([recording.shutdown(), transcription.shutdown()]).then(
        () => {},
      );
      return shutdown;
    },
  };
}
