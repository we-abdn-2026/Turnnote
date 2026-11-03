// 界面以中文为主：按稳定错误码映射固定文案，不展示 Main 原文以外的底层细节。
// 未知错误码回退到 Main 的安全信息，Promise 拒绝统一使用通用文案。
import type { AppError, ErrorCode } from '@shared/contracts';

const MESSAGES: Record<ErrorCode, string> = {
  INVALID_INPUT: '请检查填写的内容。',
  NOT_FOUND: '找不到这场会议，它可能已在其他窗口被删除。',
  INVALID_STATE: '当前状态下不能执行这个操作。',
  CONFLICT: '纪要已在别处更新。请重新加载后再保存或生成。',
  NOT_IMPLEMENTED: '当前版本尚未提供这个功能。',
  INTERNAL: '出现了意外错误，请重试。',
  PERMISSION_DENIED: '录音权限被拒绝。请在系统设置中允许 Turnnote 录音。',
  DEVICE_NOT_FOUND: '所选音频设备不可用。',
  CAPTURE_FAILED: '音频采集失败，可恢复的音频已保留。',
  WRITE_FAILED: '音频文件无法写入或删除，请检查磁盘权限和剩余空间。',
  SIDECAR_START_FAILED: '本地转写进程无法启动。',
  SIDECAR_TIMEOUT: '本地转写长时间没有响应，可以重试。',
  SIDECAR_CRASHED: '本地转写进程意外退出。',
  SIDECAR_PROTOCOL_ERROR: '本地转写进程返回了无效结果。',
  AUDIO_NOT_FOUND: '这场会议的音频不可用。',
  AUDIO_DECODE_FAILED: '这场会议的音频无法解码。',
  MODEL_LOAD_FAILED: '转写模型无法加载。',
  TRANSCRIBE_FAILED: '转写失败，音频已保留，可以重试。',
  INTERRUPTED: '处理被中断，已保存的数据都还在。',
  API_KEY_MISSING: '请先在设置中填写所选 AI 服务的 API Key。',
  DEEPSEEK_UNAUTHORIZED: '所选 AI 服务拒绝了这个 API Key。',
  DEEPSEEK_RATE_LIMITED: '所选 AI 服务正在限流，请稍后重试。',
  DEEPSEEK_TIMEOUT: '请求所选 AI 服务超时。',
  DEEPSEEK_INVALID_RESPONSE: '所选 AI 服务返回的纪要格式无效。',
  DEEPSEEK_UNAVAILABLE: '所选 AI 服务暂时不可用。',
  TRANSCRIPT_TOO_LONG: '转写过长，无法生成纪要。转写内容已保留。',
};

// 底层异常可能包含路径或传输细节，界面只展示通用信息
export const REQUEST_FAILED_MESSAGE = '操作失败，请重试。';

export function describeError(
  error: Pick<AppError, 'code' | 'message'> | null | undefined,
): string {
  if (!error) return REQUEST_FAILED_MESSAGE;
  return MESSAGES[error.code] ?? error.message;
}

export function describeCode(code: ErrorCode): string {
  return MESSAGES[code];
}
