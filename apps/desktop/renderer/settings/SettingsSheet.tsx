// 设置：纪要服务（provider、模型、该 provider 的 Key）和本机转写语言。
// Provider 和模型来自 settings.noteProvider / noteModel；Key 按 provider 分别保存，
// 只经 Preload 交给 Main 写入系统安全存储，界面从不读取或回显 Key 原文。
import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import type { AppSettings, Result, TranscriptionLanguage } from '@shared/contracts';
import { Dialog } from '../ui/Dialog';
import { REQUEST_FAILED_MESSAGE, describeError } from '../ui/errors';
import { Icon } from '../ui/icons';
import { PROVIDERS, providerInfo } from '../ui/providers';

type KeyState =
  | { kind: 'loading' }
  | { kind: 'known'; present: boolean }
  | { kind: 'unavailable'; message: string };

const LANGUAGES: { value: TranscriptionLanguage; label: string }[] = [
  { value: 'auto', label: '自动识别' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英文' },
];

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

const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function SettingsSheet({
  onClose,
  onChanged,
}: {
  onClose(): void;
  /** 设置保存成功后通知 App 刷新 provider 展示 */
  onChanged(settings: AppSettings): void;
}): ReactElement {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [keyState, setKeyState] = useState<KeyState>({ kind: 'loading' });
  const [keyDraft, setKeyDraft] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMessage, setKeyMessage] = useState<{ fault: boolean; text: string } | null>(null);

  const provider = settings?.noteProvider ?? null;

  useEffect(() => {
    let active = true;
    void call(() => window.turnnote.settings.get()).then((result) => {
      if (!active) return;
      if (result?.ok) setSettings(result.value);
      else setSettingsError(failure(result));
    });
    return () => {
      active = false;
    };
  }, []);

  // 切换 provider 后重新读取该 provider 的 Key 状态
  useEffect(() => {
    if (!provider) return;
    let active = true;
    void call(() => window.turnnote.settings.hasApiKey(provider)).then((result) => {
      if (!active) return;
      setKeyState(
        result?.ok
          ? { kind: 'known', present: result.value }
          : { kind: 'unavailable', message: failure(result) },
      );
    });
    return () => {
      active = false;
    };
  }, [provider]);

  async function update(patch: Partial<AppSettings>): Promise<boolean> {
    setSaving(true);
    setSettingsError(null);
    const result = await call(() => window.turnnote.settings.update(patch));
    setSaving(false);
    if (result?.ok) {
      setSettings(result.value);
      onChanged(result.value);
      return true;
    }
    setSettingsError(failure(result));
    return false;
  }

  async function changeProvider(next: string): Promise<void> {
    const info = providerInfo(next);
    // 该 provider 的 Key 状态和输入随之重置，由下面的 effect 重新读取
    setKeyState({ kind: 'loading' });
    setKeyMessage(null);
    setKeyDraft('');
    // 换服务商时模型名必须跟着换，否则会把旧服务商的模型名发给新服务商
    // 下拉只列出已登记的服务商，它们都有默认模型；后端要求模型名非空，所以不会发送空值
    const model = info.models[0];
    if (!model) return;
    await update({ noteProvider: next, noteModel: model });
    setModelDraft(null);
  }

  async function saveModel(): Promise<void> {
    const value = (modelDraft ?? '').trim();
    if (!value || value === settings?.noteModel) return setModelDraft(null);
    if (await update({ noteModel: value })) setModelDraft(null);
  }

  async function saveKey(event: FormEvent): Promise<void> {
    event.preventDefault();
    const value = keyDraft.trim();
    if (!value || keyBusy || !provider) return;
    setKeyBusy(true);
    setKeyMessage(null);
    const result = await call(() => window.turnnote.settings.setApiKey(provider, value));
    setKeyBusy(false);
    // 无论成功与否都清空输入框，Key 不在界面中停留
    setKeyDraft('');
    if (result?.ok) {
      setKeyState({ kind: 'known', present: true });
      setKeyMessage({ fault: false, text: '已保存到系统安全存储。' });
    } else {
      setKeyMessage({ fault: true, text: failure(result) });
    }
  }

  async function clearKey(): Promise<void> {
    if (!provider) return;
    setKeyBusy(true);
    setKeyMessage(null);
    const result = await call(() => window.turnnote.settings.clearApiKey(provider));
    setKeyBusy(false);
    if (result?.ok) {
      setKeyState({ kind: 'known', present: false });
      setKeyMessage({ fault: false, text: '已清除。' });
    } else {
      setKeyMessage({ fault: true, text: failure(result) });
    }
  }

  const info = provider ? providerInfo(provider) : null;
  const model = modelDraft ?? settings?.noteModel ?? '';
  const modelInvalid =
    modelDraft !== null && modelDraft.trim() !== '' && !MODEL_PATTERN.test(modelDraft.trim());
  const knownProvider = provider ? PROVIDERS.some((item) => item.id === provider) : true;

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

      {settingsError && (
        <p className="callout callout-warn" role="alert">
          {settingsError}
        </p>
      )}

      <section className="settings-group" aria-labelledby="settings-notes">
        <h3 id="settings-notes">纪要服务</h3>
        {settings && info ? (
          <>
            <div className="settings-row">
              <label htmlFor="note-provider">服务商</label>
              <select
                id="note-provider"
                className="field field-select"
                value={settings.noteProvider}
                disabled={saving}
                onChange={(e) => void changeProvider(e.target.value)}
              >
                {!knownProvider && <option value={settings.noteProvider}>{info.label}</option>}
                {PROVIDERS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="settings-row">
              <label htmlFor="note-model">模型</label>
              <div className="settings-inline">
                <input
                  id="note-model"
                  className="field"
                  list="note-model-options"
                  value={model}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={saving}
                  aria-invalid={modelInvalid || undefined}
                  onChange={(e) => setModelDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void saveModel();
                    }
                  }}
                />
                <datalist id="note-model-options">
                  {info.models.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
                {modelDraft !== null && modelDraft.trim() !== settings.noteModel && (
                  <button
                    type="button"
                    className="key key-primary"
                    disabled={saving || modelInvalid || !modelDraft.trim()}
                    onClick={() => void saveModel()}
                  >
                    保存
                  </button>
                )}
              </div>
            </div>
            {modelInvalid && (
              <p className="callout callout-warn" role="alert">
                模型名只能包含字母、数字、点、下划线和连字符。
              </p>
            )}

            <div className="settings-row">
              <label htmlFor="api-key">API Key</label>
              <form className="settings-inline" onSubmit={(e) => void saveKey(e)}>
                <input
                  id="api-key"
                  className="field"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="粘贴 Key"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                />
                <button
                  type="submit"
                  className="key key-primary"
                  disabled={!keyDraft.trim() || keyBusy}
                >
                  <Icon name="key" />
                  保存
                </button>
                {keyState.kind === 'known' && keyState.present && (
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

            <p className="key-status" role="status">
              <span
                className={`dot dot-${keyState.kind === 'known' && keyState.present ? 'done' : keyState.kind === 'unavailable' ? 'warn' : 'idle'}`}
                aria-hidden="true"
              />
              {keyState.kind === 'loading' && '正在检查...'}
              {keyState.kind === 'known' && (keyState.present ? '已保存' : '未设置')}
              {keyState.kind === 'unavailable' && keyState.message}
            </p>
            {keyMessage?.fault && (
              <p className="callout callout-warn" role="alert">
                {keyMessage.text}
              </p>
            )}
          </>
        ) : (
          !settingsError && <p className="hint">正在读取设置...</p>
        )}
      </section>

      <section className="settings-group" aria-labelledby="settings-transcription">
        <h3 id="settings-transcription">本机转写</h3>
        {settings && (
          <div className="settings-row">
            <label htmlFor="transcription-language">语言</label>
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
    </Dialog>
  );
}
