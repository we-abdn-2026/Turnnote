// AI Chat Completions 请求层：OpenAI-compatible API，支持 DeepSeek、OpenAI 和任何兼容端点。
// 按 provider 查表 baseUrl；新增 provider 只需在 PROVIDER_BASE_URLS 加一行。
// 不读数据库、不发送音频、不写日志。错误只携带错误码，不包含响应正文、API Key 或会议内容。
import type { ErrorCode } from '@shared/contracts';
import { z } from 'zod';
import type { ChatMessage } from './note-prompt';
import { NOTE_RESPONSE_FORMAT } from './note-prompt';

/** provider → base URL 映射表；自定义端点（如 Ollama）通过 baseUrl 参数传入 */
export const PROVIDER_BASE_URLS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/v1',
  openai: 'https://api.openai.com/v1',
};

/** 向后兼容 */
export const DEEPSEEK_BASE_URL = PROVIDER_BASE_URLS.deepseek;
export const REQUEST_TIMEOUT_MS = 120_000;
/** 非 thinking 模式的默认上限；显式设置以免 JSON 被截断时不易察觉 */
export const MAX_OUTPUT_TOKENS = 8_192;

export type AiErrorCode = Extract<
  ErrorCode,
  | 'DEEPSEEK_UNAUTHORIZED'
  | 'DEEPSEEK_RATE_LIMITED'
  | 'DEEPSEEK_TIMEOUT'
  | 'DEEPSEEK_INVALID_RESPONSE'
  | 'DEEPSEEK_UNAVAILABLE'
  | 'INTERRUPTED'
  | 'INTERNAL'
>;

/** @deprecated 别名保持向后兼容 */
export type DeepSeekErrorCode = AiErrorCode;

export class DeepSeekError extends Error {
  constructor(
    public readonly code: AiErrorCode,
    /** 超时、限流和服务端临时错误可重试；认证失败和无效请求不可重试 */
    public readonly retryable = false,
  ) {
    super(code);
    this.name = 'DeepSeekError';
  }
}

export interface AiProviderOptions {
  /** provider 名，如 'deepseek'、'openai'、'ollama'；用于查表 baseUrl */
  provider?: string;
  /** 覆盖 baseUrl（如 Ollama: 'http://localhost:11434/v1'） */
  baseUrl?: string;
  timeoutMs?: number;
  /** 测试注入；默认使用全局 fetch */
  fetch?: typeof fetch;
}

/** @deprecated 别名保持向后兼容 */
export type DeepSeekOptions = AiProviderOptions;

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
  if (status === 402) return new DeepSeekError('DEEPSEEK_UNAVAILABLE');
  return new DeepSeekError('INTERNAL');
}

function resolveBaseUrl(options: AiProviderOptions): string {
  if (options.baseUrl) return options.baseUrl.replace(/\/+$/, '');
  const provider = options.provider ?? 'deepseek';
  const url = PROVIDER_BASE_URLS[provider];
  if (!url) {
    throw new DeepSeekError('INTERNAL');
  }
  return url.replace(/\/+$/, '');
}

/** 发送一次 JSON Output 请求，返回 assistant content；结构校验由 parseNoteResponse 完成 */
export async function requestChatCompletion(
  request: ChatRequest,
  options: AiProviderOptions = {},
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

  const baseUrl = resolveBaseUrl(options);

  let body: unknown;
  try {
    const response = await (options.fetch ?? fetch)(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        response_format: NOTE_RESPONSE_FORMAT,
        thinking: { type: 'disabled' },
        max_tokens: MAX_OUTPUT_TOKENS,
        stream: false,
      }),
      signal,
    });
    if (!response.ok) {
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
  if (choice.finish_reason !== 'stop' || !choice.message.content?.trim()) {
    throw new DeepSeekError('DEEPSEEK_INVALID_RESPONSE');
  }
  return choice.message.content;
}
