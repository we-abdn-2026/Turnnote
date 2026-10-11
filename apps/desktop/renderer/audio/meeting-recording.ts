import type { MeetingDetail, Result, TurnnoteApi } from '@shared/contracts';
import { fail, TurnnoteError } from '@shared/result';
import type { MeetingRecording } from '../workspace/meeting-session';
import { startCapture, type CaptureSession } from './capture';

/** Owns the media session; meeting snapshots still come exclusively from Main. */
export function createCaptureRecording(api: TurnnoteApi): MeetingRecording {
  let capture: { id: string; session: CaptureSession } | undefined;
  let generation = 0;

  async function request(operation: () => Promise<Result<MeetingDetail>>) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof TurnnoteError) return fail(error.code);
      throw error;
    }
  }

  return {
    start(id, notify) {
      const token = generation;
      return request(async () => {
        const settings = await api.settings.get();
        if (!settings.ok) return settings;
        if (token !== generation) return fail('INTERRUPTED');
        const started = await startCapture(
          {
            meetingId: id,
            // Settings null means the OS default; capture null means microphone disabled.
            microphoneDeviceId: settings.value.microphoneDeviceId ?? 'default',
            includeSystemAudio: settings.value.includeSystemAudio,
            onWarning: notify.warning,
            onError: (error) => notify.error(error.message),
          },
          api,
        );
        if (token !== generation) {
          await started.cancel();
          return fail('INTERRUPTED');
        }
        capture = { id, session: started };
        return api.meetings.get(id);
      });
    },
    stop(id) {
      return request(async () => {
        const active = capture;
        if (!active || active.id !== id) return fail('INVALID_STATE');
        await active.session.stop();
        if (capture === active) capture = undefined;
        return api.meetings.get(id);
      });
    },
    discard(id, jobId) {
      return request(async () => {
        const active = capture;
        if (active?.id === id) {
          await active.session.cancel();
          if (capture === active) capture = undefined;
          return api.meetings.get(id);
        }
        // Initialization failures have no CaptureSession, but Main retains a failed job.
        return api.recording.cancel(id, jobId);
      });
    },
    disconnect() {
      generation += 1;
      const active = capture;
      capture = undefined;
      // Save active audio on unmount; a start resolving after unmount is discarded above.
      void active?.session.stop().catch(() => {
        /* Capture reports failure to Main and releases media itself. */
      });
    },
  };
}
