// 界面和 Main 使用同一份安全文案与恢复分类，不展示未知错误自带的文本。
import type { AppError, ErrorCode } from '@shared/contracts';
import { errorInfo } from '@shared/result';

export const REQUEST_FAILED_MESSAGE = '操作失败，请重试。';

export function describeError(
  error: Pick<AppError, 'code' | 'message'> | null | undefined,
): string {
  return error ? errorInfo(error.code).message : REQUEST_FAILED_MESSAGE;
}

export function describeCode(code: ErrorCode): string {
  return errorInfo(code).message;
}
