// 转写模型下载提示：悬浮在窗口右下角，不改变页面布局。就绪后消失。
import { useEffect, useState, type ReactElement } from 'react';
import type { ModelStatus, TurnnoteApi } from '@shared/contracts';
import { describeError } from '../ui/errors';
import { deriveModelBanner } from './model-status';

/** 订阅 Main 推送的模型状态；先取一次当前值，事件比首次响应新时以事件为准 */
export function useModelStatus(api: TurnnoteApi): ModelStatus | null {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  useEffect(() => {
    let active = true;
    const off = api.events.onModelStatus((next) => {
      if (active) setStatus(next);
    });
    api.models
      .getStatus()
      .then((result) => {
        if (active && result.ok) setStatus((current) => current ?? result.value);
      })
      .catch(() => {});
    return () => {
      active = false;
      off();
    };
  }, [api]);
  return status;
}

export function ModelBanner({
  api,
  status,
}: {
  api: TurnnoteApi;
  status: ModelStatus | null;
}): ReactElement | null {
  // 操作错误只属于发生时的状态；状态一变（开始下载、完成、失败）它就不再显示
  const [failure, setFailure] = useState<{ state: string | undefined; message: string } | null>(
    null,
  );
  const error = failure && failure.state === status?.state ? failure.message : null;
  const view = deriveModelBanner(status);
  if (!view) return null;

  async function act(kind: 'download' | 'cancel'): Promise<void> {
    setFailure(null);
    try {
      const result = await (kind === 'download'
        ? api.models.download()
        : api.models.cancelDownload());
      if (!result.ok) setFailure({ state: status?.state, message: describeError(result.error) });
    } catch {
      setFailure({ state: status?.state, message: describeError(null) });
    }
  }

  return (
    <aside
      className="model-banner"
      data-tone={view.tone}
      role={view.tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      <strong>{view.title}</strong>
      <p>{view.detail}</p>
      {view.progress !== null && (
        <progress aria-label="转写模型下载进度" max={1} value={view.progress} />
      )}
      {error && <p className="model-banner-error">{error}</p>}
      {view.action && (
        <button
          type="button"
          className={`key ${view.action.kind === 'download' ? 'key-primary' : 'key-quiet'}`}
          onClick={() => void act(view.action!.kind)}
        >
          {view.action.label}
        </button>
      )}
    </aside>
  );
}
