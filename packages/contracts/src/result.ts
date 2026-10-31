import type { ErrorCode, Result } from './contracts';

/** 安全错误目录；不拼接底层异常、路径、凭证或会议正文。 */
export const errorMessages: Record<ErrorCode, string> = {
  INVALID_INPUT: 'Please check the supplied information.',
  NOT_FOUND: 'Meeting not found.',
  INVALID_STATE: 'This operation is not available in the current state.',
  CONFLICT: 'The note has changed. Reload it before saving or generating again.',
  NOT_IMPLEMENTED: 'This feature is not available yet.',
  INTERNAL: 'Something went wrong. Please try again.',
  PERMISSION_DENIED: 'Audio capture permission was denied.',
  DEVICE_NOT_FOUND: 'The selected audio device is unavailable.',
  CAPTURE_FAILED: 'Audio capture failed. Recoverable audio has been kept.',
  WRITE_FAILED: 'The audio file could not be written or removed. Please check disk access.',
  SIDECAR_START_FAILED: 'The transcription process could not start.',
  SIDECAR_TIMEOUT: 'Transcription stopped responding. You can retry.',
  SIDECAR_CRASHED: 'The transcription process exited unexpectedly.',
  SIDECAR_PROTOCOL_ERROR: 'The transcription process returned an invalid response.',
  AUDIO_NOT_FOUND: 'The meeting audio is unavailable.',
  AUDIO_DECODE_FAILED: 'The meeting audio could not be decoded.',
  MODEL_LOAD_FAILED: 'The transcription model could not be loaded.',
  TRANSCRIBE_FAILED: 'Transcription failed. The audio has been kept for retry.',
  INTERRUPTED: 'Processing was interrupted. Your saved data has been kept.',
  API_KEY_MISSING: 'Add a DeepSeek API key in Settings first.',
  DEEPSEEK_UNAUTHORIZED: 'DeepSeek rejected the API key.',
  DEEPSEEK_RATE_LIMITED: 'DeepSeek is rate limiting requests. Please retry later.',
  DEEPSEEK_TIMEOUT: 'The DeepSeek request timed out.',
  DEEPSEEK_INVALID_RESPONSE: 'DeepSeek returned an invalid meeting note.',
  DEEPSEEK_UNAVAILABLE: 'DeepSeek is currently unavailable.',
  TRANSCRIPT_TOO_LONG: 'The transcript is too long to summarize. Your transcript has been kept.',
};

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
