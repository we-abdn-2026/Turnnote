// 设置：纪要服务（选哪家、用什么模型、Key、自定义服务商）和本机转写语言。
// 服务商名称、网址、Key 状态都来自 Main 的目录（providers.list）；界面不写死任何服务商。
// Key 只经 Preload 交给 Main 写入系统安全存储，界面从不读取或回显 Key 原文。
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { AiProviderInfo, AppSettings, Result, TranscriptionLanguage } from '@shared/contracts';
import { Dialog } from '../ui/Dialog';
import { REQUEST_FAILED_MESSAGE, describeError } from '../ui/errors';
import { Icon } from '../ui/icons';
import { ModelPicker } from './ModelPicker';
import { ProviderForm } from './ProviderForm';
import { deriveProviderRows, formatService } from './provider-view';

const LANGUAGES: { value: TranscriptionLanguage; label: string }[] = [
  { value: 'auto', label: '自动识别' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英文' },
];

const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/;

async function call<T>(request: () => Promise<Result<T>>): Promise<Result<T> | null> {
  try {
    return await request();
  } catch {
    return null;
  }
}

function failure(result: Result<unknown> | null): string {
  return result && !result.ok ? describeError(result.error) : REQUEST_FAILED_MESSAGE;
}

type Message = { fault: boolean; text: string } | null;

export function SettingsSheet({
  onClose,
  onChanged,
}: {
  onClose(): void;
  /** 设置或服务商目录变化后通知 App，用于刷新各处显示的服务商名称 */
  onChanged(settings: AppSettings, providers: AiProviderInfo[]): void;
}): ReactElement {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [providers, setProviders] = useState<AiProviderInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  // 选中了没有预置模型的服务商：要先填模型名，两者一起保存，之前设置保持不变
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [form, setForm] = useState<{ editing: AiProviderInfo | null } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<AiProviderInfo | null>(null);
  // 切换服务商后，慢返回的旧请求不能覆盖新状态
  const generation = useRef(0);

  const reload = useCallback(
    async (notify = false): Promise<void> => {
      const [settingsResult, providersResult] = await Promise.all([
        call(() => window.turnnote.settings.get()),
        call(() => window.turnnote.providers.list()),
      ]);
      if (settingsResult?.ok && providersResult?.ok) {
        setSettings(settingsResult.value);
        setProviders(providersResult.value);
        setLoadError(null);
        if (notify) onChanged(settingsResult.value, providersResult.value);
      } else {
        setLoadError(failure(settingsResult?.ok ? providersResult : settingsResult));
      }
    },
    [onChanged],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      await Promise.resolve();
      if (active) await reload();
    })();
    return () => {
      active = false;
    };
  }, [reload]);

  const pending = providers?.find((item) => item.id === pendingId) ?? null;
  // 界面上"正在操作"的服务商：待选的优先，否则是已保存的当前服务商
  const current = pending ?? providers?.find((item) => item.id === settings?.noteProvider) ?? null;

  function publish(nextSettings: AppSettings, nextProviders: AiProviderInfo[]): void {
    setSettings(nextSettings);
    setProviders(nextProviders);
    onChanged(nextSettings, nextProviders);
  }

  async function update(patch: Partial<AppSettings>): Promise<boolean> {
    if (!providers) return false;
    setSaving(true);
    setMessage(null);
    const result = await call(() => window.turnnote.settings.update(patch));
    setSaving(false);
    if (result?.ok) {
      publish(result.value, providers);
      return true;
    }
    setMessage({ fault: true, text: failure(result) });
    return false;
  }

  async function choose(provider: AiProviderInfo): Promise<void> {
    if (provider.id === settings?.noteProvider || saving) return;
    generation.current += 1;
    setKeyDraft('');
    setMessage(null);
    // 换服务商时模型名必须跟着换，否则会把旧服务商的模型名发给新服务商。
    // 自定义服务商没有预置模型：先让用户填写，填好后与服务商一起保存，期间设置不变
    if (!provider.defaultModel) {
      setPendingId(provider.id);
      setModelDraft('');
      return;
    }
    setPendingId(null);
    setModelDraft(null);
    await update({ noteProvider: provider.id, noteModel: provider.defaultModel });
  }

  async function saveModel(): Promise<void> {
    const value = (modelDraft ?? '').trim();
    if (pending) {
      if (!value) return;
      if (await update({ noteProvider: pending.id, noteModel: value })) {
        setPendingId(null);
        setModelDraft(null);
      }
      return;
    }
    if (!value || value === settings?.noteModel) return setModelDraft(null);
    if (await update({ noteModel: value })) setModelDraft(null);
  }

  /** Key 状态变化后重新读目录，使各处的"已保存/缺 Key"一致 */
  async function refreshProviders(): Promise<AiProviderInfo[] | null> {
    const result = await call(() => window.turnnote.providers.list());
    if (result?.ok && settings) {
      publish(settings, result.value);
      return result.value;
    }
    return null;
  }

  async function saveKey(event: FormEvent): Promise<void> {
    event.preventDefault();
    const value = keyDraft.trim();
    if (!value || keyBusy || !current) return;
    const token = ++generation.current;
    setKeyBusy(true);
    setMessage(null);
    const result = await call(() => window.turnnote.settings.setApiKey(current.id, value));
    setKeyBusy(false);
    // 无论成功与否都清空输入框，Key 不在界面中停留
    setKeyDraft('');
    if (token !== generation.current) return;
    if (result?.ok) {
      await refreshProviders();
      setMessage({ fault: false, text: `${current.label} 的 Key 已保存到系统安全存储。` });
    } else {
      setMessage({ fault: true, text: failure(result) });
    }
  }

  async function clearKey(): Promise<void> {
    if (!current) return;
    setKeyBusy(true);
    setMessage(null);
    const result = await call(() => window.turnnote.settings.clearApiKey(current.id));
    setKeyBusy(false);
    if (result?.ok) {
      await refreshProviders();
      setMessage({ fault: false, text: `已清除 ${current.label} 的 Key。` });
    } else {
      setMessage({ fault: true, text: failure(result) });
    }
  }

  async function testConnection(): Promise<void> {
    if (!current || !settings || testing) return;
    setTesting(true);
    setMessage(null);
    const result = await call(() =>
      window.turnnote.providers.test(current.id, (modelDraft ?? settings.noteModel).trim()),
    );
    setTesting(false);
    setMessage(
      result?.ok
        ? {
            fault: false,
            text: `连接正常：${current.label} 可以使用这个模型。没有发送任何会议内容。`,
          }
        : { fault: true, text: failure(result) },
    );
  }

  async function removeProvider(provider: AiProviderInfo): Promise<void> {
    setConfirmRemove(null);
    const result = await call(() => window.turnnote.providers.removeCustom(provider.id));
    if (result?.ok) {
      // 删除可能让设置回到默认服务，设置和目录都重新读取，并通知 App
      await reload(true);
      setMessage({ fault: false, text: `已删除 ${provider.label}。` });
    } else {
      setMessage({ fault: true, text: failure(result) });
    }
  }

  const rows = providers && settings ? deriveProviderRows(providers, settings) : [];
  const model = modelDraft ?? settings?.noteModel ?? '';
  const modelDirty =
    modelDraft !== null && (pending !== null || modelDraft.trim() !== settings?.noteModel);
  const modelInvalid =
    modelDraft !== null && modelDraft.trim() !== '' && !MODEL_PATTERN.test(modelDraft.trim());
  const modelEmpty = modelDraft !== null && modelDraft.trim() === '';

  return (
    <Dialog
      role="dialog"
      className="settings-sheet"
      titleId="settings-title"
      descriptionId="settings-description"
      title="设置"
      closeLabel="关闭设置"
      onClose={onClose}
    >
      <span id="settings-description" className="visually-hidden">
        纪要服务、模型、API Key 和转写语言
      </span>

      {loadError && (
        <p className="callout callout-warn" role="alert">
          {loadError}
        </p>
      )}

      <section className="settings-group" aria-label="纪要服务">
        {settings && providers && current ? (
          <>
            <ul className="provider-list" aria-label="可用的纪要服务">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="provider-row"
                  data-active={row.active || undefined}
                  data-pending={row.id === pendingId || undefined}
                >
                  <button
                    type="button"
                    className="provider-pick"
                    aria-pressed={row.active}
                    disabled={saving}
                    onClick={() => void choose(providers.find((item) => item.id === row.id)!)}
                  >
                    <span className="provider-main">
                      <span className="provider-name">{row.label}</span>
                      <span className="provider-dest">{row.destination}</span>
                    </span>
                    <span className="provider-state" data-badge={row.badge}>
                      <span
                        className={`dot dot-${row.badge === 'needs-key' ? 'warn' : 'done'}`}
                        aria-hidden="true"
                      />
                      {row.status}
                      {row.active && <span className="provider-current">使用中</span>}
                    </span>
                  </button>
                  {row.editable && (
                    <span className="provider-tools">
                      <button
                        type="button"
                        className="key key-icon key-quiet"
                        data-tip="编辑"
                        onClick={() =>
                          setForm({ editing: providers.find((item) => item.id === row.id)! })
                        }
                      >
                        <Icon name="edit" />
                        <span className="visually-hidden">编辑 {row.label}</span>
                      </button>
                      <button
                        type="button"
                        className="key key-icon key-quiet key-danger"
                        data-tip="删除"
                        onClick={() =>
                          setConfirmRemove(providers.find((item) => item.id === row.id)!)
                        }
                      >
                        <Icon name="trash" />
                        <span className="visually-hidden">删除 {row.label}</span>
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>

            {form ? (
              <ProviderForm
                editing={form.editing}
                existing={providers}
                onCancel={() => setForm(null)}
                onSaved={async (saved) => {
                  setForm(null);
                  await refreshProviders();
                  setMessage({ fault: false, text: `已保存 ${saved.label}。` });
                }}
              />
            ) : (
              <button
                type="button"
                className="key key-quiet provider-add"
                onClick={() => setForm({ editing: null })}
              >
                <Icon name="plus" />
                添加自己的服务（OpenAI 兼容）
              </button>
            )}

            <div className="provider-detail" aria-label={`${current.label} 设置`}>
              <div className="settings-row">
                <label htmlFor="note-model">模型</label>
                <div className="settings-inline">
                  <ModelPicker
                    id="note-model"
                    value={model}
                    options={current.models}
                    placeholder={
                      current.models.length ? current.models[0] : '填写该服务支持的模型名'
                    }
                    disabled={saving}
                    invalid={modelInvalid}
                    onChange={setModelDraft}
                    onCommit={() => void saveModel()}
                  />
                  {modelDirty && (
                    <button
                      type="button"
                      className="key key-primary"
                      disabled={saving || modelInvalid || modelEmpty}
                      onClick={() => void saveModel()}
                    >
                      {pending ? `使用 ${pending.label}` : '保存模型'}
                    </button>
                  )}
                </div>
              </div>
              {pending && (
                <p className="callout" role="status">
                  {pending.label} 没有预置模型。填写它支持的模型名后点“使用 {pending.label}”，
                  才会切换过去；在那之前仍使用{' '}
                  {formatService(
                    providers?.find((item) => item.id === settings.noteProvider)?.label ?? '',
                    settings.noteModel,
                  )}
                  。
                </p>
              )}
              {modelInvalid && (
                <p className="callout callout-warn" role="alert">
                  模型名只能包含字母、数字，以及 . _ : / @ + - 这些符号。
                </p>
              )}

              {current.needsKey && (
                <div className="settings-row">
                  <label htmlFor="api-key">API Key</label>
                  <form className="settings-inline" onSubmit={(e) => void saveKey(e)}>
                    <input
                      id="api-key"
                      className="field"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={
                        current.hasKey
                          ? `已保存 ${current.label} 的 Key，粘贴新 Key 可替换`
                          : `粘贴 ${current.label} 的 Key`
                      }
                      value={keyDraft}
                      onChange={(e) => setKeyDraft(e.target.value)}
                    />
                    <button
                      type="submit"
                      className="key key-primary"
                      disabled={!keyDraft.trim() || keyBusy}
                    >
                      <Icon name="key" />
                      {current.hasKey ? '替换' : '保存'}
                    </button>
                    {current.hasKey && (
                      <button
                        type="button"
                        className="key key-quiet key-danger"
                        disabled={keyBusy}
                        onClick={() => void clearKey()}
                      >
                        清除
                      </button>
                    )}
                  </form>
                </div>
              )}

              <div className="settings-row">
                <span aria-hidden="true" />
                <div className="settings-inline">
                  <button
                    type="button"
                    className="key"
                    disabled={testing || !current.ready || !model.trim() || modelInvalid}
                    onClick={() => void testConnection()}
                  >
                    <Icon name="refresh" />
                    {testing ? '正在测试...' : '测试连接'}
                  </button>
                </div>
              </div>
            </div>

            {message && (
              <p
                className={message.fault ? 'callout callout-warn' : 'key-status'}
                role={message.fault ? 'alert' : 'status'}
              >
                {message.text}
              </p>
            )}
          </>
        ) : (
          !loadError && <p className="status-line">正在读取设置...</p>
        )}
      </section>

      <section className="settings-group" aria-label="本机转写">
        {settings && (
          <div className="settings-row">
            <label htmlFor="transcription-language">转写语言</label>
            <select
              id="transcription-language"
              className="field field-select"
              value={settings.transcriptionLanguage}
              disabled={saving}
              onChange={(e) =>
                void update({ transcriptionLanguage: e.target.value as TranscriptionLanguage })
              }
            >
              {LANGUAGES.map((language) => (
                <option key={language.value} value={language.value}>
                  {language.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </section>

      {confirmRemove && (
        <Dialog
          role="alertdialog"
          titleId="remove-provider-title"
          descriptionId="remove-provider-description"
          title={`删除 ${confirmRemove.label}？`}
          tone="caution"
          onClose={() => setConfirmRemove(null)}
          actions={
            <>
              <button
                type="button"
                className="key key-caution"
                onClick={() => void removeProvider(confirmRemove)}
              >
                删除
              </button>
              <button
                type="button"
                className="key"
                data-autofocus
                onClick={() => setConfirmRemove(null)}
              >
                取消
              </button>
            </>
          }
        >
          <p id="remove-provider-description">
            会同时删除保存在这台电脑上的 {confirmRemove.label} Key。已经用它生成的纪要不受影响。
            {settings?.noteProvider === confirmRemove.id && '它正在使用，删除后会改回默认服务。'}
          </p>
        </Dialog>
      )}
    </Dialog>
  );
}
