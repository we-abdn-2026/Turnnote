// 后台任务进度：转写显示在场记表头，纪要生成显示在纪要表头。百分比只来自 Main 上报。
import type { ReactElement, ReactNode } from 'react';
import type { SessionState } from './meeting-session';

export function ProcessingProgress({
  state,
  action,
}: {
  state: SessionState;
  action?: ReactNode;
}): ReactElement | null {
  const status = state.meeting?.status;
  if (status !== 'transcribing' && status !== 'generating') return null;
  const label = status === 'transcribing' ? '转写进度' : '纪要生成进度';
  const progress = state.jobProgress;
  return (
    <div className="processing-progress" aria-live="polite">
      <div className="processing-progress-heading">
        <span>{label}</span>
        <span className="numeric">{progress ? `${progress.percent}%` : '等待进度上报'}</span>
      </div>
      <div className="processing-progress-bar">
        <progress aria-label={label} max={100} {...(progress ? { value: progress.percent } : {})} />
        {action}
      </div>
    </div>
  );
}
