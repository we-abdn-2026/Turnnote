// 纪要编辑：草稿只在本组件内，保存以开始编辑时的版本号做乐观锁；冲突或失败时草稿保留。
import { useState, type KeyboardEvent, type ReactElement } from 'react';
import type { MeetingNote, NoteVersion } from '@shared/contracts';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/icons';
import { formatTimecode } from '../ui/timecode';
import type { MeetingSession } from './meeting-session';

const UNSPECIFIED = 'unspecified';

interface Draft {
  summary: string;
  keyTopics: string[];
  decisions: { text: string; timestampMs?: number }[];
  openQuestions: string[];
  actionItems: { task: string; owner: string; dueDate: string; timestampMs?: number }[];
}

function toDraft(note: MeetingNote): Draft {
  const blank = (value: string): string =>
    value.trim().toLowerCase() === UNSPECIFIED ? '' : value;
  return {
    summary: note.summary,
    keyTopics: [...note.keyTopics],
    decisions: note.decisions.map((item) => ({ ...item })),
    openQuestions: [...note.openQuestions],
    actionItems: note.actionItems.map((item) => ({
      ...item,
      owner: blank(item.owner),
      dueDate: blank(item.dueDate),
    })),
  };
}

/** 去掉空条目；负责人和截止日期留空即表示未指定 */
function toNote(draft: Draft): MeetingNote {
  const withTime = <T extends object>(item: T, timestampMs?: number): T =>
    timestampMs === undefined ? item : { ...item, timestampMs };
  return {
    summary: draft.summary.trim(),
    keyTopics: draft.keyTopics.map((topic) => topic.trim()).filter(Boolean),
    decisions: draft.decisions
      .filter((item) => item.text.trim())
      .map((item) => withTime({ text: item.text.trim() }, item.timestampMs)),
    openQuestions: draft.openQuestions.map((question) => question.trim()).filter(Boolean),
    actionItems: draft.actionItems
      .filter((item) => item.task.trim())
      .map((item) =>
        withTime(
          {
            task: item.task.trim(),
            owner: item.owner.trim() || UNSPECIFIED,
            dueDate: item.dueDate.trim() || UNSPECIFIED,
          },
          item.timestampMs,
        ),
      ),
  };
}

const EMPTY_NOTE: MeetingNote = {
  summary: '',
  keyTopics: [],
  decisions: [],
  openQuestions: [],
  actionItems: [],
};

interface NoteEditorProps {
  session: MeetingSession;
  /** 编辑开始时的版本；null 表示手动撰写第一版 */
  base: NoteVersion | null;
  /** 当前已加载的最新版本，用于提示编辑期间别处产生的新版本 */
  latest: NoteVersion | null;
  onDone(): void;
}

export function NoteEditor({ session, base, latest, onDone }: NoteEditorProps): ReactElement {
  const [original] = useState(() => toNote(toDraft(base?.note ?? EMPTY_NOTE)));
  const [draft, setDraft] = useState<Draft>(() => toDraft(base?.note ?? EMPTY_NOTE));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ message: string; conflict: boolean } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const expected = base?.version ?? 0;
  const newer = latest !== null && latest.version > expected;

  const patch = (next: Partial<Draft>): void => setDraft((current) => ({ ...current, ...next }));
  const dirty = JSON.stringify(toNote(draft)) !== JSON.stringify(original);

  async function save(): Promise<void> {
    if (saving) return;
    setSaving(true);
    setFailure(null);
    const outcome = await session.saveNote(toNote(draft), expected);
    setSaving(false);
    if (outcome.ok) onDone();
    else setFailure({ message: outcome.message, conflict: outcome.conflict });
  }

  function cancel(): void {
    if (dirty) setConfirmDiscard(true);
    else onDone();
  }

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key !== 'Escape' || confirmDiscard) return;
    event.preventDefault();
    cancel();
  }

  return (
    <form
      className="note-editor"
      aria-label="编辑纪要"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={onKeyDown}
    >
      {newer && !failure && (
        <p className="editor-banner" role="status">
          编辑期间产生了新的纪要版本（版本 {latest.version}
          ）。保存时会提示冲突，你的草稿不会被覆盖。
        </p>
      )}
      {failure && (
        <div className="editor-banner editor-banner-fault" role="alert">
          <p>{failure.message}</p>
          {failure.conflict && (
            <p>你的草稿仍在下方。可以复制需要保留的内容后放弃修改，再基于最新版本编辑。</p>
          )}
        </div>
      )}

      <section className="editor-section">
        <label className="editor-label" htmlFor="edit-summary">
          摘要
        </label>
        <textarea
          id="edit-summary"
          className="field field-area"
          rows={5}
          value={draft.summary}
          onChange={(e) => patch({ summary: e.target.value })}
        />
      </section>

      <EditableList
        title="关键主题"
        noun="主题"
        items={draft.keyTopics.map((text) => ({ text }))}
        onEdit={(index, text) =>
          patch({ keyTopics: draft.keyTopics.map((item, i) => (i === index ? text : item)) })
        }
        onRemove={(index) => patch({ keyTopics: draft.keyTopics.filter((_, i) => i !== index) })}
        onAdd={() => patch({ keyTopics: [...draft.keyTopics, ''] })}
      />

      <EditableList
        title="决策"
        noun="决策"
        showTime
        items={draft.decisions}
        onEdit={(index, text) =>
          patch({
            decisions: draft.decisions.map((item, i) => (i === index ? { ...item, text } : item)),
          })
        }
        onRemove={(index) => patch({ decisions: draft.decisions.filter((_, i) => i !== index) })}
        onAdd={() => patch({ decisions: [...draft.decisions, { text: '' }] })}
      />

      <EditableList
        title="未决问题"
        noun="问题"
        items={draft.openQuestions.map((text) => ({ text }))}
        onEdit={(index, text) =>
          patch({
            openQuestions: draft.openQuestions.map((item, i) => (i === index ? text : item)),
          })
        }
        onRemove={(index) =>
          patch({ openQuestions: draft.openQuestions.filter((_, i) => i !== index) })
        }
        onAdd={() => patch({ openQuestions: [...draft.openQuestions, ''] })}
      />

      <section className="editor-section">
        <p className="editor-label" id="edit-actions-label">
          行动项
        </p>
        <ol className="editor-actions" aria-labelledby="edit-actions-label">
          {draft.actionItems.map((item, index) => {
            const update = (next: Partial<Draft['actionItems'][number]>): void =>
              patch({
                actionItems: draft.actionItems.map((current, i) =>
                  i === index ? { ...current, ...next } : current,
                ),
              });
            return (
              <li key={index} className="editor-action">
                <input
                  className="field"
                  aria-label={`第 ${index + 1} 条行动项`}
                  value={item.task}
                  onChange={(e) => update({ task: e.target.value })}
                />
                <input
                  className="field"
                  aria-label={`第 ${index + 1} 条行动项的负责人`}
                  placeholder="负责人（留空为未指定）"
                  value={item.owner}
                  maxLength={200}
                  onChange={(e) => update({ owner: e.target.value })}
                />
                <input
                  className="field"
                  aria-label={`第 ${index + 1} 条行动项的截止时间`}
                  placeholder="截止时间（留空为未指定）"
                  value={item.dueDate}
                  maxLength={200}
                  onChange={(e) => update({ dueDate: e.target.value })}
                />
                <span className="editor-time numeric">
                  {item.timestampMs !== undefined ? formatTimecode(item.timestampMs) : '无来源'}
                </span>
                <button
                  type="button"
                  className="key key-icon key-ghost"
                  aria-label={`删除第 ${index + 1} 条行动项`}
                  onClick={() =>
                    patch({ actionItems: draft.actionItems.filter((_, i) => i !== index) })
                  }
                >
                  <Icon name="trash" />
                </button>
              </li>
            );
          })}
        </ol>
        <button
          type="button"
          className="key key-quiet"
          onClick={() =>
            patch({ actionItems: [...draft.actionItems, { task: '', owner: '', dueDate: '' }] })
          }
        >
          <Icon name="plus" />
          添加行动项
        </button>
      </section>

      <div className="editor-bar">
        <button type="submit" className="key key-primary" disabled={saving || !dirty}>
          {saving ? '正在保存...' : '保存纪要'}
        </button>
        <button type="button" className="key" onClick={cancel} disabled={saving}>
          取消编辑
        </button>
        <span className="hint">保存后生成新的版本，原版本保留。</span>
      </div>

      {confirmDiscard && (
        <Dialog
          titleId="discard-edit-title"
          descriptionId="discard-edit-description"
          title="放弃未保存的修改？"
          tone="caution"
          onClose={() => setConfirmDiscard(false)}
          actions={
            <>
              <button type="button" className="key key-caution-lit" onClick={onDone}>
                放弃修改
              </button>
              <button
                type="button"
                className="key"
                data-autofocus
                onClick={() => setConfirmDiscard(false)}
              >
                继续编辑
              </button>
            </>
          }
        >
          <p>这次编辑的内容还没有保存，放弃后无法找回。</p>
        </Dialog>
      )}
    </form>
  );
}

function EditableList({
  title,
  noun,
  items,
  showTime = false,
  onEdit,
  onRemove,
  onAdd,
}: {
  title: string;
  noun: string;
  items: { text: string; timestampMs?: number }[];
  /** 决策保留模型核对过的来源时间；编辑文字不改变来源 */
  showTime?: boolean;
  onEdit(index: number, text: string): void;
  onRemove(index: number): void;
  onAdd(): void;
}): ReactElement {
  const id = `edit-${noun}`;
  return (
    <section className="editor-section">
      <p className="editor-label" id={id}>
        {title}
      </p>
      <ol className="editor-list" aria-labelledby={id}>
        {items.map((item, index) => (
          <li key={index} className="editor-row">
            <input
              className="field"
              aria-label={`第 ${index + 1} 条${noun}`}
              value={item.text}
              onChange={(e) => onEdit(index, e.target.value)}
            />
            {showTime && (
              <span className="editor-time numeric">
                {item.timestampMs !== undefined ? formatTimecode(item.timestampMs) : '无来源'}
              </span>
            )}
            <button
              type="button"
              className="key key-icon key-ghost"
              aria-label={`删除第 ${index + 1} 条${noun}`}
              onClick={() => onRemove(index)}
            >
              <Icon name="trash" />
            </button>
          </li>
        ))}
      </ol>
      <button type="button" className="key key-quiet" onClick={onAdd}>
        <Icon name="plus" />
        添加{noun}
      </button>
    </section>
  );
}
