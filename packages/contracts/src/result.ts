import type { ErrorCode, ErrorRecovery, Result } from './contracts';

/** 安全错误目录；不拼接底层异常、路径、凭证或会议正文。 */
export const errorMessages: Record<ErrorCode, string> = {
  INVALID_INPUT: '请检查填写的内容。',
  NOT_FOUND: '找不到这场会议，它可能已在其他窗口被删除。',
  INVALID_STATE: '当前状态下不能执行这个操作。',
  CONFLICT: '纪要已在别处更新。请重新加载后再保存或生成。',
  NOT_IMPLEMENTED: '当前版本尚未提供这个功能。',
  INTERNAL: '出现了意外错误，请重试。',
  PERMISSION_DENIED: '录音权限被拒绝。请在系统设置中允许 Turnnote 录音。',
  DEVICE_NOT_FOUND: '所选音频设备不可用，请在音频来源中重新选择麦克风。',
  CAPTURE_FAILED: '音频采集失败，可恢复的音频已保留。',
  WRITE_FAILED: '音频文件无法写入或删除，请检查磁盘权限和剩余空间。',
  SIDECAR_START_FAILED: '本地转写进程无法启动，请重新打开应用后重试。',
  SIDECAR_TIMEOUT: '本地转写长时间没有响应，可以重试。',
  SIDECAR_CRASHED: '本地转写进程意外退出。',
  SIDECAR_PROTOCOL_ERROR: '本地转写进程返回了无效结果。',
  AUDIO_NOT_FOUND: '这场会议的音频不可用。',
  AUDIO_DECODE_FAILED: '这场会议的音频无法解码。',
  MODEL_LOAD_FAILED: '转写模型无法加载，请检查本地模型文件。',
  MODEL_NOT_READY: '转写模型还没有准备好，下载完成后会自动开始转写。',
  MODEL_DOWNLOAD_FAILED: '转写模型下载失败，请检查网络后重试。',
  INSUFFICIENT_DISK_SPACE: '磁盘剩余空间不足，无法下载转写模型。请清理空间后重试。',
  TRANSCRIBE_FAILED: '转写失败，音频已保留，可以重试。',
  INTERRUPTED: '处理被中断，已保存的数据都还在。',
  AI_PROVIDER_NOT_CONFIGURED: '所选 AI 服务未配置或已不可用，请在设置中重新选择服务商。',
  AI_PAYMENT_REQUIRED: '所选 AI 服务的额度不足，请检查服务账户的余额或账单。',
  API_KEY_MISSING: '请先在设置中填写所选 AI 服务的 API Key。',
  AI_UNAUTHORIZED: '所选 AI 服务拒绝了这个 API Key。',
  AI_RATE_LIMITED: '所选 AI 服务正在限流，请稍后重试。',
  AI_TIMEOUT: '请求所选 AI 服务超时。',
  AI_INVALID_RESPONSE: '所选 AI 服务返回的纪要格式无效，请检查模型是否支持结构化输出或更换模型。',
  AI_UNAVAILABLE: '所选 AI 服务暂时不可用。',
  AI_REQUEST_REJECTED: '所选 AI 服务拒绝了请求。请检查设置里的模型名和服务地址是否正确。',
  TRANSCRIPT_TOO_LONG: '转写过长，无法生成纪要。转写内容已保留。',
};

/** 每个错误都有明确的恢复类别；不能仅凭“失败”就重新发起有副作用的操作。 */
export const errorRecovery: Record<ErrorCode, ErrorRecovery> = {
  INVALID_INPUT: 'none',
  NOT_FOUND: 'reload',
  INVALID_STATE: 'reload',
  CONFLICT: 'reload',
  NOT_IMPLEMENTED: 'none',
  INTERNAL: 'retry',
  PERMISSION_DENIED: 'permissions',
  DEVICE_NOT_FOUND: 'none',
  CAPTURE_FAILED: 'retry',
  WRITE_FAILED: 'none',
  SIDECAR_START_FAILED: 'none',
  SIDECAR_TIMEOUT: 'retry',
  SIDECAR_CRASHED: 'retry',
  SIDECAR_PROTOCOL_ERROR: 'none',
  AUDIO_NOT_FOUND: 'none',
  AUDIO_DECODE_FAILED: 'none',
  MODEL_LOAD_FAILED: 'none',
  MODEL_NOT_READY: 'none',
  MODEL_DOWNLOAD_FAILED: 'retry',
  INSUFFICIENT_DISK_SPACE: 'none',
  TRANSCRIBE_FAILED: 'retry',
  INTERRUPTED: 'retry',
  API_KEY_MISSING: 'settings',
  AI_PROVIDER_NOT_CONFIGURED: 'settings',
  AI_PAYMENT_REQUIRED: 'settings',
  AI_UNAUTHORIZED: 'settings',
  AI_RATE_LIMITED: 'retry',
  AI_TIMEOUT: 'retry',
  AI_INVALID_RESPONSE: 'settings',
  AI_UNAVAILABLE: 'retry',
  AI_REQUEST_REJECTED: 'settings',
  TRANSCRIPT_TOO_LONG: 'none',
};

export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && Object.hasOwn(errorMessages, code);
}

/** 外部/历史错误只按已知错误码解释，绝不展示它们自带的 message。 */
export function errorInfo(code: unknown) {
  const known = isErrorCode(code) ? code : 'INTERNAL';
  return { code: known, message: errorMessages[known], recovery: errorRecovery[known] };
}

export class TurnnoteError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(errorMessages[code]);
    this.name = 'TurnnoteError';
  }
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail(code: ErrorCode): Result<never> {
  return { ok: false, error: { code, message: errorMessages[code] } };
}

export function requireCondition(condition: unknown, code: ErrorCode): asserts condition {
  if (!condition) throw new TurnnoteError(code);
}
