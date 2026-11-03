// 录音计时：从 Renderer 看到某个录音任务开始计时，按整秒步进，采集结束后冻结。
// 计时只用于显示，业务状态仍只来自 Main；重新打开窗口后从零开始计时，不伪造历史时长。
import type { MeetingSession, SessionState } from './meeting-session';

export interface RecordingClock {
  /** 当前录音任务已经过的毫秒数；没有录音任务时为 null */
  getSnapshot(): number | null;
  subscribe(listener: () => void): () => void;
  connect(): () => void;
}

const TICK_MS = 250;

export function createRecordingClock(
  session: Pick<MeetingSession, 'getState' | 'subscribe'>,
  now: () => number = Date.now,
): RecordingClock {
  const listeners = new Set<() => void>();
  let jobId: string | null = null;
  let startedAt = 0;
  let elapsed: number | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  function publish(next: number | null): void {
    // 只在整秒变化时通知，避免每次 tick 都重绘
    const same =
      next === elapsed ||
      (next !== null && elapsed !== null && Math.floor(next / 1000) === Math.floor(elapsed / 1000));
    elapsed = next;
    if (!same) for (const listener of [...listeners]) listener();
  }

  function stopTicking(): void {
    clearInterval(timer);
    timer = undefined;
  }

  function sync(state: SessionState): void {
    const meeting = state.meeting;
    const active = meeting?.status === 'recording' ? meeting.activeJobId : null;
    if (!active) {
      stopTicking();
      jobId = null;
      publish(null);
      return;
    }
    if (active !== jobId) {
      jobId = active;
      startedAt = now();
      publish(0);
    }
    if (state.captureStopped) {
      // 媒体已关闭、等待保存：时长停在采集结束的那一刻
      if (timer) publish(now() - startedAt);
      stopTicking();
      return;
    }
    if (!timer) timer = setInterval(() => publish(now() - startedAt), TICK_MS);
  }

  return {
    getSnapshot: () => elapsed,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect() {
      sync(session.getState());
      const unsubscribe = session.subscribe(() => sync(session.getState()));
      return () => {
        unsubscribe();
        stopTicking();
      };
    },
  };
}
