// DeepSeek Chat Completions 请求层：单次请求、超时、取消和稳定错误码映射。
// 只发送调用方给出的消息（转写文本和必要上下文），不读数据库、不发送音频、不写日志。
// 错误只携带错误码和 retryable 标记，不包含响应正文、API Key 或会议内容。
import type { ErrorCode } from '@shared/contracts';
import { z } from 'zod';
import type { ChatMessage } from './note-prompt';
import { NOTE_RESPONSE_FORMAT } from './note-prompt';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export const REQUEST_TIMEOUT_MS = 120_000;
/** 非 thinking 模式的默认上限；显式设置以免 JSON 被截断时不易察觉 */
export const MAX_OUTPUT_TOKENS = 8_192;

export type DeepSeekErrorCode = Extract<
  ErrorCode,
  | 'DEEPSEEK_UNAUTHORIZED'
  | 'DEEPSEEK_RATE_LIMITED'
  | 'DEEPSEEK_TIMEOUT'
  | 'DEEPSEEK_INVALID_RESPONSE'
  | 'DEEPSEEK_UNAVAILABLE'
  | 'INTERRUPTED'
  | 'INTERNAL'
>;

export class DeepSeekError extends Error {
  constructor(
    public readonly code: DeepSeekErrorCode,
    /** 超时、限流和服务端临时错误可重试；认证失败和无效请求不可重试 */
    public readonly retryable = false,
  ) {
    super(code);
    this.name = 'DeepSeekError';
  }
}

export interface DeepSeekOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** 测试注入；默认使用全局 fetch */
  fetch?: typeof fetch;
}

export interface ChatRequest {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
        finish_reason: z.string().nullable(),
      }),
    )
    .min(1),
});

function statusError(status: number): DeepSeekError {
  if (status === 401 || status === 403) return new DeepSeekError('DEEPSEEK_UNAUTHORIZED');
  if (status === 429) return new DeepSeekError('DEEPSEEK_RATE_LIMITED', true);
  if (status >= 500) return new DeepSeekError('DEEPSEEK_UNAVAILABLE', true);
  // 402 余额不足：服务可达但当前不可用，重试无意义
  if (status === 402) return new DeepSeekError('DEEPSEEK_UNAVAILABLE');
  // 400/422 是本地请求构造问题，不暴露为供应商故障
  return new DeepSeekError('INTERNAL');
}

/** 发送一次 JSON Output 请求，返回 assistant content；结构校验由 parseNoteResponse 完成 */
export async function requestChatCompletion(
  request: ChatRequest,
  options: DeepSeekOptions = {},
): Promise<string> {
  if (request.signal?.aborted) throw new DeepSeekError('INTERRUPTED');
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const failure = (): DeepSeekError =>
    request.signal?.aborted
      ? new DeepSeekError('INTERRUPTED')
      : timeout.aborted
        ? new DeepSeekError('DEEPSEEK_TIMEOUT', true)
        : new DeepSeekError('DEEPSEEK_UNAVAILABLE', true);

  let body: unknown;
  try {
    const response = await (options.fetch ?? fetch)(
      `${(options.baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${request.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          response_format: NOTE_RESPONSE_FORMAT,
          // 纪要不需要思维链；关闭后更快，且 content 不混入推理过程
          thinking: { type: 'disabled' },
          max_tokens: MAX_OUTPUT_TOKENS,
          stream: false,
        }),
        signal,
      },
    );
    if (!response.ok) {
      // 释放连接；错误正文可能回显请求内容，不读取也不保留
      await response.body?.cancel().catch(() => {});
      throw statusError(response.status);
    }
    const text = await response.text();
    try {
      body = JSON.parse(text);
    } catch {
      throw new DeepSeekError('DEEPSEEK_INVALID_RESPONSE');
    }
  } catch (error) {
    if (error instanceof DeepSeekError) throw error;
    throw failure();
  }

  const parsed = completionSchema.safeParse(body);
  if (!parsed.success) throw new DeepSeekError('DEEPSEEK_INVALID_RESPONSE');
  const [choice] = parsed.data.choices;
  if (choice.finish_reason === 'insufficient_system_resource') {
    throw new DeepSeekError('DEEPSEEK_UNAVAILABLE', true);
  }
  // length：输出被截断；content_filter 等：内容不完整。空 content 是 JSON Output 的已知偶发情况
  if (choice.finish_reason !== 'stop' || !choice.message.content?.trim()) {
    throw new DeepSeekError('DEEPSEEK_INVALID_RESPONSE');
  }
  return choice.message.content;
}
