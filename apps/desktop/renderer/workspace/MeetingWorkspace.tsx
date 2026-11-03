// 会议文档画布：一份纪要文档 + 右侧可开关的转写抽屉。
// 业务状态只来自 Main 的快照；provider 名称取自设置，不写死任何服务商。
import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import type { MeetingDetail } from '@shared/contracts';
import { AudioDeviceSelector } from '../components/AudioDeviceSelector';
import { Dialog } from '../ui/Dialog';
import { describeError } from '../ui/errors';
import { Icon } from '../ui/icons';
import {
  STATUS_DOT,
  STATUS_LABELS,
  formatDateTime,
  formatDuration,
  segmentIndexAt,
  transcriptLength,
} from '../ui/timecode';
import { EmptyStage } from './EmptyStage';
import { KeywordEditor, type KeywordDraft } from './KeywordEditor';
import {
  NOTE_LOAD_FAILED_MESSAGE,
  availableActions,
  canEditMeetingNote,
  meetingActions,
  isRecording,
  type MeetingSession,
  type SessionState,
} from './meeting-session';
import { NoteEditor } from './NoteEditor';
import { NoteView } from './NoteView';
import { ProcessingProgress } from './ProcessingProgress';
import { RecordingControls } from './RecordingControls';
import { TranscriptLog, type Cue } from './TranscriptLog';

function canShowGenerationAction(meeting: MeetingDetail): boolean {
  return (
    meeting.status === 'transcribed' ||
    meeting.status === 'generating' ||
    meeting.status === 'ready' ||
    (meeting.status === 'failed' && meeting.lastError?.kind === 'generating')
  );
}

function sameKeywords(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((keyword, index) => keyword === right[index]);
}

function statusText(state: SessionState): string {
  const meeting = state.meeting!;
  if (meeting.status === 'recording' && state.captureStopped) return '录音已结束，等待保存';
  if (state.cancelledKind === 'transcribing' && meeting.status === 'captured')
    return '转写已取消，录音已保存';
  const label = STATUS_LABELS[meeting.status];
  return meeting.status === 'failed' && meeting.lastError
    ? `${label}：${describeError(meeting.lastError)}`
    : label;
}

interface WorkspaceProps {
  session: MeetingSession;
  state: SessionState;
  elapsedMs: number | null;
  /** 当前纪要 provider 的展示名和模型，来自 settings.noteProvider / noteModel */
  provider: { label: string; model: string };
  drawerOpen: boolean;
  onDrawer(open: boolean): void;
}

interface KeywordState extends KeywordDraft {
  meetingId: string;
}

export function MeetingWorkspace({
  session,
  state,
  elapsedMs,
  provider,
  drawerOpen,
  onDrawer,
}: WorkspaceProps): ReactElement {
  const { meeting } = state;
  const actions = availableActions(state);
  const manage = meetingActions(state);
  const editable = canEditMeetingNote(state);
  const note = state.note;
  const length = transcriptLength(state.transcriptSegments);

  const [cue, setCue] = useState<(Cue & { meetingId: string }) | null>(null);
  const [linkedMs, setLinkedMs] = useState<number | null>(null);
  // 成功确认只停留几秒；以操作序号标记已关闭的那一条，下一次操作产生的新确认会重新出现
  const [dismissedNotice, setDismissedNotice] = useState(-1);
  const noticeVisible = !!state.notice && dismissedNotice !== state.attempt;
  useEffect(() => {
    if (!noticeVisible) return;
    const attempt = state.attempt;
    const timer = window.setTimeout(() => setDismissedNotice(attempt), 3200);
    return () => window.clearTimeout(timer);
  }, [noticeVisible, state.attempt]);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState<{ base: SessionState['note'] } | null>(null);
  const [prompt, setPrompt] = useState<{ revision: number; attempt: number } | null>(null);
  const [keywordState, setKeywordState] = useState<KeywordState | null>(null);

  const activeKeywords = meeting && keywordState?.meetingId === meeting.id ? keywordState : null;
  const savedKeywords = meeting?.keywords ?? [];
  const keywordDraft: KeywordDraft = activeKeywords ?? {
    values: savedKeywords,
    input: '',
    message: null,
  };
  const keywordsDirty = !sameKeywords(keywordDraft.values, savedKeywords);
  const regenerate = note !== null;

  // 确认绑定打开时的会议快照和操作序号；会议更新、关键词变化或其他操作开始后自动失效
  const promptOpen =
    !!prompt &&
    prompt.revision === state.revision &&
    prompt.attempt === state.attempt &&
    actions.generate &&
    !keywordsDirty;
  const editorOpen = editing !== null && editable;

  function updateKeywords(patch: Partial<KeywordDraft>): void {
    if (!meeting) return;
    // 关键词一旦变化，先前看到的发送确认立即失效
    setPrompt(null);
    setKeywordState({ meetingId: meeting.id, ...keywordDraft, ...patch });
  }

  function addKeyword(): void {
    if (!meeting || !actions.keywords) return;
    const value = keywordDraft.input.trim();
    if (!value) return;
    if (value.length > 100)
      return updateKeywords({
        message: { tone: 'error', text: '单个关键词不能超过 100 个字符。' },
      });
    if (keywordDraft.values.includes(value))
      return updateKeywords({ message: { tone: 'error', text: `关键词“${value}”已经存在。` } });
    if (keywordDraft.values.length >= 50)
      return updateKeywords({ message: { tone: 'error', text: '最多保存 50 个关键词。' } });
    updateKeywords({
      values: [...keywordDraft.values, value],
      input: '',
      message: { tone: 'status', text: `已添加“${value}”，请保存。` },
    });
  }

  async function saveKeywords(): Promise<void> {
    if (!meeting || !actions.keywords || !keywordsDirty) return;
    if (!(await session.saveKeywords(keywordDraft.values))) return;
    const latest = session.getState().meeting;
    if (latest?.id !== meeting.id) return;
    setKeywordState({
      meetingId: meeting.id,
      values: [...latest.keywords],
      input: '',
      message: { tone: 'status', text: `已保存 ${latest.keywords.length} 个关键词。` },
    });
  }

  async function confirmGeneration(): Promise<void> {
    if (!promptOpen) return;
    // 先关闭确认框；会话层仍会拒绝重复请求
    setPrompt(null);
    await session.generate();
  }

  function jumpTo(timestampMs: number): void {
    if (!meeting) return;
    const index = segmentIndexAt(state.transcriptSegments, timestampMs);
    if (index === -1) return;
    onDrawer(true);
    setCue((previous) => ({ meetingId: meeting.id, index, nonce: (previous?.nonce ?? 0) + 1 }));
  }

  async function submitRename(event: FormEvent): Promise<void> {
    event.preventDefault();
    const next = draftTitle.trim();
    if (!next || next === meeting?.title) return setRenaming(false);
    if (await session.rename(next)) setRenaming(false);
  }

  async function confirmDeletion(): Promise<void> {
    setConfirmDelete(false);
    await session.delete();
  }

  const gone = meeting?.status === 'deleted';
  // 输入设备只在录音前和录音中有意义；其余阶段收起，始终只有一个实例
  const showInput =
    !meeting ||
    meeting.status === 'created' ||
    meeting.status === 'recording' ||
    (meeting.status === 'failed' && meeting.lastError?.kind === 'recording');
  // 没有会议时不露出设备选择，空状态只有一句话
  const inputVisible = !!meeting && showInput && !isRecording(state);
  const savePending = meeting?.status === 'recording' && state.captureStopped;
  const dot = savePending ? 'busy' : meeting ? STATUS_DOT[meeting.status] : 'idle';
  const generationLabel =
    state.pending === 'generate'
      ? regenerate
        ? '正在重新生成...'
        : '正在生成...'
      : regenerate
        ? '重新生成会议纪要'
        : '生成会议纪要';

  return (
    <section
      className="workspace"
      aria-label="录音工作区"
      data-drawer={drawerOpen && meeting && !gone ? 'open' : 'closed'}
      data-empty={meeting ? undefined : 'true'}
    >
      <div className="canvas">
        <div className="bulletins">
          {state.error && (
            <div className="workspace-error bulletin bulletin-warn" role="alert">
              <strong>操作失败</strong>
              <p>{state.error}</p>
            </div>
          )}
          {state.warning && (
            <p className="workspace-warning bulletin bulletin-warn" role="status">
              {state.warning}
            </p>
          )}
        </div>
        {noticeVisible && (
          <p className="workspace-notice toast" role="status">
            <Icon name="check" />
            {state.notice}
          </p>
        )}

        {!meeting && <EmptyStage />}

        {meeting && (
          <article className="doc" key={meeting.id}>
            <header className="doc-head">
              {renaming ? (
                <form className="rename" onSubmit={(e) => void submitRename(e)}>
                  <label className="visually-hidden" htmlFor="rename-title">
                    会议标题
                  </label>
                  <input
                    id="rename-title"
                    className="field field-title"
                    value={draftTitle}
                    maxLength={200}
                    autoFocus
                    onChange={(e) => setDraftTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        setRenaming(false);
                      }
                    }}
                  />
                  <button
                    type="submit"
                    className="key key-primary"
                    disabled={!manage.rename || !draftTitle.trim()}
                  >
                    {state.pending === 'rename' ? '保存中...' : '保存标题'}
                  </button>
                  <button
                    type="button"
                    className="key key-quiet"
                    onClick={() => setRenaming(false)}
                  >
                    放弃修改
                  </button>
                </form>
              ) : (
                <div className="doc-title">
                  <h2
                    title={gone || !manage.rename ? undefined : '双击重命名'}
                    onDoubleClick={() => {
                      if (gone || !manage.rename) return;
                      setDraftTitle(meeting.title);
                      setRenaming(true);
                    }}
                  >
                    {meeting.title}
                  </h2>
                  {!gone && (
                    <button
                      type="button"
                      className="key key-icon key-quiet"
                      title="重命名会议"
                      disabled={!manage.rename}
                      onClick={() => {
                        setDraftTitle(meeting.title);
                        setRenaming(true);
                      }}
                    >
                      <Icon name="edit" />
                      <span className="visually-hidden">重命名会议</span>
                    </button>
                  )}
                </div>
              )}

              <div className="doc-line">
                {!gone && (
                  <p className="doc-meta">
                    <time dateTime={meeting.createdAt}>{formatDateTime(meeting.createdAt)}</time>
                    {length !== null && <span>{formatDuration(length)}</span>}
                  </p>
                )}
                {meeting.status !== 'ready' && (
                  <span className={`dot dot-${dot}`} aria-hidden="true" />
                )}
                <p
                  className={`meeting-status${meeting.status === 'ready' ? ' visually-hidden' : ''}`}
                  role="status"
                  aria-live="polite"
                >
                  {statusText(state)}
                </p>
              </div>
            </header>

            {gone ? (
              <div className="doc-gone">
                <p>这场会议已被删除，本机记录和保留的音频都已清除。</p>
                <button type="button" className="key" onClick={() => session.close()}>
                  关闭
                </button>
              </div>
            ) : (
              <>
                {meeting.status === 'generating' && <ProcessingProgress state={state} />}

                {canShowGenerationAction(meeting) && !regenerate && (
                  <div className="generate">
                    <KeywordEditor
                      draft={keywordDraft}
                      saved={savedKeywords}
                      disabled={!actions.keywords}
                      saving={state.pending === 'keywords'}
                      dirty={keywordsDirty}
                      onInput={(input) => updateKeywords({ input, message: null })}
                      onAdd={addKeyword}
                      onRemove={(keyword) =>
                        updateKeywords({
                          values: keywordDraft.values.filter((item) => item !== keyword),
                          message: { tone: 'status', text: `已移除“${keyword}”，请保存。` },
                        })
                      }
                      onSave={() => void saveKeywords()}
                    />
                    <button
                      type="button"
                      className="key key-primary"
                      onClick={() =>
                        setPrompt({ revision: state.revision, attempt: state.attempt })
                      }
                      disabled={!actions.generate || keywordsDirty}
                    >
                      <Icon name="send" />
                      {generationLabel}
                    </button>
                    {keywordsDirty && (
                      <p className="generation-blocked" role="status">
                        关键词有未保存更改。请先保存关键词，或先恢复为已保存内容，再生成会议纪要。
                      </p>
                    )}
                  </div>
                )}

                {state.noteState === 'loading' && !note && (
                  <>
                    <div className="skeleton" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </div>
                    <p className="note-message visually-hidden" role="status">
                      正在加载纪要...
                    </p>
                  </>
                )}

                {state.noteState === 'error' && (
                  <div className="note-error callout" role="alert">
                    <p>{NOTE_LOAD_FAILED_MESSAGE}</p>
                    <button type="button" className="key" onClick={() => void session.reloadNote()}>
                      <Icon name="refresh" />
                      重新加载纪要
                    </button>
                  </div>
                )}

                {state.noteState === 'ready' && !note && !editorOpen && (
                  <div className={`note-blank${editable ? '' : ' visually-hidden'}`}>
                    <p className="note-message">暂无纪要内容</p>
                    {editable && (
                      <button
                        type="button"
                        className="key key-quiet"
                        onClick={() => setEditing({ base: null })}
                      >
                        <Icon name="edit" />
                        手动撰写纪要
                      </button>
                    )}
                  </div>
                )}

                {note && (
                  <div className="note-bar">
                    <div className="note-meta">
                      <span className={`note-source note-source-${note.source}`}>
                        {note.source === 'generated' ? 'AI 生成' : '用户编辑'}
                      </span>
                      <span className="numeric">版本 {note.version}</span>
                    </div>
                    <div className="note-actions">
                      {editable && !editorOpen && (
                        <button
                          type="button"
                          className="key key-quiet"
                          onClick={() => setEditing({ base: note })}
                          disabled={state.pending !== null}
                        >
                          <Icon name="edit" />
                          <span>编辑纪要</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="key key-quiet"
                        onClick={() => void session.exportMarkdown()}
                        disabled={!manage.export || editorOpen}
                        title={editorOpen ? '保存或取消编辑后再导出' : '导出当前显示的纪要版本'}
                      >
                        <Icon name="export" />
                        <span>{state.pending === 'export' ? '正在导出...' : '导出 Markdown'}</span>
                      </button>
                      {canShowGenerationAction(meeting) && (
                        <button
                          type="button"
                          className="key key-quiet"
                          onClick={() =>
                            setPrompt({ revision: state.revision, attempt: state.attempt })
                          }
                          disabled={!actions.generate || keywordsDirty}
                          title="用当前转写与关注词新增一个纪要版本"
                        >
                          <Icon name="send" />
                          <span>{generationLabel}</span>
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {note && canShowGenerationAction(meeting) && (
                  <div className="generate generate-quiet">
                    <KeywordEditor
                      draft={keywordDraft}
                      saved={savedKeywords}
                      disabled={!actions.keywords}
                      saving={state.pending === 'keywords'}
                      dirty={keywordsDirty}
                      onInput={(input) => updateKeywords({ input, message: null })}
                      onAdd={addKeyword}
                      onRemove={(keyword) =>
                        updateKeywords({
                          values: keywordDraft.values.filter((item) => item !== keyword),
                          message: { tone: 'status', text: `已移除“${keyword}”，请保存。` },
                        })
                      }
                      onSave={() => void saveKeywords()}
                    />
                    {keywordsDirty && (
                      <p className="generation-blocked" role="status">
                        关键词有未保存更改。请先保存关键词，或先恢复为已保存内容，再生成会议纪要。
                      </p>
                    )}
                  </div>
                )}

                {editorOpen ? (
                  <NoteEditor
                    key={editing.base?.version ?? 'new'}
                    session={session}
                    base={editing.base}
                    latest={note}
                    onDone={() => setEditing(null)}
                  />
                ) : (
                  note && (
                    <>
                      <NoteView
                        note={note.note}
                        segments={state.transcriptSegments}
                        onCue={jumpTo}
                        linkedMs={linkedMs}
                      />
                      <p className="note-review-notice" role="note">
                        纪要是根据转写整理的内容，可能不准确。请核对决策、行动项、负责人和截止日期是否与会议实际讨论一致。
                      </p>
                    </>
                  )
                )}

                <footer className="doc-foot">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={meeting.retainAudio}
                      disabled={!manage.retainAudio}
                      onChange={(e) => void session.setRetainAudio(e.target.checked)}
                    />
                    <span className="switch-track" aria-hidden="true" />
                    <span>转写后保留音频</span>
                  </label>
                  <button
                    type="button"
                    className="key key-icon key-quiet key-danger"
                    title={meeting.status === 'recording' ? '停止录音后才能删除' : '删除会议'}
                    disabled={!manage.delete}
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Icon name="trash" />
                    <span className="visually-hidden">删除会议</span>
                  </button>
                </footer>
              </>
            )}

            {promptOpen && (
              <Dialog
                className="generation-consent"
                titleId="generation-consent-title"
                descriptionId="generation-consent-description"
                title={
                  regenerate
                    ? `重新生成会议内容并发送给 ${provider.label}？`
                    : `发送会议内容给 ${provider.label}？`
                }
                tone="consent"
                closeLabel="关闭发送确认"
                onClose={() => setPrompt(null)}
                actions={
                  <>
                    <button
                      type="button"
                      className="key key-primary"
                      data-autofocus
                      data-primary
                      onClick={() => void confirmGeneration()}
                    >
                      {regenerate ? '确认发送并重新生成' : '确认发送并生成'}
                    </button>
                    <button type="button" className="key" onClick={() => setPrompt(null)}>
                      取消
                    </button>
                  </>
                }
              >
                <ul className="consent-summary" aria-label="发送摘要">
                  <li>
                    {provider.label}
                    {provider.model ? ` · ${provider.model}` : ''}
                  </li>
                  <li>{state.transcriptSegments.length} 个转写片段</li>
                  {savedKeywords.length > 0 && <li>{savedKeywords.length} 个关键词</li>}
                  <li className="consent-local">不含音频</li>
                </ul>
                <p>
                  {`将向 ${provider.label}${provider.model ? `（${provider.model}）` : ''}发送本次会议已保存的转写文本，以及生成纪要所需的必要上下文，例如会议标题和关键词。原始音频不会发送。`}
                </p>
                {regenerate && note && (
                  <p>{`当前纪要版本 ${note.version} 会保留；重新生成成功后新增版本，失败时不会删除现有纪要。`}</p>
                )}
              </Dialog>
            )}

            {confirmDelete && manage.delete && (
              <Dialog
                titleId="delete-title"
                descriptionId="delete-description"
                title="删除这场会议？"
                tone="caution"
                onClose={() => setConfirmDelete(false)}
                actions={
                  <>
                    <button
                      type="button"
                      className="key key-caution"
                      onClick={() => void confirmDeletion()}
                    >
                      删除会议记录
                    </button>
                    <button
                      type="button"
                      className="key"
                      data-autofocus
                      onClick={() => setConfirmDelete(false)}
                    >
                      取消
                    </button>
                  </>
                }
              >
                <p>「{meeting.title}」的转写、纪要和本机保留的音频将被删除，且无法恢复。</p>
                <p>已发送给 {provider.label} 的转写文本不会因为本机删除而被删除。</p>
              </Dialog>
            )}
          </article>
        )}

        <div className="input-module" hidden={!inputVisible}>
          <AudioDeviceSelector locked={isRecording(state)} />
        </div>

        {meeting && !gone && (
          <RecordingControls session={session} state={state} elapsedMs={elapsedMs} />
        )}
      </div>

      {meeting && !gone && (
        <aside id="transcript-drawer" className="drawer" aria-label="转写" inert={!drawerOpen}>
          <TranscriptLog
            session={session}
            state={state}
            cue={cue?.meetingId === meeting.id ? cue : null}
            onClose={() => onDrawer(false)}
            onHover={setLinkedMs}
          />
        </aside>
      )}
    </section>
  );
}
