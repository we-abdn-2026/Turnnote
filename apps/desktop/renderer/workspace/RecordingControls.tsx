import { useState, type ReactElement } from 'react';
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
}

export function RecordingControls({ session, state }: RecordingControlsProps): ReactElement {
  const [opened, setOpened] = useState<OpenedConfirmation | null>(null);
  const view = deriveRecordingControls(state, activeConfirmation(opened, state));
  const setConfirming = (action: Confirming): void =>
    setOpened(action ? { action, revision: state.revision } : null);

  async function confirmStart(): Promise<void> {
    setConfirming(null);
    await session.start();
  }

  async function confirmDiscard(): Promise<void> {
    setConfirming(null);
    await session.discard();
  }

  return (
    <div className="recording-controls">
      {view.indicator === 'recording' && (
        <p className="recording-indicator" role="status">
          <span className="recording-dot" aria-hidden="true" />
          正在录音
        </p>
      )}
      {view.indicator === 'saving' && <p role="status">录音已结束，等待保存。</p>}
      {view.indicator === 'processing' && (
        <p className="processing-indicator" role="status">
          录音已结束，正在处理
        </p>
      )}

      {view.showConsent && (
        <div className="consent-notice" role="alertdialog" aria-labelledby="consent-title">
          <strong id="consent-title">开始录音前</strong>
          <p>请告知所有参会者本次会议将被录音，并按当地法律和组织要求取得必要的同意。</p>
          <div className="meeting-actions">
            <button type="button" onClick={() => void confirmStart()}>
              已告知，开始录音
            </button>
            <button type="button" className="secondary" onClick={() => setConfirming(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      {view.showDiscardConfirm && (
        <div className="consent-notice" role="alertdialog" aria-labelledby="discard-title">
          <strong id="discard-title">丢弃这次录音？</strong>
          <p>已采集的音频将被删除且无法恢复，之后可以重新录音。</p>
          <div className="meeting-actions">
            <button type="button" className="danger" onClick={() => void confirmDiscard()}>
              丢弃并重新录音
            </button>
            <button type="button" className="secondary" onClick={() => setConfirming(null)}>
              保留
            </button>
          </div>
        </div>
      )}

      <div className="meeting-actions">
        {view.start.visible && (
          <button
            type="button"
            onClick={() => setConfirming('start')}
            disabled={!view.start.enabled}
          >
            {view.start.busy ? '正在开始...' : '开始录音'}
          </button>
        )}
        {view.stop.visible && (
          <button type="button" onClick={() => void session.stop()} disabled={!view.stop.enabled}>
            {view.stop.busy ? '正在停止...' : state.captureStopped ? '重试保存' : '停止录音'}
          </button>
        )}
        {view.discard.visible && (
          <button
            type="button"
            className="secondary"
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
