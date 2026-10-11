import {
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactElement,
} from 'react';
import type { MeetingStatus } from '@shared/contracts';
import { availableActions, createMeetingSession } from './meeting-session';
import { RecordingControls } from './RecordingControls';

export const STATUS_LABELS: Record<MeetingStatus, string> = {
  created: '已创建，未开始录音',
  recording: '录音中',
  captured: '录音已保存',
  transcribing: '正在转写',
  transcribed: '转写完成',
  generating: '正在生成纪要',
  ready: '纪要已生成',
  failed: '处理失败',
  deleted: '已删除',
};

export function MeetingWorkspace(): ReactElement {
  const [session] = useState(() => createMeetingSession(window.turnnote));
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const [title, setTitle] = useState('');

  useEffect(() => session.connect(), [session]);

  const actions = availableActions(state);
  const { meeting } = state;

  async function handleCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (await session.create(title)) setTitle('');
  }

  return (
    <section className="workspace" aria-label="录音工作区">
      <form className="create-meeting" onSubmit={(e) => void handleCreate(e)}>
        <label htmlFor="meeting-title">会议标题</label>
        <input
          id="meeting-title"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          disabled={!actions.create}
        />
        <button type="submit" disabled={!actions.create || !title.trim()}>
          {state.pending === 'create' ? '创建中...' : '新建会议'}
        </button>
      </form>

      {state.error && (
        <div className="workspace-error" role="alert">
          <strong>操作失败</strong>
          <p>{state.error}</p>
        </div>
      )}

      {meeting && (
        <div className="meeting-panel">
          <h2>{meeting.title}</h2>
          <p className="meeting-status" role="status" aria-live="polite">
            {STATUS_LABELS[meeting.status]}
            {meeting.status === 'failed' && meeting.lastError && `：${meeting.lastError.message}`}
          </p>
          <RecordingControls session={session} state={state} />
        </div>
      )}
    </section>
  );
}
