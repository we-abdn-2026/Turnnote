// 录音工作区的会议会话：会议状态只来自 Main 的响应快照和 onMeetingUpdated 事件，
// Renderer 不自行推导业务终态。不依赖 React，便于单元测试。
import type { MeetingDetail, Result, TurnnoteApi } from '@shared/contracts';
import { canCancelRecording, canStartJob } from '@shared/lifecycle';

type SessionApi = Pick<TurnnoteApi, 'meetings' | 'events'>;

export interface MeetingRecording {
  start(
    id: string,
    notify: { warning(message: string): void; error(message: string): void; stopped(): void },
  ): Promise<Result<MeetingDetail>>;
  stop(id: string, jobId: string): Promise<Result<MeetingDetail>>;
  discard(id: string, jobId: string): Promise<Result<MeetingDetail>>;
  disconnect(): void;
}

export type SessionAction = 'create' | 'start' | 'stop' | 'discard';

export interface SessionState {
  meeting: MeetingDetail | null;
  /** 正在等待 Main 响应的操作；期间拒绝新的操作，防止重复创建/启动/停止 */
  pending: SessionAction | null;
  /** 最近一次操作失败的安全信息；下一次操作开始时清除 */
  error: string | null;
  /** 每次替换会议快照时递增；updatedAt 可能在同一毫秒内重复，不能用来区分快照 */
  revision: number;
  warning: string | null;
  /** Renderer media is closed; Main may still be committing the saved audio. */
  captureStopped: boolean;
}

// 底层异常可能包含路径或传输细节，界面只展示通用信息
export const REQUEST_FAILED_MESSAGE = '操作失败，请重试。';

/** Main 录音任务仍活动且 Renderer 尚未关闭媒体；保存等待不冒充正在采集 */
export function isRecording(state: SessionState): boolean {
  return state.meeting?.status === 'recording' && !state.captureStopped;
}

/** 与 Main/mock 共用 lifecycle 条件，界面按此启用按钮 */
export function availableActions(state: SessionState): Record<SessionAction, boolean> {
  const { meeting, pending } = state;
  const idle = pending === null;
  return {
    create: idle && meeting?.status !== 'recording',
    start: idle && !!meeting && canStartJob(meeting, 'recording', false),
    stop: idle && meeting?.status === 'recording' && !!meeting.activeJobId,
    discard: idle && !!meeting && canCancelRecording(meeting),
  };
}

export interface MeetingSession {
  getState(): SessionState;
  subscribe(listener: () => void): () => void;
  /** 订阅 onMeetingUpdated；返回的函数取消订阅，并使未完成请求的响应失效 */
  connect(): () => void;
  /** 以下操作返回是否被 Main 接受；不可用或已有操作进行中时不发请求，返回 false */
  create(title: string): Promise<boolean>;
  start(): Promise<boolean>;
  stop(): Promise<boolean>;
  /** 丢弃录音中或失败的录音，回到 created 以便重新录音 */
  discard(): Promise<boolean>;
}

const INITIAL: SessionState = {
  meeting: null,
  pending: null,
  error: null,
  revision: 0,
  warning: null,
  captureStopped: false,
};

export function createMeetingSession(api: SessionApi, recording: MeetingRecording): MeetingSession {
  let state = INITIAL;
  const listeners = new Set<() => void>();
  // 当前会议收到事件的次数；请求期间有更新事件时以事件为准，丢弃较旧的响应快照
  let eventSeq = 0;
  // 断开连接、切换会议后递增，使旧请求的响应失效
  let generation = 0;

  function set(patch: Partial<Omit<SessionState, 'revision'>>): void {
    const revision = 'meeting' in patch ? state.revision + 1 : state.revision;
    state = { ...state, ...patch, revision };
    for (const listener of [...listeners]) listener();
  }

  function onMeetingUpdated(meeting: MeetingDetail): void {
    // 只接受当前会议的事件，其他会议的更新和失败不影响本界面
    if (!state.meeting || meeting.id !== state.meeting.id) return;
    eventSeq += 1;
    set({ meeting });
  }

  async function run(
    action: SessionAction,
    request: () => Promise<Result<MeetingDetail>>,
    { switchesMeeting = false } = {},
  ): Promise<boolean> {
    if (!availableActions(state)[action]) return false;
    const token = generation;
    const seq = eventSeq;
    set({ pending: action, error: null, warning: null });
    let result: Result<MeetingDetail> | null;
    try {
      result = await request();
    } catch {
      result = null;
    }
    if (token !== generation) return false;
    if (!result || !result.ok) {
      set({ pending: null, error: result ? result.error.message : REQUEST_FAILED_MESSAGE });
      return false;
    }
    if (switchesMeeting) {
      generation += 1;
      eventSeq = 0;
      set({ pending: null, meeting: result.value, captureStopped: false });
    } else {
      set({ pending: null, ...(eventSeq === seq && { meeting: result.value }) });
    }
    return true;
  }

  // 断开期间可能错过事件，重新连接时向 Main 取一次最新快照
  async function refresh(): Promise<void> {
    const meeting = state.meeting;
    if (!meeting) return;
    const token = generation;
    const seq = eventSeq;
    try {
      const result = await api.meetings.get(meeting.id);
      if (token === generation && eventSeq === seq && result.ok) set({ meeting: result.value });
    } catch {
      /* 保留已知快照，后续事件会继续更新 */
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect() {
      const unsubscribe = api.events.onMeetingUpdated(onMeetingUpdated);
      void refresh();
      return () => {
        unsubscribe();
        generation += 1;
        recording.disconnect();
        if (state.pending) set({ pending: null });
      };
    },
    create: (title) => run('create', () => api.meetings.create(title), { switchesMeeting: true }),
    start() {
      const token = generation;
      return run('start', () => {
        set({ captureStopped: false });
        return recording.start(state.meeting!.id, {
          stopped: () => {
            if (token === generation) set({ captureStopped: true });
          },
          warning: (warning) => {
            if (token === generation) set({ warning });
          },
          error: (error) => {
            if (token === generation) set({ error });
          },
        });
      });
    },
    stop: () => run('stop', () => recording.stop(state.meeting!.id, state.meeting!.activeJobId!)),
    discard() {
      const meeting = state.meeting;
      const jobId = meeting?.activeJobId ?? meeting?.lastError?.jobId;
      if (!meeting || !jobId) return Promise.resolve(false);
      return run('discard', () => recording.discard(meeting.id, jobId));
    },
  };
}
