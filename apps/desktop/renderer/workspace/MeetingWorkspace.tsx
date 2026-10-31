import {
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactElement,
} from 'react';
import type { MeetingStatus, TurnnoteApi } from '@shared/contracts';
import { createCaptureRecording } from '../audio/meeting-recording';
import type { MeetingRecording } from './meeting-session';
import {
  TRANSCRIPT_LOAD_FAILED_MESSAGE,
  NOTE_LOAD_FAILED_MESSAGE,
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

function displayNoteValue(value: string): string {
  const normalized = value.trim();
  return normalized === '' || normalized.toLowerCase() === 'unspecified' ? '未指定' : normalized;
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

  useEffect(() => session.connect(), [session]);

  const actions = availableActions(state);
  const recording = isRecording(state);
  const { meeting } = state;
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
          <section className="meeting-note" aria-labelledby="note-heading">
            <div className="note-heading">
              <h3 id="note-heading">会议纪要</h3>
              {state.note && (
                <div className="note-meta">
                  <span className={`note-source note-source-${state.note.source}`}>
                    {state.note.source === 'generated' ? 'AI 生成' : '用户编辑'}
                  </span>
                  <span>版本 {state.note.version}</span>
                </div>
              )}
            </div>

            {state.noteState === 'loading' && !state.note && (
              <p className="note-message" role="status">
                正在加载纪要...
              </p>
            )}

            {state.noteState === 'error' && (
              <div className="note-error" role="alert">
                <p>{NOTE_LOAD_FAILED_MESSAGE}</p>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void session.reloadNote()}
                >
                  重新加载纪要
                </button>
              </div>
            )}

            {state.noteState === 'ready' && !state.note && (
              <p className="note-message">暂无纪要内容</p>
            )}

            {state.note && (
              <p className="note-review-notice" role="note">
                纪要是根据转写整理的内容，可能不准确。请核对决策、行动项、负责人和截止日期是否与会议实际讨论一致。
              </p>
            )}

            {state.note && (
              <article className="note-content">
                <section className="note-summary" aria-labelledby="note-summary-heading">
                  <h4 id="note-summary-heading">摘要</h4>
                  <p>{state.note.note.summary.trim() || '未填写'}</p>
                </section>
                <section className="note-section" aria-labelledby="note-topics-heading">
                  <h4 id="note-topics-heading">关键主题</h4>
                  {state.note.note.keyTopics.length > 0 ? (
                    <ul className="note-topics" aria-label="关键主题">
                      {state.note.note.keyTopics.map((topic, index) => (
                        <li key={`${index}-${topic}`}>{topic.trim() || '未指定'}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="note-empty">未指定</p>
                  )}
                </section>

                <section className="note-section" aria-labelledby="note-decisions-heading">
                  <h4 id="note-decisions-heading">决策</h4>
                  {state.note.note.decisions.length > 0 ? (
                    <ol className="note-list" aria-label="决策">
                      {state.note.note.decisions.map((decision, index) => (
                        <li key={`${index}-${decision.timestampMs ?? 'no-time'}`}>
                          <span className="note-item-text">{decision.text.trim() || '未指定'}</span>
                          {decision.timestampMs !== undefined && (
                            <time className="note-time">
                              {formatTranscriptTime(decision.timestampMs)}
                            </time>
                          )}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="note-empty">未指定</p>
                  )}
                </section>

                <section className="note-section" aria-labelledby="note-questions-heading">
                  <h4 id="note-questions-heading">未决问题</h4>
                  {state.note.note.openQuestions.length > 0 ? (
                    <ol className="note-list" aria-label="未决问题">
                      {state.note.note.openQuestions.map((question, index) => (
                        <li key={`${index}-${question}`}>
                          <span className="note-item-text">{question.trim() || '未指定'}</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="note-empty">未指定</p>
                  )}
                </section>

                <section className="note-section" aria-labelledby="note-actions-heading">
                  <h4 id="note-actions-heading">行动项</h4>
                  {state.note.note.actionItems.length > 0 ? (
                    <ol className="note-list note-action-list" aria-label="行动项">
                      {state.note.note.actionItems.map((item, index) => (
                        <li
                          className="note-action"
                          key={`${index}-${item.timestampMs ?? 'no-time'}`}
                        >
                          <div className="note-action-main">
                            <span className="note-item-text">{item.task.trim() || '未指定'}</span>
                            {item.timestampMs !== undefined && (
                              <time className="note-time">
                                {formatTranscriptTime(item.timestampMs)}
                              </time>
                            )}
                          </div>
                          <dl className="note-action-meta">
                            <div>
                              <dt>负责人</dt>
                              <dd>{displayNoteValue(item.owner)}</dd>
                            </div>
                            <div>
                              <dt>截止时间</dt>
                              <dd>{displayNoteValue(item.dueDate)}</dd>
                            </div>
                          </dl>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="note-empty">未指定</p>
                  )}
                </section>
              </article>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
