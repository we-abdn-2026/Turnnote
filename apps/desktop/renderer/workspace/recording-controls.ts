// 录音控制按钮和状态指示器的视图状态。只从会话状态推导展示，不新增业务状态，
// 媒体关闭但 Main 尚未提交时显示保存等待，业务终态仍只来自 Main。
import type { MeetingStatus } from '@shared/contracts';
import { availableActions, type SessionState } from './meeting-session';

/** 媒体关闭后的 recording 显示 saving；captured/transcribing/generating 是处理中 */
export type Indicator = 'none' | 'idle' | 'recording' | 'processing' | 'done' | 'failed' | 'saving';

const INDICATORS: Record<MeetingStatus, Indicator> = {
  created: 'idle',
  recording: 'recording',
  captured: 'processing',
  transcribing: 'processing',
  generating: 'processing',
  transcribed: 'done',
  ready: 'done',
  failed: 'failed',
  deleted: 'none',
};

/** 界面局部的确认步骤：开始前的参会者授权提醒、丢弃录音前的确认 */
export type Confirming = 'start' | 'discard' | null;

export interface OpenedConfirmation {
  action: Exclude<Confirming, null>;
  /** 打开时会话的 revision */
  revision: number;
}

/** 确认步骤绑定打开时的会议快照；会议有任何更新后失效，不会在之后自行弹出 */
export function activeConfirmation(
  opened: OpenedConfirmation | null,
  state: SessionState,
): Confirming {
  return opened && state.meeting && opened.revision === state.revision ? opened.action : null;
}

export interface RecordingControlsView {
  indicator: Indicator;
  /** 显示开始前的授权提醒；开始不再可用时自动收起 */
  showConsent: boolean;
  /** 显示丢弃录音确认；丢弃不再可用时自动收起 */
  showDiscardConfirm: boolean;
  start: { visible: boolean; enabled: boolean; busy: boolean };
  stop: { visible: boolean; enabled: boolean; busy: boolean };
  discard: { visible: boolean; enabled: boolean; busy: boolean };
}

export function deriveRecordingControls(
  state: SessionState,
  confirming: Confirming,
): RecordingControlsView {
  const { meeting, pending } = state;
  const actions = availableActions(state);
  const indicator: Indicator =
    meeting?.status === 'recording' && state.captureStopped
      ? 'saving'
      : meeting
        ? INDICATORS[meeting.status]
        : 'none';
  const failedRecording = meeting?.status === 'failed' && meeting.lastError?.kind === 'recording';
  return {
    indicator,
    showConsent: confirming === 'start' && actions.start,
    showDiscardConfirm: confirming === 'discard' && actions.discard,
    // 按钮是否显示只看会议状态：响应到达前 Main 的事件已推进状态时，旧按钮立即消失
    start: {
      visible: meeting?.status === 'created',
      enabled: actions.start && confirming === null,
      busy: pending === 'start',
    },
    stop: {
      visible: meeting?.status === 'recording',
      enabled: actions.stop,
      busy: pending === 'stop',
    },
    // 只为失败的录音提供丢弃入口；录音中的取消不在本界面提供
    discard: {
      visible: failedRecording,
      enabled: failedRecording && actions.discard && confirming === null,
      busy: pending === 'discard',
    },
  };
}
