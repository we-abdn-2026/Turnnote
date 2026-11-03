import type { JobKind, MeetingDetail } from './contracts';

/** Main 数据库和浏览器 mock 共用的启动条件。 */
export function canStartJob(
  meeting: MeetingDetail,
  kind: JobKind,
  hasTranscript: boolean,
): boolean {
  if (kind === 'recording') return meeting.status === 'created' && !meeting.hasAudio;
  if (kind === 'transcribing') {
    return (
      meeting.hasAudio &&
      (meeting.status === 'captured' ||
        (meeting.status === 'failed' && meeting.lastError?.kind === 'transcribing'))
    );
  }
  return (
    hasTranscript &&
    (meeting.status === 'transcribed' ||
      meeting.status === 'ready' ||
      (meeting.status === 'failed' && meeting.lastError?.kind === 'generating'))
  );
}

export function canCancelRecording(meeting: MeetingDetail): boolean {
  return (
    meeting.status === 'recording' ||
    (meeting.status === 'failed' && meeting.lastError?.kind === 'recording')
  );
}

export function canEditNote(meeting: MeetingDetail): boolean {
  return (
    ['transcribed', 'ready', 'generating'].includes(meeting.status) ||
    (meeting.status === 'failed' && meeting.lastError?.kind === 'generating')
  );
}
