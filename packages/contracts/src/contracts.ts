// Renderer ↔ Main 的唯一契约。修改需经前端和后端各一人审核。

export type MeetingStatus =
  | 'created'
  | 'recording'
  | 'captured'
  | 'transcribing'
  | 'transcribed'
  | 'generating'
  | 'ready'
  | 'failed'
  | 'deleted';

export type JobKind = 'transcribing' | 'generating';

export type ErrorCode =
  // 通用
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL'
  // 音频（docs/platform-audio.md）
  | 'PERMISSION_DENIED'
  | 'DEVICE_NOT_FOUND'
  | 'CAPTURE_FAILED'
  | 'WRITE_FAILED'
  // 转写（docs/sidecar-protocol.md）
  | 'SIDECAR_START_FAILED'
  | 'SIDECAR_TIMEOUT'
  | 'SIDECAR_CRASHED'
  | 'SIDECAR_PROTOCOL_ERROR'
  | 'AUDIO_NOT_FOUND'
  | 'AUDIO_DECODE_FAILED'
  | 'MODEL_LOAD_FAILED'
  | 'TRANSCRIBE_FAILED'
  | 'INTERRUPTED'
  // 纪要生成
  | 'API_KEY_MISSING'
  | 'DEEPSEEK_UNAUTHORIZED'
  | 'DEEPSEEK_RATE_LIMITED'
  | 'DEEPSEEK_TIMEOUT'
  | 'DEEPSEEK_INVALID_RESPONSE'
  | 'DEEPSEEK_UNAVAILABLE';

export interface AppError {
  code: ErrorCode;
  /** 可直接展示给用户的信息，不含凭证、路径和会议正文 */
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export interface MeetingSummary {
  id: string;
  title: string;
  status: MeetingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingDetail extends MeetingSummary {
  retainAudio: boolean;
  hasAudio: boolean;
  keywords: string[];
  /** status 为 failed 时的失败阶段和原因 */
  lastError: (AppError & { kind: JobKind }) | null;
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface MeetingNote {
  summary: string;
  keyTopics: string[];
  decisions: Array<{
    text: string;
    timestampMs?: number;
  }>;
  openQuestions: string[];
  actionItems: Array<{
    task: string;
    owner: string | 'unspecified';
    dueDate: string | 'unspecified';
    timestampMs?: number;
  }>;
}

export interface NoteVersion {
  version: number;
  source: 'generated' | 'user';
  note: MeetingNote;
  createdAt: string;
}

export type TranscriptionLanguage = 'en' | 'zh' | 'auto';

export interface AppSettings {
  microphoneDeviceId: string | null;
  includeSystemAudio: boolean;
  transcriptionModel: string;
  transcriptionLanguage: TranscriptionLanguage;
  deepseekModel: string;
}

export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';

export interface CapturePermissions {
  microphone: PermissionState;
  /** macOS 屏幕录制权限，Windows 恒为 granted */
  screen: PermissionState;
}

export interface JobProgress {
  meetingId: string;
  kind: JobKind;
  /** 0-100 */
  percent: number;
}

export interface TurnnoteInvokeApi {
  app: {
    getInfo(): Promise<
      Result<{ name: 'Turnnote'; version: string; platform: 'darwin' | 'win32' | 'linux' }>
    >;
  };
  meetings: {
    /** 不含 deleted；query 匹配标题和转写文本 */
    list(query?: string): Promise<Result<MeetingSummary[]>>;
    get(meetingId: string): Promise<Result<MeetingDetail>>;
    create(title: string): Promise<Result<MeetingDetail>>;
    rename(meetingId: string, title: string): Promise<Result<MeetingDetail>>;
    setRetainAudio(meetingId: string, retain: boolean): Promise<Result<MeetingDetail>>;
    setKeywords(meetingId: string, keywords: string[]): Promise<Result<MeetingDetail>>;
    delete(meetingId: string): Promise<Result<null>>;
    /** Main 打开文件对话框；用户取消时返回 null */
    importAudio(): Promise<Result<MeetingDetail | null>>;
  };
  recording: {
    getPermissions(): Promise<Result<CapturePermissions>>;
    /** created → recording */
    start(meetingId: string): Promise<Result<MeetingDetail>>;
    /** 16kHz 单声道 Int16 PCM，约 1 秒一块 */
    appendChunk(meetingId: string, chunk: Int16Array): Promise<Result<null>>;
    /** recording → captured，Main 随后自动开始转写 */
    stop(meetingId: string): Promise<Result<MeetingDetail>>;
  };
  // 转写和生成是后台任务：调用立即返回，进度走 onJobProgress，完成走 onMeetingUpdated
  transcription: {
    /** captured / failed → transcribing，用于首次转写和重试 */
    start(meetingId: string): Promise<Result<MeetingDetail>>;
    /** transcribing → captured */
    cancel(meetingId: string): Promise<Result<MeetingDetail>>;
    getSegments(meetingId: string): Promise<Result<TranscriptSegment[]>>;
  };
  notes: {
    /** 由用户显式触发；transcribed / ready / failed → generating；使用 meeting.keywords 引导生成 */
    generate(meetingId: string): Promise<Result<MeetingDetail>>;
    getLatest(meetingId: string): Promise<Result<NoteVersion | null>>;
    saveEdit(meetingId: string, note: MeetingNote): Promise<Result<NoteVersion>>;
  };
  exports: {
    /** Main 打开保存对话框；用户取消时返回 saved: false */
    markdown(meetingId: string): Promise<Result<{ saved: boolean }>>;
  };
  settings: {
    get(): Promise<Result<AppSettings>>;
    update(patch: Partial<AppSettings>): Promise<Result<AppSettings>>;
    hasApiKey(): Promise<Result<boolean>>;
    setApiKey(apiKey: string): Promise<Result<null>>;
    clearApiKey(): Promise<Result<null>>;
  };
}

export interface TurnnoteEventApi {
  onMeetingUpdated(listener: (meeting: MeetingDetail) => void): () => void;
  onJobProgress(listener: (progress: JobProgress) => void): () => void;
}

/** 系统音频开关，Main 侧由 electron-audio-loopback 的 initMain() 注册，不返回 Result */
export interface TurnnoteLoopbackApi {
  /** 之后的 getDisplayMedia({ video: true, audio: true }) 返回系统音频 */
  enable(): Promise<void>;
  /** 恢复 getDisplayMedia 默认行为 */
  disable(): Promise<void>;
}

export type TurnnoteApi = TurnnoteInvokeApi & {
  events: TurnnoteEventApi;
  loopback: TurnnoteLoopbackApi;
};

type ChannelMap<T> = { [N in keyof T]: { [M in keyof T[N]]: string } };

/** IPC 白名单：每个 invoke 方法对应一个通道 */
export const invokeChannels = {
  app: { getInfo: 'app:get-info' },
  meetings: {
    list: 'meetings:list',
    get: 'meetings:get',
    create: 'meetings:create',
    rename: 'meetings:rename',
    setRetainAudio: 'meetings:set-retain-audio',
    setKeywords: 'meetings:set-keywords',
    delete: 'meetings:delete',
    importAudio: 'meetings:import-audio',
  },
  recording: {
    getPermissions: 'recording:get-permissions',
    start: 'recording:start',
    appendChunk: 'recording:append-chunk',
    stop: 'recording:stop',
  },
  transcription: {
    start: 'transcription:start',
    cancel: 'transcription:cancel',
    getSegments: 'transcription:get-segments',
  },
  notes: {
    generate: 'notes:generate',
    getLatest: 'notes:get-latest',
    saveEdit: 'notes:save-edit',
  },
  exports: { markdown: 'exports:markdown' },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
    hasApiKey: 'settings:has-api-key',
    setApiKey: 'settings:set-api-key',
    clearApiKey: 'settings:clear-api-key',
  },
} as const satisfies ChannelMap<TurnnoteInvokeApi>;

/** Main → Renderer 事件通道 */
export const eventChannels = {
  meetingUpdated: 'events:meeting-updated',
  jobProgress: 'events:job-progress',
} as const;

/** electron-audio-loopback 固定的通道名，不可修改 */
export const loopbackChannels = {
  enable: 'enable-loopback-audio',
  disable: 'disable-loopback-audio',
} as const satisfies Record<keyof TurnnoteLoopbackApi, string>;
