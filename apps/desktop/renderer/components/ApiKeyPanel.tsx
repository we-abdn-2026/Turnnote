import { useEffect, useRef, useState, type ReactElement } from 'react';

type Phase = 'loading' | 'no-key' | 'has-key' | 'editing' | 'saving' | 'error';

export function ApiKeyPanel(): ReactElement {
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // provider 由 settings 决定；此处先用 deepseek 作为默认，
  // 待设置界面（#32）完成后改成从 settings.get() 读取。
  const [provider, setProvider] = useState('deepseek');

  useEffect(() => {
    let active = true;
    void window.turnnote.settings.hasApiKey(provider).then((result) => {
      if (!active) return;
      if (result.ok) setPhase(result.value ? 'has-key' : 'no-key');
      else setPhase('error');
    });
    return () => {
      active = false;
    };
  }, [provider]);

  async function save(): Promise<void> {
    const value = inputRef.current?.value.trim() ?? '';
    if (!value) return;
    setPhase('saving');
    setError(null);
    const result = await window.turnnote.settings.setApiKey(provider, value);
    if (result.ok) {
      setPhase('has-key');
    } else {
      setError(result.error.message);
      setPhase('editing');
    }
  }

  async function clear(): Promise<void> {
    setPhase('saving');
    setError(null);
    const result = await window.turnnote.settings.clearApiKey(provider);
    if (result.ok) setPhase('no-key');
    else {
      setError(result.error.message);
      setPhase('has-key');
    }
  }

  function startEdit(): void {
    setPhase('editing');
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  if (phase === 'loading') {
    return <div className="api-key-panel loading">加载中...</div>;
  }

  return (
    <div className="api-key-panel">
      <h3>AI 纪要生成</h3>

      <div className="api-key-provider-row">
        <label htmlFor="api-key-provider">Provider</label>
        <select
          id="api-key-provider"
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            setPhase('loading');
            setError(null);
          }}
          className="api-key-provider-select"
        >
          <option value="deepseek">DeepSeek</option>
          <option value="openai">OpenAI</option>
          <option value="ollama">Ollama (本地，无需 Key)</option>
        </select>
      </div>

      {phase === 'has-key' && (
        <div className="api-key-set">
          <span className="api-key-badge">已配置 ✓</span>
          <div className="api-key-actions">
            <button type="button" onClick={startEdit} className="secondary-button">
              更换
            </button>
            <button type="button" onClick={() => void clear()} className="danger-button">
              清除
            </button>
          </div>
        </div>
      )}

      {(phase === 'no-key' || phase === 'editing' || phase === 'saving') && (
        <div className="api-key-form">
          {phase === 'no-key' && (
            <p className="api-key-hint">
              纪要生成需要 {provider} API Key。密钥加密存储在本机，不会上传。
            </p>
          )}
          {error && (
            <p className="api-key-error" role="alert">
              {error}
            </p>
          )}
          <div className="api-key-input-row">
            <input
              ref={inputRef}
              type="password"
              className="api-key-input"
              placeholder={provider === 'ollama' ? '无需填写' : 'sk-...'}
              autoComplete="off"
              spellCheck={false}
              disabled={phase === 'saving' || provider === 'ollama'}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save();
              }}
            />
            <button
              type="button"
              onClick={() => void save()}
              disabled={phase === 'saving' || provider === 'ollama'}
            >
              {phase === 'saving' ? '保存中...' : '保存'}
            </button>
            {phase === 'editing' && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setPhase('has-key');
                  setError(null);
                }}
              >
                取消
              </button>
            )}
          </div>
        </div>
      )}

      {phase === 'error' && (
        <p className="api-key-error" role="alert">
          无法读取 API Key 状态。
        </p>
      )}
    </div>
  );
}
