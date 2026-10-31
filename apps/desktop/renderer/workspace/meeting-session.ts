// 录音工作区的会议会话：会议状态只来自 Main 的响应快照和 onMeetingUpdated 事件，
// Renderer 不自行推导业务终态。不依赖 React，便于单元测试。
import type {
  JobProgress,
  MeetingDetail,
  Result,
  TranscriptSegment,
  TurnnoteApi,
} from '@shared/contracts';
import { canCancelRecording, canStartJob } from '@shared/lifecycle';

type SessionApi = Pick<TurnnoteApi, 'meetings' | 'transcription' | 'notes' | 'events'>;
type ProcessingKind = JobProgress['kind'];

export type TranscriptLoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface MeetingRecording {
  start(
    id: string,
    notify: { warning(message: string): void; error(message: string): void; stopped(): void },
  ): Promise<Result<MeetingDetail>>;
  stop(id: string, jobId: string): Promise<Result<MeetingDetail>>;
  discard(id: string, jobId: string): Promise<Result<MeetingDetail>>;
  disconnect(): void;
}

export type SessionAction = 'create' | 'start' | 'stop' | 'discard' | 'generate';

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
  /** Latest progress for the active transcribing/generating job. */
  jobProgress: JobProgress | null;
  /** A transition back to captured means the active transcription was cancelled. */
  cancelledKind: ProcessingKind | null;
  /** 当前会议的已提交转写片段；切换会议时同步清空，避免短暂显示上一场内容。 */
  transcriptSegments: TranscriptSegment[];
  transcriptState: TranscriptLoadState;
}

// 底层异常可能包含路径或传输细节，界面只展示通用信息
export const REQUEST_FAILED_MESSAGE = '操作失败，请重试。';
export const TRANSCRIPT_LOAD_FAILED_MESSAGE = '转写内容加载失败，请重试。';

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
    generate:
      idle && !!meeting && canStartJob(meeting, 'generating', state.transcriptSegments.length > 0),
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
  /** 重新读取当前会议的已提交转写片段。 */
  reloadTranscript(): Promise<void>;
  /** 用户确认发送内容后启动纪要生成；已有请求进行中时返回 false。 */
  generate(): Promise<boolean>;
}

const INITIAL: SessionState = {
  meeting: null,
  pending: null,
  error: null,
  revision: 0,
  warning: null,
  captureStopped: false,
  jobProgress: null,
  cancelledKind: null,
  transcriptSegments: [],
  transcriptState: 'idle',
};

export function createMeetingSession(api: SessionApi, recording: MeetingRecording): MeetingSession {
  let state = INITIAL;
  const listeners = new Set<() => void>();
  const settledJobs = new Set<string>();
  // 当前会议收到事件的次数；请求期间有更新事件时以事件为准，丢弃较旧的响应快照
  let eventSeq = 0;
  // 断开连接、切换会议后递增，使旧请求的响应失效
  let generation = 0;
  let connection = 0;
  // 同一会议可能因连续状态事件并发读取片段，只接受最后一次请求。
  let transcriptRequest = 0;

  function set(patch: Partial<Omit<SessionState, 'revision'>>): void {
    const revision = 'meeting' in patch ? state.revision + 1 : state.revision;
    state = { ...state, ...patch, revision };
    for (const listener of [...listeners]) listener();
  }

  function onMeetingUpdated(meeting: MeetingDetail): void {
    // 只接受当前会议的事件，其他会议的更新和失败不影响本界面
    const current = state.meeting;
    if (!current || meeting.id !== current.id || isStaleMeeting(current, meeting, settledJobs))
      return;
    const activeJobId = current.activeJobId;
    if (activeJobId && meeting.activeJobId !== activeJobId) settledJobs.add(activeJobId);
    const cancelledKind =
      current.status === 'transcribing' && meeting.status === 'captured' && !meeting.activeJobId
        ? 'transcribing'
        : meeting.status === 'captured'
          ? state.cancelledKind
          : null;
    eventSeq += 1;
    const jobProgress =
      state.jobProgress?.jobId === meeting.activeJobId &&
      isProcessing(meeting.status, state.jobProgress.kind)
        ? state.jobProgress
        : null;
    set({ meeting, jobProgress, cancelledKind });
    void loadTranscript(meeting.id);
  }

  function onJobProgress(progress: JobProgress): void {
    const meeting = state.meeting;
    if (
      !meeting ||
      progress.meetingId !== meeting.id ||
      progress.jobId !== meeting.activeJobId ||
      !isProcessing(meeting.status, progress.kind) ||
      !Number.isFinite(progress.percent)
    )
      return;
    const percent = Math.min(100, Math.max(0, progress.percent));
    const previous = state.jobProgress;
    if (
      previous?.jobId === progress.jobId &&
      previous.kind === progress.kind &&
      percent < previous.percent
    )
      return;
    set({ jobProgress: { ...progress, percent }, cancelledKind: null });
  }

  async function loadTranscript(meetingId: string): Promise<void> {
    const token = generation;
    const request = ++transcriptRequest;
    set({ transcriptState: 'loading' });
    let result: Result<TranscriptSegment[]> | null;
    try {
      result = await api.transcription.getSegments(meetingId);
    } catch {
      result = null;
    }
    if (token !== generation || request !== transcriptRequest || state.meeting?.id !== meetingId)
      return;
    if (!result || !result.ok) {
      set({ transcriptState: 'error' });
      return;
    }
    set({ transcriptSegments: result.value, transcriptState: 'ready' });
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
      set({
        pending: null,
        meeting: result.value,
        captureStopped: false,
        jobProgress: null,
        cancelledKind: null,
        transcriptSegments: [],
        transcriptState: 'loading',
      });
      void loadTranscript(result.value.id);
    } else {
      const acceptsResponse = eventSeq === seq;
      set({ pending: null, ...(acceptsResponse && { meeting: result.value }) });
      if (acceptsResponse) void loadTranscript(result.value.id);
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
      if (token === generation && eventSeq === seq && result.ok) {
        set({
          meeting: result.value,
          jobProgress:
            state.jobProgress?.jobId === result.value.activeJobId &&
            isProcessing(result.value.status, state.jobProgress.kind)
              ? state.jobProgress
              : null,
        });
        void loadTranscript(result.value.id);
      }
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
      const token = ++connection;
      const isConnected = (): boolean => token === connection;
      const unsubscribeMeeting = api.events.onMeetingUpdated((meeting) => {
        if (isConnected()) onMeetingUpdated(meeting);
      });
      const unsubscribeProgress = api.events.onJobProgress((progress) => {
        if (isConnected()) onJobProgress(progress);
      });
      void refresh();
      return () => {
        const wasCurrentConnection = isConnected();
        if (wasCurrentConnection) connection += 1;
        unsubscribeMeeting();
        unsubscribeProgress();
        if (wasCurrentConnection) {
          generation += 1;
          recording.disconnect();
          if (state.pending) set({ pending: null });
        }
      };
    },
    create: (title) => run('create', () => api.meetings.create(title), { switchesMeeting: true }),
    generate() {
      const meeting = state.meeting;
      if (!meeting) return Promise.resolve(false);
      return run('generate', () => api.notes.generate(meeting.id));
    },
    start() {
      const token = generation;
      return run('start', () => {
        set({ captureStopped: false, jobProgress: null, cancelledKind: null });
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
    async reloadTranscript() {
      const meeting = state.meeting;
      if (meeting) await loadTranscript(meeting.id);
    },
  };
}

function isProcessing(status: MeetingDetail['status'], kind: ProcessingKind): boolean {
  return (
    (kind === 'transcribing' && status === 'transcribing') ||
    (kind === 'generating' && status === 'generating')
  );
}

const STATUS_ORDER: Record<MeetingDetail['status'], number> = {
  created: 0,
  recording: 1,
  captured: 2,
  transcribing: 3,
  transcribed: 4,
  generating: 5,
  ready: 6,
  failed: 7,
  deleted: 8,
};

function isStaleMeeting(
  current: MeetingDetail,
  next: MeetingDetail,
  settledJobs: Set<string>,
): boolean {
  const nextJobId =
    next.activeJobId ?? (next.status === 'failed' ? next.lastError?.jobId : undefined);
  if (nextJobId && settledJobs.has(nextJobId)) return true;
  // Failure snapshots carry the completed job identity in lastError. A failure from an older
  // attempt must not terminate the active retry, even when both snapshots share updatedAt.
  if (
    current.activeJobId &&
    next.status === 'failed' &&
    next.lastError?.jobId !== current.activeJobId
  )
    return true;
  const currentTime = Date.parse(current.updatedAt);
  const nextTime = Date.parse(next.updatedAt);
  if (Number.isFinite(currentTime) && Number.isFinite(nextTime) && nextTime < currentTime)
    return true;

  // A different active job is a retry or a later stage started after the current one settled.
  if (next.activeJobId && next.activeJobId !== current.activeJobId) return false;
  if (next.status === 'deleted') return false;

  if (STATUS_ORDER[next.status] >= STATUS_ORDER[current.status]) return false;
  // These are the supported recovery/cancellation transitions without a new active job.
  if (current.status === 'recording' && next.status === 'created') return false;
  if (current.status === 'transcribing' && next.status === 'captured') return false;
  if (
    current.status === 'failed' &&
    current.lastError?.kind === 'recording' &&
    next.status === 'created'
  )
    return false;
  if (
    current.status === 'failed' &&
    current.lastError?.kind === 'generating' &&
    next.status === 'ready'
  )
    return false;
  return true;
}
