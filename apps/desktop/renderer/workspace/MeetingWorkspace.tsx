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

function canShowGenerationAction(meeting: MeetingDetail): boolean {
  return (
    meeting.status === 'transcribed' ||
    meeting.status === 'generating' ||
    meeting.status === 'ready' ||
    (meeting.status === 'failed' && meeting.lastError?.kind === 'generating')
  );
}

function displayNoteValue(value: string): string {
  const normalized = value.trim();
  return normalized === '' || normalized.toLowerCase() === 'unspecified' ? '未指定' : normalized;
}

type KeywordMessage = {
  tone: 'status' | 'error';
  text: string;
};

interface KeywordEditorState {
  meetingId: string;
  values: string[];
  input: string;
  message: KeywordMessage | null;
}

function sameKeywords(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((keyword, index) => keyword === right[index]);
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
  const [keywordEditor, setKeywordEditor] = useState<KeywordEditorState | null>(null);
  const [generationPrompt, setGenerationPrompt] = useState<{
    meetingId: string;
    revision: number;
  } | null>(null);

  useEffect(() => session.connect(), [session]);

  const actions = availableActions(state);
  const recording = isRecording(state);
  const { meeting } = state;
  const activeKeywordEditor =
    meeting && keywordEditor?.meetingId === meeting.id ? keywordEditor : null;

  const savedKeywords = meeting?.keywords ?? [];
  const keywordDraft = activeKeywordEditor?.values ?? savedKeywords;
  const keywordInput = activeKeywordEditor?.input ?? '';
  const keywordMessage = activeKeywordEditor?.message ?? null;
  const keywordsDirty = !sameKeywords(keywordDraft, savedKeywords);
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
  const regenerate = state.note !== null;
  const generationActionLabel =
    state.pending === 'generate'
      ? regenerate
        ? '正在重新生成...'
        : '正在生成...'
      : regenerate
        ? '重新生成会议纪要'
        : '生成会议纪要';

  async function handleCreate(event: FormEvent): Promise<void> {
    event.preventDefault();

    // 新会议操作开始后，旧发送确认必须彻底失效，即使请求随后失败。
    setGenerationPrompt(null);
    if (await session.create(title)) setTitle('');
  }

  function updateKeywordEditor(
    patch: Partial<Pick<KeywordEditorState, 'values' | 'input' | 'message'>>,
  ): void {
    if (!meeting) return;

    // 关键词一旦变化，先前看到的发送内容确认立即失效。
    setGenerationPrompt(null);

    const current = activeKeywordEditor ?? {
      meetingId: meeting.id,
      values: [...meeting.keywords],
      input: '',
      message: null,
    };

    setKeywordEditor({ ...current, ...patch });
  }

  function handleAddKeyword(event: FormEvent): void {
    event.preventDefault();
    if (!meeting || !actions.keywords) return;

    const value = keywordInput.trim();

    if (!value) return;

    if (value.length > 100) {
      updateKeywordEditor({
        message: {
          tone: 'error',
          text: '单个关键词不能超过 100 个字符。',
        },
      });
      return;
    }

    if (keywordDraft.includes(value)) {
      updateKeywordEditor({
        message: {
          tone: 'error',
          text: `关键词“${value}”已经存在。`,
        },
      });
      return;
    }

    if (keywordDraft.length >= 50) {
      updateKeywordEditor({
        message: {
          tone: 'error',
          text: '最多保存 50 个关键词。',
        },
      });
      return;
    }

    updateKeywordEditor({
      values: [...keywordDraft, value],
      input: '',
      message: {
        tone: 'status',
        text: `已添加“${value}”，请保存。`,
      },
    });
  }

  function handleRemoveKeyword(keyword: string): void {
    updateKeywordEditor({
      values: keywordDraft.filter((item) => item !== keyword),
      message: {
        tone: 'status',
        text: `已移除“${keyword}”，请保存。`,
      },
    });
  }

  function handleKeywordInput(value: string): void {
    updateKeywordEditor({
      input: value,
      message: null,
    });
  }

  async function handleSaveKeywords(): Promise<void> {
    if (!meeting || !actions.keywords || !keywordsDirty) return;

    if (!(await session.saveKeywords(keywordDraft))) return;

    const latest = session.getState().meeting;
    if (latest?.id !== meeting.id) return;

    setKeywordEditor({
      meetingId: meeting.id,
      values: [...latest.keywords],
      input: '',
      message: {
        tone: 'status',
        text: `已保存 ${latest.keywords.length} 个关键词。`,
      },
    });
  }

  function openGenerationPrompt(): void {
    const current = state.meeting;
    if (!current || !actions.generate || keywordsDirty) return;

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
          <section className="meeting-keywords" aria-labelledby="keywords-heading">
            <div className="meeting-keywords-heading">
              <div>
                <h3 id="keywords-heading">会议关键词</h3>
                <p className="meeting-keywords-help">
                  关键词会引导纪要重点。只有点击“保存关键词”后，下一次生成或重新生成才会使用它们。
                </p>
              </div>
              <span className="keyword-count">{keywordDraft.length}/50</span>
            </div>

            {keywordDraft.length > 0 ? (
              <ul className="keyword-list" aria-label="关键词草稿">
                {keywordDraft.map((keyword) => (
                  <li className="keyword-chip" key={keyword}>
                    <span>{keyword}</span>
                    <button
                      type="button"
                      className="keyword-remove"
                      aria-label={`移除关键词 ${keyword}`}
                      onClick={() => handleRemoveKeyword(keyword)}
                      disabled={!actions.keywords}
                    >
                      移除
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="keyword-empty">暂无关键词</p>
            )}

            <form className="keyword-add" onSubmit={handleAddKeyword}>
              <label htmlFor="meeting-keyword">添加关键词</label>
              <div className="keyword-add-controls">
                <input
                  id="meeting-keyword"
                  value={keywordInput}
                  maxLength={100}
                  onChange={(event) => handleKeywordInput(event.target.value)}
                  disabled={!actions.keywords}
                  placeholder="例如：定价"
                />
                <button type="submit" disabled={!actions.keywords || !keywordInput.trim()}>
                  添加关键词
                </button>
              </div>
            </form>

            {keywordMessage && (
              <p
                className={`keyword-message keyword-message-${keywordMessage.tone}`}
                role={keywordMessage.tone === 'error' ? 'alert' : 'status'}
              >
                {keywordMessage.text}
              </p>
            )}

            <div className="keyword-save-row">
              <button
                type="button"
                onClick={() => void handleSaveKeywords()}
                disabled={!actions.keywords || !keywordsDirty}
              >
                {state.pending === 'keywords' ? '保存中...' : '保存关键词'}
              </button>
              <p className="saved-keywords">
                已保存：
                {savedKeywords.length > 0 ? savedKeywords.join('、') : '暂无关键词'}
              </p>
            </div>
          </section>
          <section className="note-generation" aria-labelledby="generation-heading">
            <div className="note-generation-heading">
              <div>
                <h3 id="generation-heading">AI 会议纪要</h3>
                <p className="note-generation-help">
                  根据已保存的转写{regenerate ? '重新生成' : '生成'}会议纪要， 发送前会再次确认。
                  {regenerate && ' 当前纪要会保留，重新生成成功后新增版本。'}
                </p>
              </div>
              {canShowGenerationAction(meeting) && (
                <button
                  type="button"
                  onClick={openGenerationPrompt}
                  disabled={!actions.generate || keywordsDirty}
                >
                  {generationActionLabel}
                </button>
              )}
            </div>

            {keywordsDirty && canShowGenerationAction(meeting) && (
              <p className="generation-blocked" role="status">
                关键词有未保存更改。请先保存关键词，或先恢复为已保存内容，再生成会议纪要。
              </p>
            )}

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
                <strong id="generation-consent-title">
                  {regenerate ? '重新生成会议内容并发送给 DeepSeek？' : '发送会议内容给 DeepSeek？'}
                </strong>
                <p id="generation-consent-description">
                  将向 DeepSeek
                  发送本次会议已保存的转写文本，以及生成纪要所需的必要上下文，例如会议标题和关键词。原始音频不会发送。
                  {regenerate &&
                    state.note &&
                    ` 当前纪要版本 ${state.note.version} 会保留；重新生成成功后新增版本，失败时不会删除现有纪要。`}
                </p>
                <div className="meeting-actions">
                  <button type="button" onClick={() => void confirmGeneration()}>
                    {regenerate ? '确认发送并重新生成' : '确认发送并生成'}
                  </button>
                  <button type="button" className="secondary" onClick={closeGenerationPrompt}>
                    取消
                  </button>
                </div>
              </div>
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
