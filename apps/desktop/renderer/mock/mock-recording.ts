import type { TurnnoteApi } from '@shared/contracts';
import type { MeetingRecording } from '../workspace/meeting-session';

/** dev:web simulates jobs without requesting media or claiming to produce a WAV. */
export function createMockRecording(api: TurnnoteApi): MeetingRecording {
  return {
    start: (id) => api.recording.start(id),
    stop: (id, jobId) => api.recording.stop(id, jobId),
    discard: (id, jobId) => api.recording.cancel(id, jobId),
    disconnect() {},
  };
}
