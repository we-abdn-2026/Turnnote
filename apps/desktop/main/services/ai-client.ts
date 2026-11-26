// AI Chat Completions 请求层：OpenAI-compatible API，支持任何兼容端点。
// 网址和服务商之间的请求体差异由调用方通过 baseUrl 和 profile 传入（目录见 ai-providers.ts）。
// 不读数据库、不发送音频、不写日志。错误只携带错误码，不包含响应正文、API Key 或会议内容。
import type { ErrorCode } from '@shared/contracts';
import { errorRecovery } from '@shared/result';
import { parseProviderUrl } from '@shared/providers';
import { z } from 'zod';
import type { ChatMessage } from './note-prompt';
import { NOTE_RESPONSE_FORMAT } from './note-prompt';
import { DEEPSEEK_PROFILE, DEFAULT_PROVIDER, type RequestProfile } from './ai-providers';

export const REQUEST_TIMEOUT_MS = 120_000;
/** 非 thinking 模式的默认上限；显式设置以免 JSON 被截断时不易察觉 */
export const MAX_OUTPUT_TOKENS = 8_192;

export type AiErrorCode = Extract<
  ErrorCode,
  | 'AI_UNAUTHORIZED'
  | 'AI_RATE_LIMITED'
  | 'AI_TIMEOUT'
  | 'AI_INVALID_RESPONSE'
  | 'AI_UNAVAILABLE'
  | 'AI_PAYMENT_REQUIRED'
  | 'AI_PROVIDER_NOT_CONFIGURED'
  | 'AI_REQUEST_REJECTED'
  | 'INTERRUPTED'
  | 'INTERNAL'
>;

export class AiRequestError extends Error {
  readonly retryable: boolean;

  constructor(public readonly code: AiErrorCode) {
    super(code);
    this.name = 'AiRequestError';
    // 用户可以重新发起已中断的任务；取消当前请求不能触发客户端自动重试。
    this.retryable = code !== 'INTERRUPTED' && errorRecovery[code] === 'retry';
  }
}

export interface AiProviderOptions {
  /** 服务商的 base URL；缺省为默认服务商 */
  baseUrl?: string;
  /** 请求体里服务商之间有差异的部分；缺省按默认服务商 */
  profile?: RequestProfile;
  timeoutMs?: number;
  /** 测试注入；默认使用全局 fetch */
  fetch?: typeof fetch;
}

export interface ChatRequest {
  /** 不需要 Key 的服务商（如本机 Ollama）传 null，请求不带 Authorization */
  apiKey: string | null;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  /** 输出长度上限，缺省为 MAX_OUTPUT_TOKENS */
  maxTokens?: number;
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

function statusError(status: number): AiRequestError {
  if (status === 401 || status === 403) return new AiRequestError('AI_UNAUTHORIZED');
  if (status === 429) return new AiRequestError('AI_RATE_LIMITED');
  if (status >= 500) return new AiRequestError('AI_UNAVAILABLE');
  if (status === 402) return new AiRequestError('AI_PAYMENT_REQUIRED');
  // 400/404/422 等：请求本身被拒绝，最常见的原因是模型名或网址填错。
  // 用户能自己修正，所以不能落成"意外错误"
  if (status >= 400 && status < 500) return new AiRequestError('AI_REQUEST_REJECTED');
  return new AiRequestError('AI_UNAVAILABLE');
}

/** 请求体：公共字段 + 服务商配置。其他服务商不会收到 DeepSeek 专有的 thinking 字段 */
function requestBody(request: ChatRequest, profile: RequestProfile): string {
  return JSON.stringify({
    model: request.model,
    messages: request.messages,
    response_format: NOTE_RESPONSE_FORMAT,
    [profile.maxTokensField]: request.maxTokens ?? MAX_OUTPUT_TOKENS,
    stream: false,
    ...profile.extraBody,
  });
}

/** 发送一次 JSON Output 请求，返回 assistant content；结构校验由 parseNoteResponse 完成 */
export async function requestChatCompletion(
  request: ChatRequest,
  options: AiProviderOptions = {},
): Promise<string> {
  if (request.signal?.aborted) throw new AiRequestError('INTERRUPTED');
  const endpoint = parseProviderUrl(options.baseUrl ?? DEFAULT_PROVIDER.baseUrl);
  if (!endpoint.ok) throw new AiRequestError('AI_PROVIDER_NOT_CONFIGURED');
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const failure = (): AiRequestError =>
    request.signal?.aborted
      ? new AiRequestError('INTERRUPTED')
      : timeout.aborted
        ? new AiRequestError('AI_TIMEOUT')
        : new AiRequestError('AI_UNAVAILABLE');

  const baseUrl = endpoint.baseUrl;
  const profile = options.profile ?? DEEPSEEK_PROFILE;

  let body: unknown;
  try {
    const response = await (options.fetch ?? fetch)(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {}),
      },
      body: requestBody(request, profile),
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
      throw new AiRequestError('AI_INVALID_RESPONSE');
    }
  } catch (error) {
    if (error instanceof AiRequestError) throw error;
    throw failure();
  }

  const parsed = completionSchema.safeParse(body);
  if (!parsed.success) throw new AiRequestError('AI_INVALID_RESPONSE');
  const [choice] = parsed.data.choices;
  if (choice.finish_reason === 'insufficient_system_resource') {
    throw new AiRequestError('AI_UNAVAILABLE');
  }
  if (choice.finish_reason !== 'stop' || !choice.message.content?.trim()) {
    throw new AiRequestError('AI_INVALID_RESPONSE');
  }
  return choice.message.content;
}
