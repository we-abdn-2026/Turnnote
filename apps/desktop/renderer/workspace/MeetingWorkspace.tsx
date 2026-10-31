import {
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactElement,
} from 'react';
import type { MeetingDetail, MeetingStatus, TurnnoteApi } from '@shared/contracts';
import { createCaptureRecording } from '../audio/meeting-recording';
import type { MeetingRecording } from './meeting-session';
import {
  TRANSCRIPT_LOAD_FAILED_MESSAGE,
  availableActions,
  createMeetingSession,
  isRecording,
} from './meeting-session';
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

export function formatTranscriptTime(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const parts = [minutes, seconds].map((part) => String(part).padStart(2, '0'));
  return hours > 0 ? `${String(hours).padStart(2, '0')}:${parts.join(':')}` : parts.join(':');
}

function canShowGenerationAction(meeting: MeetingDetail): boolean {
  return (
    meeting.status === 'transcribed' ||
    meeting.status === 'generating' ||
    meeting.status === 'ready' ||
    (meeting.status === 'failed' && meeting.lastError?.kind === 'generating')
  );
}

export function MeetingWorkspace({
  recordingFactory = createCaptureRecording,
}: {
  recordingFactory?: (api: TurnnoteApi) => MeetingRecording;
}): ReactElement {
  const [session] = useState(() =>
    createMeetingSession(window.turnnote, recordingFactory(window.turnnote)),
  );
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const [title, setTitle] = useState('');
  const [generationPrompt, setGenerationPrompt] = useState<{
    meetingId: string;
    revision: number;
  } | null>(null);

  useEffect(() => session.connect(), [session]);

  const actions = availableActions(state);
  const recording = isRecording(state);
  const { meeting } = state;
  const generationPromptOpen =
    !!meeting &&
    generationPrompt?.meetingId === meeting.id &&
    generationPrompt.revision === state.revision &&
    actions.generate;

  useEffect(() => {
    if (!generationPromptOpen) return;

    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setGenerationPrompt(null);
    };

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [generationPromptOpen]);

  const savePending = meeting?.status === 'recording' && state.captureStopped;
  const processingKind =
    meeting?.status === 'transcribing' || meeting?.status === 'generating' ? meeting.status : null;
  const processingLabel =
    processingKind === 'transcribing'
      ? '转写进度'
      : processingKind === 'generating'
        ? '纪要生成进度'
        : null;

  async function handleCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (await session.create(title)) setTitle('');
  }

  function openGenerationPrompt(): void {
    const current = state.meeting;
    if (!current || !actions.generate) return;

    setGenerationPrompt({
      meetingId: current.id,
      revision: state.revision,
    });
  }

  function closeGenerationPrompt(): void {
    setGenerationPrompt(null);
  }

  async function confirmGeneration(): Promise<void> {
    if (!generationPromptOpen) return;

    // 先关闭确认框；会话层仍会拒绝重复请求。
    setGenerationPrompt(null);
    await session.generate();
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
          aria-describedby={recording || savePending ? 'create-blocked' : undefined}
        />
        <button type="submit" disabled={!actions.create || !title.trim()}>
          {state.pending === 'create' ? '创建中...' : '新建会议'}
        </button>
      </form>
      {(recording || savePending) && (
        <p id="create-blocked" className="create-blocked">
          {savePending
            ? '录音已结束，保存完成后才能新建会议。'
            : '正在录音，停止录音后才能新建会议。'}
        </p>
      )}

      {state.error && (
        <div className="workspace-error" role="alert">
          <strong>操作失败</strong>
          <p>{state.error}</p>
        </div>
      )}

      {state.warning && <p role="status">{state.warning}</p>}

      {meeting && (
        <div className="meeting-panel">
          <h2>{meeting.title}</h2>
          <p className="meeting-status" role="status" aria-live="polite">
            {savePending
              ? '录音已结束，等待保存'
              : state.cancelledKind === 'transcribing' && meeting.status === 'captured'
                ? '转写已取消，录音已保存'
                : STATUS_LABELS[meeting.status]}
            {meeting.status === 'failed' && meeting.lastError && `：${meeting.lastError.message}`}
          </p>
          {processingKind && processingLabel && (
            <div className="processing-progress" aria-live="polite">
              <div className="processing-progress-heading">
                <span>{processingLabel}</span>
                <span>{state.jobProgress ? `${state.jobProgress.percent}%` : '等待进度上报'}</span>
              </div>
              <progress
                aria-label={processingLabel}
                max={100}
                {...(state.jobProgress ? { value: state.jobProgress.percent } : {})}
              />
            </div>
          )}
          <RecordingControls session={session} state={state} />
          <section className="transcript" aria-labelledby="transcript-heading">
            <div className="transcript-heading">
              <h3 id="transcript-heading">转写内容</h3>
              {state.transcriptState === 'ready' && state.transcriptSegments.length > 0 && (
                <span>{state.transcriptSegments.length} 个片段</span>
              )}
            </div>
            {state.transcriptState === 'loading' && state.transcriptSegments.length === 0 && (
              <p className="transcript-message" role="status">
                正在加载转写内容...
              </p>
            )}
            {state.transcriptState === 'error' && (
              <div className="transcript-error" role="alert">
                <p>{TRANSCRIPT_LOAD_FAILED_MESSAGE}</p>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void session.reloadTranscript()}
                >
                  重新加载
                </button>
              </div>
            )}
            {state.transcriptState === 'ready' && state.transcriptSegments.length === 0 && (
              <p className="transcript-message">暂无转写内容</p>
            )}
            {state.transcriptSegments.length > 0 && (
              <ol className="transcript-list" aria-label="转写片段">
                {state.transcriptSegments.map((segment, index) => (
                  <li
                    className="transcript-segment"
                    id={`transcript-segment-${index}`}
                    data-segment-index={index}
                    data-start-ms={segment.startMs}
                    data-end-ms={segment.endMs}
                    tabIndex={-1}
                    key={`${index}-${segment.startMs}-${segment.endMs}`}
                  >
                    <time className="transcript-time">
                      {formatTranscriptTime(segment.startMs)}–{formatTranscriptTime(segment.endMs)}
                    </time>
                    <span className="transcript-text">{segment.text}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section className="note-generation" aria-labelledby="generation-heading">
            <div className="note-generation-heading">
              <div>
                <h3 id="generation-heading">AI 会议纪要</h3>
                <p className="note-generation-help">
                  根据已保存的转写生成会议纪要，发送前会再次确认。
                </p>
              </div>
              {canShowGenerationAction(meeting) && (
                <button type="button" onClick={openGenerationPrompt} disabled={!actions.generate}>
                  {state.pending === 'generate' ? '正在生成...' : '生成会议纪要'}
                </button>
              )}
            </div>

            {generationPromptOpen && (
              <div
                className="generation-consent"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="generation-consent-title"
                aria-describedby="generation-consent-description"
              >
                <button
                  type="button"
                  className="generation-consent-close"
                  aria-label="关闭发送确认"
                  onClick={closeGenerationPrompt}
                >
                  ×
                </button>
                <strong id="generation-consent-title">发送会议内容给 DeepSeek？</strong>
                <p id="generation-consent-description">
                  将向 DeepSeek
                  发送本次会议已保存的转写文本，以及生成纪要所需的必要上下文，例如会议标题和关键词。原始音频不会发送。
                </p>
                <div className="meeting-actions">
                  <button type="button" onClick={() => void confirmGeneration()}>
                    确认发送并生成
                  </button>
                  <button type="button" className="secondary" onClick={closeGenerationPrompt}>
                    取消
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
