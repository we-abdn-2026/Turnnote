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

export type JobKind = 'recording' | 'transcribing' | 'generating';

export type CaptureErrorCode =
  'PERMISSION_DENIED' | 'DEVICE_NOT_FOUND' | 'CAPTURE_FAILED' | 'WRITE_FAILED';

export type ErrorCode =
  // 通用
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'CONFLICT'
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
  | 'MODEL_NOT_READY'
  | 'MODEL_DOWNLOAD_FAILED'
  | 'INSUFFICIENT_DISK_SPACE'
  | 'TRANSCRIBE_FAILED'
  | 'INTERRUPTED'
  // 纪要生成
  | 'API_KEY_MISSING'
  | 'DEEPSEEK_UNAUTHORIZED'
  | 'DEEPSEEK_RATE_LIMITED'
  | 'DEEPSEEK_TIMEOUT'
  | 'DEEPSEEK_INVALID_RESPONSE'
  | 'DEEPSEEK_UNAVAILABLE'
  | 'AI_REQUEST_REJECTED'
  | 'TRANSCRIPT_TOO_LONG';

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
  /**
   * 最新纪要写成之后，转写又追加了新内容（例如继续录音）：纪要没有包含这部分，建议重新生成。
   * 没有纪要时恒为 false。
   */
  noteStale: boolean;
}

export interface MeetingDetail extends MeetingSummary {
  retainAudio: boolean;
  hasAudio: boolean;
  keywords: string[];
  /** 当前任务标识；取消、失败、完成后为 null，过滤迟到进度事件 */
  activeJobId: string | null;
  /** status 为 failed 时的失败阶段和原因 */
  lastError: (AppError & { kind: JobKind; jobId: string }) | null;
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

/** 生成这版纪要的服务和模型；label 是生成当时的名称快照，服务商之后被改名或删除也不影响 */
export interface NoteOrigin {
  provider: string;
  label: string;
  model: string;
  /** 生成当时是否是本机服务：本机服务不会把会议内容发给任何第三方 */
  local: boolean;
}

export interface NoteVersion {
  version: number;
  source: 'generated' | 'user';
  note: MeetingNote;
  createdAt: string;
  /** 用户编辑的版本为 null */
  generatedBy: NoteOrigin | null;
}

export type TranscriptionLanguage = 'en' | 'zh' | 'auto';

export interface AppSettings {
  microphoneDeviceId: string | null;
  includeSystemAudio: boolean;
  transcriptionModel: string;
  transcriptionLanguage: TranscriptionLanguage;
  /** AI 纪要生成 provider，如 'deepseek'、'openai'、'ollama' */
  noteProvider: string;
  /** 对应 provider 的模型名，如 'deepseek-flash'、'gpt-4o' */
  noteModel: string;
}

/** Main 维护的 AI 服务商目录条目；界面所有服务商名称、可选项和数据去向都来自这里 */
export interface AiProviderInfo {
  id: string;
  label: string;
  /** 完整 base URL；请求发往 `${baseUrl}/chat/completions` */
  baseUrl: string;
  /** 请求实际发往的主机，用于告知用户数据去向 */
  host: string;
  /** 内置服务商不可删除、不可修改网址 */
  builtin: boolean;
  /** 本机服务：数据不会离开这台电脑 */
  local: boolean;
  needsKey: boolean;
  /** 已保存该服务商的 Key */
  hasKey: boolean;
  /** 可以直接使用：不需要 Key，或已保存 Key */
  ready: boolean;
  defaultModel: string;
  /** 常用模型，只用于输入提示；可以填写该服务商支持的任何模型名 */
  models: string[];
}

export interface CustomProviderInput {
  /** 编辑已有的自定义服务商时提供；新增时省略 */
  id?: string;
  label: string;
  baseUrl: string;
  needsKey: boolean;
}

export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';

export interface CapturePermissions {
  microphone: PermissionState;
  /** macOS 屏幕录制权限，Windows 恒为 granted */
  screen: PermissionState;
}

export type ModelState = 'ready' | 'missing' | 'downloading' | 'failed';

/** 本地转写模型（settings.transcriptionModel）的可用状态 */
export interface ModelStatus {
  model: string;
  state: ModelState;
  /** 下载总字节数；不在 Main 内置清单中的模型为 0 */
  totalBytes: number;
  /** downloading / failed 时已写入的字节数（含续传前已有部分），其余状态为 0 */
  downloadedBytes: number;
  /** 内置清单中的模型可以下载；用户自行放置的清单外模型只能使用，不能下载 */
  downloadable: boolean;
  /** state 为 failed 时的原因，其余状态为 null */
  error: AppError | null;
}

export interface JobProgress {
  meetingId: string;
  /** 重试使用新的 jobId；前端忽略已取消任务的迟到进度 */
  jobId: string;
  kind: Exclude<JobKind, 'recording'>;
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
    /** 用户取消返回 null；成功返回 captured，随后通过事件自动转写 */
    importAudio(): Promise<Result<MeetingDetail | null>>;
  };
  recording: {
    getPermissions(): Promise<Result<CapturePermissions>>;
    /** created → recording；失败录音须先 cancel 清理后才能重新录音 */
    start(meetingId: string): Promise<Result<MeetingDetail>>;
    /** 16kHz 单声道 Int16 PCM，约 1 秒一块 */
    appendChunk(meetingId: string, jobId: string, chunk: Int16Array): Promise<Result<null>>;
    /** 固定返回 captured 快照；随后 Main 自动开始转写，通过事件报告 transcribing */
    stop(meetingId: string, jobId: string): Promise<Result<MeetingDetail>>;
    /** 丢弃本次录音；清理文件后 recording → created */
    cancel(meetingId: string, jobId: string): Promise<Result<MeetingDetail>>;
    /** Renderer 采集失败；Main 映射安全错误信息并保留可恢复音频 */
    fail(meetingId: string, jobId: string, code: CaptureErrorCode): Promise<Result<MeetingDetail>>;
  };
  // 转写和生成是后台任务：调用立即返回，进度走 onJobProgress，完成走 onMeetingUpdated
  transcription: {
    /** captured / failed → transcribing，用于首次转写和重试 */
    start(meetingId: string): Promise<Result<MeetingDetail>>;
    /** transcribing → captured */
    cancel(meetingId: string, jobId: string): Promise<Result<MeetingDetail>>;
    getSegments(meetingId: string): Promise<Result<TranscriptSegment[]>>;
  };
  notes: {
    /** 由用户显式触发；transcribed / ready / failed → generating；使用 meeting.keywords 引导生成 */
    generate(meetingId: string): Promise<Result<MeetingDetail>>;
    getLatest(meetingId: string): Promise<Result<NoteVersion | null>>;
    /** 乐观锁：expectedVersion 为编辑时的版本，首次保存为 0；冲突不覆盖 */
    saveEdit(
      meetingId: string,
      note: MeetingNote,
      expectedVersion: number,
    ): Promise<Result<NoteVersion>>;
  };
  exports: {
    /** Main 打开保存对话框；用户取消时返回 saved: false */
    markdown(meetingId: string): Promise<Result<{ saved: boolean }>>;
  };
  // AI 服务商目录：内置 + 用户自定义的 OpenAI 兼容端点
  providers: {
    list(): Promise<Result<AiProviderInfo[]>>;
    /** 新增或修改自定义服务商（不能修改内置服务商）；网址按 parseProviderUrl 校验 */
    saveCustom(input: CustomProviderInput): Promise<Result<AiProviderInfo>>;
    /** 删除自定义服务商及其 Key；如果它正在使用，设置回到默认服务商 */
    removeCustom(providerId: string): Promise<Result<null>>;
    /** 用一次最小请求检查 Key、网址和模型是否可用；不发送任何会议内容 */
    test(providerId: string, model: string): Promise<Result<null>>;
  };
  // 模型管理：Main 启动时自动检查并下载；转写在模型就绪前不会启动（会议保持 captured）
  models: {
    getStatus(): Promise<Result<ModelStatus>>;
    /** missing / failed → downloading；已在下载或已就绪时直接返回当前状态 */
    download(): Promise<Result<ModelStatus>>;
    /** 取消下载并保留已下载部分，之后可续传；返回取消后的状态（missing） */
    cancelDownload(): Promise<Result<ModelStatus>>;
  };
  settings: {
    get(): Promise<Result<AppSettings>>;
    update(patch: Partial<AppSettings>): Promise<Result<AppSettings>>;
    /** 查询指定 provider 是否已存储 API Key */
    hasApiKey(provider: string): Promise<Result<boolean>>;
    /** 加密存储指定 provider 的 API Key */
    setApiKey(provider: string, apiKey: string): Promise<Result<null>>;
    /** 清除指定 provider 的 API Key */
    clearApiKey(provider: string): Promise<Result<null>>;
  };
}

export interface TurnnoteEventApi {
  onMeetingUpdated(listener: (meeting: MeetingDetail) => void): () => void;
  onJobProgress(listener: (progress: JobProgress) => void): () => void;
  onModelStatus(listener: (status: ModelStatus) => void): () => void;
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
    cancel: 'recording:cancel',
    fail: 'recording:fail',
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
  providers: {
    list: 'providers:list',
    saveCustom: 'providers:save-custom',
    removeCustom: 'providers:remove-custom',
    test: 'providers:test',
  },
  models: {
    getStatus: 'models:get-status',
    download: 'models:download',
    cancelDownload: 'models:cancel-download',
  },
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
  modelStatus: 'events:model-status',
} as const;

/** electron-audio-loopback 固定的通道名，不可修改 */
export const loopbackChannels = {
  enable: 'enable-loopback-audio',
  disable: 'disable-loopback-audio',
} as const satisfies Record<keyof TurnnoteLoopbackApi, string>;
