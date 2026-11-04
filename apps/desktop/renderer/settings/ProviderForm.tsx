// 添加或编辑自定义 AI 服务商（OpenAI 兼容端点）。网址按 Main 同一份规则即时校验，
// 并直接显示"数据会发往哪里"。保存由 Main 再次校验，界面校验只是更早给出提示。
import { useState, type FormEvent, type ReactElement } from 'react';
import type { AiProviderInfo, Result } from '@shared/contracts';
import { REQUEST_FAILED_MESSAGE, describeError } from '../ui/errors';
import { checkCustomDraft, type CustomDraft } from './provider-view';

export function ProviderForm({
  editing,
  existing,
  onCancel,
  onSaved,
}: {
  editing: AiProviderInfo | null;
  existing: readonly AiProviderInfo[];
  onCancel(): void;
  onSaved(saved: AiProviderInfo): void | Promise<void>;
}): ReactElement {
  const [draft, setDraft] = useState<CustomDraft>({
    label: editing?.label ?? '',
    baseUrl: editing?.baseUrl ?? '',
    needsKey: editing?.needsKey ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = checkCustomDraft(draft, existing, editing?.id ?? null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!check.valid || busy) return;
    setBusy(true);
    setError(null);
    const result: Result<AiProviderInfo> | null = await window.turnnote.providers
      .saveCustom({
        ...(editing ? { id: editing.id } : {}),
        label: draft.label.trim(),
        baseUrl: draft.baseUrl.trim(),
        needsKey: draft.needsKey,
      })
      .catch(() => null);
    setBusy(false);
    if (result?.ok) await onSaved(result.value);
    else setError(result && !result.ok ? describeError(result.error) : REQUEST_FAILED_MESSAGE);
  }

  return (
    <form className="provider-form" onSubmit={(e) => void submit(e)} aria-label="自定义 AI 服务">
      <strong>{editing ? `编辑 ${editing.label}` : '添加自己的服务'}</strong>
      <p className="hint">
        适用于 Ollama、LM Studio，或任何兼容 OpenAI 接口（/chat/completions）的网关。
      </p>

      <div className="settings-row">
        <label htmlFor="provider-label">名称</label>
        <div className="provider-field">
          <input
            id="provider-label"
            className="field"
            value={draft.label}
            maxLength={40}
            autoComplete="off"
            placeholder="例如：公司网关"
            aria-invalid={check.labelProblem ? true : undefined}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
          {check.labelProblem && (
            <p className="field-problem" role="alert">
              {check.labelProblem}
            </p>
          )}
        </div>
      </div>

      <div className="settings-row">
        <label htmlFor="provider-url">网址</label>
        <div className="provider-field">
          <input
            id="provider-url"
            className="field"
            value={draft.baseUrl}
            autoComplete="off"
            spellCheck={false}
            placeholder="https://api.example.com/v1"
            aria-invalid={check.urlProblem ? true : undefined}
            onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
          />
          {check.urlProblem && (
            <p className="field-problem" role="alert">
              {check.urlProblem}
            </p>
          )}
          {check.destination && (
            <p className="hint" role="status">
              生成纪要时，转写文本会发送到 {check.destination}。
            </p>
          )}
        </div>
      </div>

      <label className="provider-check">
        <input
          type="checkbox"
          checked={draft.needsKey}
          onChange={(e) => setDraft({ ...draft, needsKey: e.target.checked })}
        />
        <span>这个服务需要 API Key</span>
      </label>

      {error && (
        <p className="callout callout-warn" role="alert">
          {error}
        </p>
      )}
      <div className="settings-inline">
        <button type="submit" className="key key-primary" disabled={!check.valid || busy}>
          {busy ? '保存中...' : '保存'}
        </button>
        <button type="button" className="key key-quiet" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}
