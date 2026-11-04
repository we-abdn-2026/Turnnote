// 录音工作区的会议会话：会议状态只来自 Main 的响应快照和 onMeetingUpdated 事件，
// Renderer 不自行推导业务终态。不依赖 React，便于单元测试。
import { canCancelRecording, canEditNote, canStartJob } from '@shared/lifecycle';
import type {
  JobProgress,
  MeetingDetail,
  MeetingNote,
  NoteVersion,
  Result,
  TranscriptSegment,
  TurnnoteApi,
} from '@shared/contracts';
import { REQUEST_FAILED_MESSAGE, describeError } from '../ui/errors';

type SessionApi = Pick<TurnnoteApi, 'meetings' | 'transcription' | 'notes' | 'events' | 'exports'>;
type ProcessingKind = JobProgress['kind'];

export type TranscriptLoadState = 'idle' | 'loading' | 'ready' | 'error';

export type NoteLoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface MeetingRecording {
  start(
    id: string,
    notify: { warning(message: string): void; error(message: string): void; stopped(): void },
  ): Promise<Result<MeetingDetail>>;
  stop(id: string, jobId: string): Promise<Result<MeetingDetail>>;
  discard(id: string, jobId: string): Promise<Result<MeetingDetail>>;
  disconnect(): void;
}

/** 录音主流程的操作；availableActions 只覆盖这些，保持录音按钮的判定简单 */
export type CoreAction = 'create' | 'start' | 'stop' | 'discard' | 'keywords' | 'generate';

/** 会议管理和后续处理的操作 */
export type MeetingAction =
  | 'open'
  | 'import'
  | 'rename'
  | 'delete'
  | 'retainAudio'
  | 'export'
  | 'transcribe'
  | 'cancelTranscription';

export type SessionAction = CoreAction | MeetingAction;

export interface SessionState {
  meeting: MeetingDetail | null;
  /** 正在等待 Main 响应的操作；期间拒绝新的操作，防止重复创建/启动/停止 */
  pending: SessionAction | null;
  /** 最近一次操作失败的安全信息；下一次操作开始时清除 */
  error: string | null;
  /** 最近一次操作成功后的简短确认，例如导出完成；下一次操作开始时清除 */
  notice: string | null;
  /** 每次发出受保护的操作时递增；界面确认绑定打开时的值，之后任何操作开始都会使其失效 */
  attempt: number;
  /** 每次替换会议快照时递增；updatedAt 可能在同一毫秒内重复，不能用来区分快照 */
  revision: number;
  warning: string | null;
  /** 媒体已关闭，Main 可能仍在提交音频；保存等待不冒充正在采集 */
  captureStopped: boolean;
  /** 当前转写/生成任务的进度 */
  jobProgress: JobProgress | null;
  /** 从转写回到 captured 表示用户取消了转写 */
  cancelledKind: ProcessingKind | null;
  /** 当前会议的已提交转写片段；切换会议时同步清空，避免短暂显示上一场内容。 */
  transcriptSegments: TranscriptSegment[];
  transcriptState: TranscriptLoadState;
  note: NoteVersion | null;
  noteState: NoteLoadState;
}

export { REQUEST_FAILED_MESSAGE };
export const TRANSCRIPT_LOAD_FAILED_MESSAGE = '转写内容加载失败，请重试。';
export const NOTE_LOAD_FAILED_MESSAGE = '纪要加载失败，请重试。';
export const EXPORTED_MESSAGE = 'Markdown 已导出。';

/** Main 录音任务仍活动且 Renderer 尚未关闭媒体；保存等待不冒充正在采集 */
export function isRecording(state: SessionState): boolean {
  return state.meeting?.status === 'recording' && !state.captureStopped;
}

/** 与 Main/mock 共用 lifecycle 条件，界面按此启用按钮 */
export function availableActions(state: SessionState): Record<CoreAction, boolean> {
  const { meeting, pending } = state;
  const idle = pending === null;
  return {
    create: idle && meeting?.status !== 'recording',
    start: idle && !!meeting && canStartJob(meeting, 'recording', false),
    stop: idle && meeting?.status === 'recording' && !!meeting.activeJobId,
    discard: idle && !!meeting && canCancelRecording(meeting),
    keywords:
      idle &&
      !!meeting &&
      (['created', 'captured', 'transcribed', 'ready'].includes(meeting.status) ||
        (meeting.status === 'failed' && meeting.lastError?.kind === 'generating')),
    generate:
      idle && !!meeting && canStartJob(meeting, 'generating', state.transcriptSegments.length > 0),
  };
}

/** 会议管理操作的可用条件；状态不满足时 Main 仍会再次校验 */
export function meetingActions(state: SessionState): Record<MeetingAction, boolean> {
  const { meeting, pending } = state;
  const idle = pending === null;
  const live = !!meeting && meeting.status !== 'deleted';
  const capturing = meeting?.status === 'recording';
  return {
    open: idle && !capturing,
    import: idle && !capturing,
    rename: idle && live,
    // 录音中先停止再删除，避免与正在写入的音频争用
    delete: idle && live && !capturing,
    retainAudio: idle && live,
    export: idle && live && state.note !== null,
    transcribe: idle && live && canStartJob(meeting, 'transcribing', false),
    cancelTranscription: idle && meeting?.status === 'transcribing' && !!meeting.activeJobId,
  };
}

/** 纪要编辑与 Main 的 canEditNote 同一条件 */
export function canEditMeetingNote(state: SessionState): boolean {
  return !!state.meeting && canEditNote(state.meeting);
}

export type SaveNoteOutcome =
  { ok: true; version: NoteVersion } | { ok: false; conflict: boolean; message: string };

export interface MeetingSession {
  getState(): SessionState;
  subscribe(listener: () => void): () => void;
  /** 订阅 onMeetingUpdated；返回的函数取消订阅，并使未完成请求的响应失效 */
  connect(): () => void;
  /** 以下操作返回是否被 Main 接受；不可用或已有操作进行中时不发请求，返回 false */
  create(title: string): Promise<boolean>;
  start(): Promise<boolean>;
  stop(): Promise<boolean>;
  /** 丢弃录音中或失败的录音这一段；会议回到录音前的状态（第一段则回到 created），已有转写和纪要不受影响 */
  discard(): Promise<boolean>;
  /** 保存会议关键词；成功结果以 Main 返回的会议快照为准。 */
  saveKeywords(keywords: string[]): Promise<boolean>;
  /** 重新读取当前会议的已提交转写片段。 */
  reloadTranscript(): Promise<void>;
  /** 用户确认发送内容后启动纪要生成；已有请求进行中时返回 false。 */
  generate(): Promise<boolean>;
  /** 重新读取当前会议的最新纪要。 */
  reloadNote(): Promise<void>;
  /** 从会议库打开已有会议；录音中拒绝切换 */
  open(meetingId: string): Promise<boolean>;
  /** Main 打开文件选择；用户取消时不切换会议 */
  importAudio(): Promise<boolean>;
  rename(title: string): Promise<boolean>;
  /** 删除当前会议；成功后工作区回到未选择状态 */
  delete(): Promise<boolean>;
  setRetainAudio(retain: boolean): Promise<boolean>;
  /** 以编辑开始时的版本号保存；冲突不覆盖，由编辑器保留草稿 */
  saveNote(note: MeetingNote, expectedVersion: number): Promise<SaveNoteOutcome>;
  exportMarkdown(): Promise<boolean>;
  retryTranscription(): Promise<boolean>;
  cancelTranscription(): Promise<boolean>;
  /** 关闭已被删除的会议，回到未选择状态 */
  close(): void;
  /** 接收所有会议的更新事件，供会议库刷新；不影响当前会议 */
  watchMeetings(listener: (meeting: MeetingDetail) => void): () => void;
}

const INITIAL: SessionState = {
  meeting: null,
  pending: null,
  error: null,
  notice: null,
  attempt: 0,
  revision: 0,
  warning: null,
  captureStopped: false,
  jobProgress: null,
  cancelledKind: null,
  transcriptSegments: [],
  transcriptState: 'idle',
  note: null,
  noteState: 'idle',
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
  let noteRequest = 0;
  const watchers = new Set<(meeting: MeetingDetail) => void>();

  function set(patch: Partial<Omit<SessionState, 'revision'>>): void {
    const revision = 'meeting' in patch ? state.revision + 1 : state.revision;
    state = { ...state, ...patch, revision };
    for (const listener of [...listeners]) listener();
  }

  function allowed(action: SessionAction): boolean {
    return { ...availableActions(state), ...meetingActions(state) }[action];
  }

  function forward(meeting: MeetingDetail): void {
    for (const watcher of [...watchers]) {
      try {
        watcher(meeting);
      } catch {
        /* 会议库的异常不影响当前会议 */
      }
    }
  }

  /** 切换到另一场会议：旧会议的请求和事件全部失效，内容先清空再加载 */
  function switchTo(meeting: MeetingDetail): void {
    generation += 1;
    eventSeq = 0;
    set({
      pending: null,
      meeting,
      captureStopped: false,
      jobProgress: null,
      cancelledKind: null,
      transcriptSegments: [],
      transcriptState: 'loading',
      note: null,
      noteState: 'loading',
    });
    void loadTranscript(meeting.id);
    void loadNote(meeting.id);
  }

  function clear(patch: Partial<Omit<SessionState, 'revision'>> = {}): void {
    generation += 1;
    eventSeq = 0;
    set({
      meeting: null,
      pending: null,
      captureStopped: false,
      jobProgress: null,
      cancelledKind: null,
      transcriptSegments: [],
      transcriptState: 'idle',
      note: null,
      noteState: 'idle',
      ...patch,
    });
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
    // 已删除的会议没有可读取的内容；界面保留快照并提示关闭
    if (meeting.status === 'deleted') return;
    void loadTranscript(meeting.id);
    void loadNote(meeting.id);
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

  async function loadNote(meetingId: string): Promise<void> {
    const token = generation;
    const request = ++noteRequest;
    set({ noteState: 'loading' });

    let result: Result<NoteVersion | null> | null;
    try {
      result = await api.notes.getLatest(meetingId);
    } catch {
      result = null;
    }

    if (token !== generation || request !== noteRequest || state.meeting?.id !== meetingId) return;

    if (!result || !result.ok) {
      set({ noteState: 'error' });
      return;
    }

    set({ note: result.value, noteState: 'ready' });
  }

  /**
   * 发出一次受 pending 保护的请求。失败时写入安全错误并返回 null；成功时 pending 仍保持，
   * 由调用方在同一次 set 中清除，避免中间帧重新启用按钮。fresh 表示期间没有更新事件。
   */
  async function perform<T>(
    action: SessionAction,
    request: () => Promise<Result<T>>,
  ): Promise<{ value: T; fresh: boolean } | null> {
    if (!allowed(action)) return null;
    const token = generation;
    const seq = eventSeq;
    set({ pending: action, error: null, warning: null, notice: null, attempt: state.attempt + 1 });
    let result: Result<T> | null;
    try {
      result = await request();
    } catch {
      result = null;
    }
    if (token !== generation) return null;
    if (!result || !result.ok) {
      set({ pending: null, error: result ? describeError(result.error) : REQUEST_FAILED_MESSAGE });
      return null;
    }
    return { value: result.value, fresh: eventSeq === seq };
  }

  async function run(
    action: SessionAction,
    request: () => Promise<Result<MeetingDetail>>,
    { switchesMeeting = false } = {},
  ): Promise<boolean> {
    const outcome = await perform(action, request);
    if (!outcome) return false;
    if (switchesMeeting) {
      switchTo(outcome.value);
    } else {
      set({ pending: null, ...(outcome.fresh && { meeting: outcome.value }) });
      if (outcome.fresh) {
        void loadTranscript(outcome.value.id);
        void loadNote(outcome.value.id);
      }
    }
    return true;
  }

  /** 对当前会议执行一次快照操作；没有会议时不发请求 */
  function onCurrent(
    action: SessionAction,
    request: (meeting: MeetingDetail) => Promise<Result<MeetingDetail>>,
  ): Promise<boolean> {
    const meeting = state.meeting;
    if (!meeting) return Promise.resolve(false);
    return run(action, () => request(meeting));
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
        void loadNote(result.value.id);
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
      // 只建立一份 Main 事件订阅：当前会议和会议库共用，避免重复的 IPC 监听
      const unsubscribeMeeting = api.events.onMeetingUpdated((meeting) => {
        if (!isConnected()) return;
        onMeetingUpdated(meeting);
        forward(meeting);
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
    saveKeywords(keywords) {
      const current = state.meeting;
      if (!current) return Promise.resolve(false);

      return run('keywords', () => api.meetings.setKeywords(current.id, keywords));
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
    async reloadNote() {
      const meeting = state.meeting;
      if (meeting) await loadNote(meeting.id);
    },
    async open(meetingId) {
      if (state.meeting?.id === meetingId && state.meeting.status !== 'deleted') return true;
      const outcome = await perform('open', () => api.meetings.get(meetingId));
      if (!outcome) return false;
      switchTo(outcome.value);
      return true;
    },
    async importAudio() {
      const outcome = await perform('import', () => api.meetings.importAudio());
      if (!outcome) return false;
      // 用户在文件选择中取消：保持当前会议
      if (!outcome.value) {
        set({ pending: null });
        return false;
      }
      switchTo(outcome.value);
      return true;
    },
    rename: (title) => onCurrent('rename', (meeting) => api.meetings.rename(meeting.id, title)),
    async delete() {
      const meeting = state.meeting;
      if (!meeting) return false;
      const outcome = await perform('delete', () => api.meetings.delete(meeting.id));
      if (!outcome) return false;
      clear();
      return true;
    },
    setRetainAudio: (retain) =>
      onCurrent('retainAudio', (meeting) => api.meetings.setRetainAudio(meeting.id, retain)),
    async saveNote(note, expectedVersion) {
      const meeting = state.meeting;
      if (!meeting || !canEditNote(meeting)) {
        return {
          ok: false,
          conflict: false,
          message: describeError({ code: 'INVALID_STATE', message: '' }),
        };
      }
      const token = generation;
      let result: Result<NoteVersion> | null;
      try {
        result = await api.notes.saveEdit(meeting.id, note, expectedVersion);
      } catch {
        result = null;
      }
      if (token !== generation || state.meeting?.id !== meeting.id) {
        return { ok: false, conflict: false, message: REQUEST_FAILED_MESSAGE };
      }
      if (!result) return { ok: false, conflict: false, message: REQUEST_FAILED_MESSAGE };
      if (!result.ok) {
        return {
          ok: false,
          conflict: result.error.code === 'CONFLICT',
          message: describeError(result.error),
        };
      }
      // 先显示刚保存的版本；随后的会议事件会再读取一次最新纪要
      noteRequest += 1;
      set({ note: result.value, noteState: 'ready' });
      return { ok: true, version: result.value };
    },
    async exportMarkdown() {
      const meeting = state.meeting;
      if (!meeting) return false;
      const outcome = await perform('export', () => api.exports.markdown(meeting.id));
      if (!outcome) return false;
      set({ pending: null, notice: outcome.value.saved ? EXPORTED_MESSAGE : null });
      return outcome.value.saved;
    },
    retryTranscription: () =>
      onCurrent('transcribe', (meeting) => api.transcription.start(meeting.id)),
    cancelTranscription: () =>
      onCurrent('cancelTranscription', (meeting) =>
        api.transcription.cancel(meeting.id, meeting.activeJobId!),
      ),
    close() {
      if (state.meeting?.status === 'recording' || state.pending) return;
      clear({ error: null, warning: null, notice: null });
    },
    watchMeetings(listener) {
      watchers.add(listener);
      return () => watchers.delete(listener);
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
  // 失败的录音被丢弃后，会议回到录音前的状态：第一段回到 created，追加的一段回到 captured /
  // transcribed / ready（取决于是否有待转写的音频、转写和纪要）
  if (
    current.status === 'failed' &&
    current.lastError?.kind === 'recording' &&
    ['created', 'captured', 'transcribed', 'ready'].includes(next.status)
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
