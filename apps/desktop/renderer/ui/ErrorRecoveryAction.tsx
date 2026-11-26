import { useState, type ReactElement } from 'react';
import type { ErrorCode } from '@shared/contracts';
import { errorInfo } from '@shared/result';
import { describeError } from './errors';

interface Props {
  code: ErrorCode;
  disabled?: boolean;
  onRetry?: () => void;
  onSettings(): void;
}

/** 分类来自共享目录；重试由调用方提供，以保留状态检查和发送确认。 */
export function ErrorRecoveryAction({
  code,
  disabled,
  onRetry,
  onSettings,
}: Props): ReactElement | null {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const recovery = errorInfo(code).recovery;

  async function openPermissions(): Promise<void> {
    setPending(true);
    setFailure(null);
    try {
      const result = await window.turnnote.recording.openPermissionSettings('microphone');
      if (!result.ok) setFailure(describeError(result.error));
    } catch {
      setFailure(describeError(null));
    } finally {
      setPending(false);
    }
  }

  if (recovery === 'permissions') {
    return (
      <>
        <button
          type="button"
          className="key"
          disabled={disabled || pending}
          onClick={() => void openPermissions()}
        >
          {pending ? '正在打开...' : '打开录音权限设置'}
        </button>
        {failure && <p role="alert">{failure}</p>}
      </>
    );
  }
  const action = recovery === 'settings' ? onSettings : recovery === 'retry' ? onRetry : undefined;
  if (!action) return null;
  return (
    <button type="button" className="key" disabled={disabled} onClick={action}>
      {recovery === 'settings' ? '检查设置' : '重试'}
    </button>
  );
}
