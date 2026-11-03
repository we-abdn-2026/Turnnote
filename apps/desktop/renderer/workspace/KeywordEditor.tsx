// 关注词：#87 的语义——草稿必须“保存关键词”之后，下一次生成才会使用；未保存时阻止生成。
// 草稿状态由父组件持有（生成确认要随草稿变化失效），本组件只负责展示和输入。
import type { FormEvent, ReactElement } from 'react';
import { Icon } from '../ui/icons';

export interface KeywordDraft {
  values: string[];
  input: string;
  message: { tone: 'status' | 'error'; text: string } | null;
}

export function KeywordEditor({
  draft,
  saved,
  disabled,
  saving,
  dirty,
  onInput,
  onAdd,
  onRemove,
  onSave,
}: {
  draft: KeywordDraft;
  saved: string[];
  disabled: boolean;
  saving: boolean;
  dirty: boolean;
  onInput(value: string): void;
  onAdd(): void;
  onRemove(keyword: string): void;
  onSave(): void;
}): ReactElement {
  function submit(event: FormEvent): void {
    event.preventDefault();
    onAdd();
  }

  return (
    <section className="keywords" aria-labelledby="keywords-heading">
      <h3 id="keywords-heading" className="visually-hidden">
        会议关键词
      </h3>
      <ul className="keyword-list" aria-label="关键词草稿">
        {draft.values.map((keyword) => (
          <li className="chip keyword-chip" key={keyword}>
            <span>{keyword}</span>
            <button
              type="button"
              className="chip-remove"
              aria-label={`移除关键词 ${keyword}`}
              disabled={disabled}
              onClick={() => onRemove(keyword)}
            >
              <Icon name="close" size={12} />
            </button>
          </li>
        ))}
        <li className="keyword-add">
          <form onSubmit={submit}>
            <label className="keyword-add-label" htmlFor="meeting-keyword">
              <Icon name="plus" size={12} />
              <span className="visually-hidden">添加关键词</span>
            </label>
            <input
              id="meeting-keyword"
              className="field field-bare"
              value={draft.input}
              maxLength={100}
              disabled={disabled}
              placeholder="关键词"
              onChange={(event) => onInput(event.target.value)}
            />
            <button
              type="submit"
              className="visually-hidden"
              disabled={disabled || !draft.input.trim()}
            >
              添加关键词
            </button>
          </form>
        </li>
        {dirty && (
          <li>
            <button
              type="button"
              className="key key-primary keyword-save"
              disabled={disabled || saving}
              onClick={onSave}
            >
              {saving ? '保存中...' : '保存关键词'}
            </button>
          </li>
        )}
      </ul>
      {draft.message && (
        <p
          className={`keyword-message keyword-message-${draft.message.tone}`}
          role={draft.message.tone === 'error' ? 'alert' : 'status'}
        >
          {draft.message.text}
        </p>
      )}
      <p className="saved-keywords visually-hidden">
        已保存：{saved.length > 0 ? saved.join('、') : '暂无关键词'}
      </p>
    </section>
  );
}
