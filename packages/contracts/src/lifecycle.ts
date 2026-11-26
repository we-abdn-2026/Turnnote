import type { JobKind, MeetingDetail } from './contracts';

/** Main 数据库和浏览器 mock 共用的启动条件。 */
export function canStartJob(
  meeting: MeetingDetail,
  kind: JobKind,
  hasTranscript: boolean,
): boolean {
  // 录音可以是第一段，也可以是暂停后继续、对已有转写追加的下一段；
  // 进行中的任务（录音、转写、生成）和失败的录音（须先丢弃）不能开始新的一段
  if (kind === 'recording') return canAddRecording(meeting);
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

/** 这场会议现在能不能录下一段 */
export function canAddRecording(meeting: MeetingDetail): boolean {
  return (
    ['created', 'captured', 'transcribed', 'ready'].includes(meeting.status) ||
    (meeting.status === 'failed' &&
      (meeting.lastError?.kind === 'transcribing' || meeting.lastError?.kind === 'generating'))
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
