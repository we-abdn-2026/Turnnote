import { useEffect, useRef, useState } from 'react';
import type { MeetingDetail } from '@shared/contracts';
import { startCapture, type CaptureSession } from './capture';

/** Minimal capture controls until the full meeting workspace is integrated. */
export function RecordingControls() {
  const [meeting, setMeeting] = useState<MeetingDetail>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [microphone, setMicrophone] = useState(true);
  const [systemAudio, setSystemAudio] = useState(true);
  const session = useRef<CaptureSession | undefined>(undefined);
  const meetingId = useRef<string | undefined>(undefined);
  useEffect(
    () =>
      window.turnnote.events.onMeetingUpdated((value) => {
        if (value.id === meetingId.current) setMeeting(value);
      }),
    [],
  );

  async function start() {
    setBusy(true);
    setMessage('');
    try {
      const created = await window.turnnote.meetings.create(
        `Meeting ${new Date().toLocaleString()}`,
      );
      if (!created.ok) {
        setMessage(created.error.message);
        return;
      }
      meetingId.current = created.value.id;
      setMeeting(created.value);
      session.current = await startCapture({
        meetingId: created.value.id,
        microphoneDeviceId: microphone ? 'default' : null,
        includeSystemAudio: systemAudio,
        onWarning: setMessage,
        onError: (error) => setMessage(error.message),
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Audio capture failed.');
    } finally {
      setBusy(false);
    }
  }
  async function finish(discard: boolean) {
    setBusy(true);
    try {
      if (discard && meeting?.lastError?.kind === 'recording') {
        const result = await window.turnnote.recording.cancel(meeting.id, meeting.lastError.jobId);
        if (!result.ok) {
          setMessage(result.error.message);
          return;
        }
      } else if (discard) await session.current?.cancel();
      else await session.current?.stop();
      session.current = undefined;
      if (!discard)
        setMessage('Recording saved. Transcription will be available in a later update.');
      else setMessage('Recording discarded.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The recording could not be finished.');
    } finally {
      setBusy(false);
    }
  }
  const active = meeting?.status === 'recording';
  const failed = meeting?.status === 'failed' && meeting.lastError?.kind === 'recording';
  return (
    <section className="recording-controls" aria-label="Audio recording">
      <label>
        <input
          type="checkbox"
          checked={microphone}
          disabled={busy || active}
          onChange={(event) => setMicrophone(event.target.checked)}
        />{' '}
        Microphone
      </label>
      <label>
        <input
          type="checkbox"
          checked={systemAudio}
          disabled={busy || active}
          onChange={(event) => setSystemAudio(event.target.checked)}
        />{' '}
        System audio
      </label>
      <button
        type="button"
        disabled={busy || active || failed || (!microphone && !systemAudio)}
        onClick={() => void start()}
      >
        Start meeting
      </button>
      {active && (
        <button type="button" disabled={busy} onClick={() => void finish(false)}>
          Stop and save
        </button>
      )}
      {(active || failed) && (
        <button type="button" disabled={busy} onClick={() => void finish(true)}>
          Discard recording
        </button>
      )}
      <p role="status">
        {active ? 'Recording…' : ''} {message}
      </p>
    </section>
  );
}
