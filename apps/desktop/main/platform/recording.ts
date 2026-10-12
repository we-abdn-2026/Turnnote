import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { CapturePermissions, MeetingDetail } from '@shared/contracts';
import type { InvokeHandlers } from '@shared/invoke';
import { canCancelRecording } from '@shared/lifecycle';
import { fail, ok, requireCondition } from '@shared/result';
import type { MeetingStore } from '../storage/database';
import { createAudioWriter, repairWavHeader, type AudioWriter } from './audio-writer';

export function createRecordingHandlers(
  store: MeetingStore,
  directory: string,
  emit: (meeting: MeetingDetail) => void,
  permissions: () => CapturePermissions,
  afterCapture?: (meetingId: string) => void,
) {
  // Ownership outlives file closure: a rolled-back terminal transaction remains retryable.
  const recordings = new Map<
    string,
    {
      meetingId: string;
      writer: AudioWriter;
      finalizing?: Promise<void>;
    }
  >();
  let queue: Promise<void> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  const updated = (id: string) => {
    const meeting = store.get(id);
    emit(meeting);
    return ok(meeting);
  };
  function current(id: string, jobId: string) {
    const meeting = store.get(id);
    requireCondition(
      meeting.status === 'recording' && meeting.activeJobId === jobId,
      'INVALID_STATE',
    );
    const recording = recordings.get(jobId);
    requireCondition(recording?.meetingId === id, 'INVALID_STATE');
    return recording;
  }
  async function close(jobId: string) {
    const recording = recordings.get(jobId);
    if (recording) {
      recording.finalizing ??= recording.writer.finalize();
      await recording.finalizing;
    }
  }
  const handlers: InvokeHandlers = {
    recording: {
      getPermissions: async () => ok(permissions()),
      start: async (id) => {
        requireCondition(store.get(id).status === 'created', 'INVALID_STATE');
        requireCondition(recordings.size === 0, 'INVALID_STATE');
        const path = join(directory, `${randomUUID()}.wav`);
        const writer = createAudioWriter(path);
        try {
          const job = store.beginRecording(id, path);
          recordings.set(job.id, { meetingId: id, writer });
        } catch (error) {
          await writer.finalize();
          unlinkSync(path);
          throw error;
        }
        return updated(id);
      },
      appendChunk: async (id, jobId, chunk) => {
        const recording = current(id, jobId);
        requireCondition(!recording.finalizing, 'INVALID_STATE');
        try {
          recording.writer.append(chunk);
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'INVALID_INPUT')
            throw error;
          try {
            await close(jobId);
          } catch {
            /* Preserve audio on disk failure. */
          }
          requireCondition(store.failJob(jobId, 'WRITE_FAILED'), 'INVALID_STATE');
          recordings.delete(jobId);
          emit(store.get(id));
          return fail('WRITE_FAILED');
        }
        return ok(null);
      },
      stop: async (id, jobId) => {
        current(id, jobId);
        try {
          await close(jobId);
        } catch {
          requireCondition(store.failJob(jobId, 'WRITE_FAILED'), 'INVALID_STATE');
          recordings.delete(jobId);
          emit(store.get(id));
          return fail('WRITE_FAILED');
        }
        requireCondition(store.finishRecording(jobId), 'INVALID_STATE');
        recordings.delete(jobId);
        // Register before publishing: listeners may immediately start and cancel ASR.
        afterCapture?.(id);
        return updated(id);
      },
      fail: async (id, jobId, code) => {
        const meeting = store.get(id);
        if (
          meeting.status === 'failed' &&
          meeting.lastError?.kind === 'recording' &&
          meeting.lastError.jobId === jobId
        )
          return ok(meeting);
        current(id, jobId);
        try {
          await close(jobId);
        } catch {
          code = 'WRITE_FAILED';
        }
        requireCondition(store.failJob(jobId, code), 'INVALID_STATE');
        recordings.delete(jobId);
        return updated(id);
      },
      cancel: async (id, jobId) => {
        const meeting = store.get(id);
        requireCondition(
          canCancelRecording(meeting) &&
            (meeting.activeJobId ?? meeting.lastError?.jobId) === jobId,
          'INVALID_STATE',
        );
        try {
          await close(jobId);
        } catch {
          /* Explicit discard still attempts deletion. */
        }
        try {
          const audio = store.getAudio(id);
          if (audio) unlinkSync(audio.filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            store.failJob(jobId, 'WRITE_FAILED');
            recordings.delete(jobId);
            emit(store.get(id));
            return fail('WRITE_FAILED');
          }
        }
        store.cancelRecording(id, jobId);
        recordings.delete(jobId);
        return updated(id);
      },
    },
  };
  const methods = handlers.recording!;
  handlers.recording = {
    getPermissions: methods.getPermissions,
    start: (id) => serialize(() => methods.start!(id)),
    appendChunk: (id, jobId, chunk) => serialize(() => methods.appendChunk!(id, jobId, chunk)),
    stop: (id, jobId) => serialize(() => methods.stop!(id, jobId)),
    cancel: (id, jobId) => serialize(() => methods.cancel!(id, jobId)),
    fail: (id, jobId, code) => serialize(() => methods.fail!(id, jobId, code)),
  };
  return {
    handlers,
    releaseMeeting(id: string) {
      return serialize(async () => {
        // Cleanup uses live ownership, so deleted tombstones and repeat calls are safe.
        for (const [jobId, { meetingId }] of recordings) {
          if (meetingId === id) {
            try {
              await close(jobId);
            } catch {
              /* Delete handler reports disk errors. */
            }
            recordings.delete(jobId);
          }
        }
      });
    },
    async recover() {
      for (const meeting of store.list()) {
        if (meeting.status !== 'recording') continue;
        const detail = store.get(meeting.id);
        const audio = store.getAudio(meeting.id);
        if (audio) await repairWavHeader(audio.filePath);
        if (detail.activeJobId) store.failJob(detail.activeJobId, 'INTERRUPTED');
      }
    },
    shutdown() {
      return serialize(async () => {
        for (const jobId of [...recordings.keys()]) {
          let code: 'INTERRUPTED' | 'WRITE_FAILED' = 'INTERRUPTED';
          try {
            await close(jobId);
          } catch {
            code = 'WRITE_FAILED';
          }
          store.failJob(jobId, code);
          recordings.delete(jobId);
        }
      });
    },
  };
}
