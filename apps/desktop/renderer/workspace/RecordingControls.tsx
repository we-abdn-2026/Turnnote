// 录音条：画布底部的浮动条。录音前是一个“开始录音”，录音中是时间码 + 停止。
// 没有说明文字——位置、颜色和按钮本身就是信息。授权提醒和丢弃确认走对话框。
import { useState, type ReactElement } from 'react';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/icons';
import { formatTimecode } from '@shared/timecode';
import type { MeetingSession, SessionState } from './meeting-session';
import {
  activeConfirmation,
  deriveRecordingControls,
  type Confirming,
  type OpenedConfirmation,
} from './recording-controls';

interface RecordingControlsProps {
  session: MeetingSession;
  state: SessionState;
  /** 本次录音已经过的时长，由 App 的录音计时提供 */
  elapsedMs: number | null;
}

export function RecordingControls({
  session,
  state,
  elapsedMs,
}: RecordingControlsProps): ReactElement {
  const [opened, setOpened] = useState<OpenedConfirmation | null>(null);
  const view = deriveRecordingControls(state, activeConfirmation(opened, state));
  const setConfirming = (action: Confirming): void =>
    setOpened(action ? { action, revision: state.revision, attempt: state.attempt } : null);

  async function confirmStart(): Promise<void> {
    setConfirming(null);
    await session.start();
  }

  async function confirmDiscard(): Promise<void> {
    setConfirming(null);
    await session.discard();
  }

  const visible = view.start.visible || view.stop.visible || view.discard.visible;
  const live = view.indicator === 'recording';

  return (
    <div
      className="recording-controls dock"
      data-indicator={view.indicator}
      data-visible={visible ? 'true' : undefined}
    >
      {view.indicator === 'recording' && (
        <>
          <p className="recording-indicator" role="status">
            <span className="dot dot-rec" aria-hidden="true" />
            正在录音
          </p>
          <time className="dock-time" aria-hidden="true">
            {formatTimecode(elapsedMs ?? 0)}
          </time>
        </>
      )}
      {view.indicator === 'saving' && (
        <p className="dock-saving" role="status">
          录音已结束，等待保存。
        </p>
      )}
      {view.indicator === 'processing' && (
        <p className="processing-indicator visually-hidden" role="status">
          录音已结束，正在处理
        </p>
      )}

      {view.showConsent && (
        <Dialog
          titleId="consent-title"
          descriptionId="consent-description"
          title={view.start.resume ? '继续录音前' : '开始录音前'}
          tone="consent"
          onClose={() => setConfirming(null)}
          actions={
            <>
              <button
                type="button"
                className="key key-record"
                data-autofocus
                data-primary
                onClick={() => void confirmStart()}
              >
                {view.start.resume ? '已告知，继续录音' : '已告知，开始录音'}
              </button>
              <button type="button" className="key" onClick={() => setConfirming(null)}>
                取消
              </button>
            </>
          }
        >
          {view.start.resume && (
            <>
              <p>新的录音会接在这场会议已有内容之后，停止后自动转写并追加到转写里。</p>
              {state.note && (
                <p>已有纪要不会被改动，但会标记为“未包含新录音”，之后可以重新生成。</p>
              )}
            </>
          )}
          <p>请告知所有参会者本次会议将被录音，并按当地法律和组织要求取得必要的同意。</p>
        </Dialog>
      )}

      {view.showDiscardConfirm && (
        <Dialog
          titleId="discard-title"
          descriptionId="discard-description"
          title="丢弃这次录音？"
          tone="caution"
          onClose={() => setConfirming(null)}
          actions={
            <>
              <button
                type="button"
                className="key key-caution"
                onClick={() => void confirmDiscard()}
              >
                {state.transcriptSegments.length > 0 ? '丢弃这一段' : '丢弃并重新录音'}
              </button>
              <button
                type="button"
                className="key"
                data-autofocus
                onClick={() => setConfirming(null)}
              >
                保留
              </button>
            </>
          }
        >
          {state.transcriptSegments.length > 0 ? (
            <p>这一段录音将被删除且无法恢复。这场会议已有的转写和纪要不受影响。</p>
          ) : (
            <p>已采集的音频将被删除且无法恢复，之后可以重新录音。</p>
          )}
        </Dialog>
      )}

      <div className="transport">
        {view.start.visible && (
          <button
            type="button"
            className={view.start.resume ? 'key' : 'key key-record'}
            onClick={() => setConfirming('start')}
            disabled={!view.start.enabled}
          >
            <Icon name="record" />
            {view.start.busy ? '正在开始...' : view.start.resume ? '继续录音' : '开始录音'}
          </button>
        )}
        {view.hint && (
          <p className="dock-hint" role="status">
            {view.hint}
          </p>
        )}
        {view.stop.visible && (
          <button
            type="button"
            className={live ? 'key key-primary' : 'key'}
            onClick={() => void session.stop()}
            disabled={!view.stop.enabled}
          >
            <Icon name="stop" />
            {view.stop.busy ? '正在停止...' : state.captureStopped ? '重试保存' : '停止录音'}
          </button>
        )}
        {view.discard.visible && (
          <button
            type="button"
            className="key key-danger"
            onClick={() => setConfirming('discard')}
            disabled={!view.discard.enabled}
          >
            {view.discard.busy ? '正在丢弃...' : '丢弃录音'}
          </button>
        )}
      </div>
    </div>
  );
}
