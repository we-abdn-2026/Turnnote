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
  const writers = new Map<string, AudioWriter>();
  const owners = new Map<string, string>();
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
  function current(id: string, jobId: string): AudioWriter {
    const meeting = store.get(id);
    requireCondition(
      meeting.status === 'recording' && meeting.activeJobId === jobId,
      'INVALID_STATE',
    );
    const writer = writers.get(jobId);
    requireCondition(writer, 'INVALID_STATE');
    return writer;
  }
  async function close(jobId: string) {
    const writer = writers.get(jobId);
    writers.delete(jobId);
    owners.delete(jobId);
    await writer?.finalize();
  }
  const handlers: InvokeHandlers = {
    recording: {
      getPermissions: async () => ok(permissions()),
      start: async (id) => {
        requireCondition(store.get(id).status === 'created', 'INVALID_STATE');
        requireCondition(writers.size === 0, 'INVALID_STATE');
        const path = join(directory, `${randomUUID()}.wav`);
        const writer = createAudioWriter(path);
        try {
          const job = store.beginRecording(id, path);
          writers.set(job.id, writer);
          owners.set(job.id, id);
        } catch (error) {
          await writer.finalize();
          unlinkSync(path);
          throw error;
        }
        return updated(id);
      },
      appendChunk: async (id, jobId, chunk) => {
        const writer = current(id, jobId);
        try {
          writer.append(chunk);
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'INVALID_INPUT')
            throw error;
          try {
            await close(jobId);
          } catch {
            /* Preserve audio on disk failure. */
          }
          store.failJob(jobId, 'WRITE_FAILED');
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
          store.failJob(jobId, 'WRITE_FAILED');
          emit(store.get(id));
          return fail('WRITE_FAILED');
        }
        requireCondition(store.finishRecording(jobId), 'INVALID_STATE');
        const captured = updated(id);
        // #7 supplies the ASR starter. Never claim transcription before it exists.
        if (afterCapture) setTimeout(() => afterCapture(id), 0);
        return captured;
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
            emit(store.get(id));
            return fail('WRITE_FAILED');
          }
        }
        store.cancelRecording(id, jobId);
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
        for (const [jobId, meetingId] of owners) {
          if (meetingId === id) {
            try {
              await close(jobId);
            } catch {
              /* Delete handler reports disk errors. */
            }
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
        for (const jobId of [...writers.keys()]) {
          let code: 'INTERRUPTED' | 'WRITE_FAILED' = 'INTERRUPTED';
          try {
            await close(jobId);
          } catch {
            code = 'WRITE_FAILED';
          }
          store.failJob(jobId, code);
        }
      });
    },
  };
}
