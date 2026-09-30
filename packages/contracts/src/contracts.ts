export type MeetingStatus =
  | 'created'
  | 'recording'
  | 'captured'
  | 'transcribing'
  | 'transcribed'
  | 'generating'
  | 'ready'
  | 'failed'
  | 'deleted';

export interface MeetingSummary {
  id: string;
  title: string;
  status: MeetingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface MeetingNote {
  summary: string;
  keyTopics: string[];
  decisions: string[];
  openQuestions: string[];
  actionItems: Array<{
    task: string;
    owner: string | 'unspecified';
    dueDate: string | 'unspecified';
  }>;
}

export interface TurnnoteApi {
  getAppInfo(): Promise<{ name: 'Turnnote'; version: string }>;
  listMeetings(): Promise<MeetingSummary[]>;
}
