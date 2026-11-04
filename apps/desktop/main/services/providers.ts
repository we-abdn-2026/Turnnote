// providers.*：服务商目录的 IPC 处理。list/saveCustom/removeCustom 只读写目录和 Key 状态，
// test 发一次不含会议内容的最小请求，帮用户在真正生成前确认 Key、网址和模型都可用。
import type { InvokeHandlers } from '@shared/invoke';
import { ok, requireCondition, TurnnoteError } from '@shared/result';
import type { CredentialStore } from '../platform/credentials';
import type { ProviderCatalog } from './ai-providers';
import { DeepSeekError, requestChatCompletion, type AiProviderOptions } from './deepseek';

const TEST_TIMEOUT_MS = 20_000;
/** 只含固定的探测文字；JSON Output 模式要求提示里出现 "json" 字样 */
const TEST_MESSAGES = [
  { role: 'system', content: 'Reply with a tiny json object.' },
  { role: 'user', content: 'Return {"pong": true} as json.' },
] as const;

export interface ProviderHandlerOptions {
  /** 请求选项覆盖（超时、测试 fetch 注入） */
  provider?: AiProviderOptions;
}

export function createProviderHandlers(
  catalog: ProviderCatalog,
  credentials: CredentialStore | undefined,
  options: ProviderHandlerOptions = {},
): NonNullable<InvokeHandlers['providers']> {
  return {
    list: async () => ok(catalog.list()),
    saveCustom: async (input) => ok(catalog.saveCustom(input)),
    removeCustom: async (id) => {
      catalog.removeCustom(id);
      return ok(null);
    },
    test: async (id, model) => {
      const service = catalog.get(id);
      requireCondition(service, 'INVALID_INPUT');
      const apiKey = credentials?.get(id)?.trim() || null;
      requireCondition(apiKey || !service.needsKey, 'API_KEY_MISSING');
      try {
        await requestChatCompletion(
          { apiKey, model, messages: [...TEST_MESSAGES], maxTokens: 32 },
          {
            baseUrl: service.baseUrl,
            profile: service.request,
            timeoutMs: TEST_TIMEOUT_MS,
            ...options.provider,
          },
        );
      } catch (error) {
        // 服务返回了 200 但内容不合要求：Key、网址、模型都是对的，探测目的已达到
        if (error instanceof DeepSeekError && error.code === 'DEEPSEEK_INVALID_RESPONSE') {
          return ok(null);
        }
        throw error instanceof DeepSeekError ? new TurnnoteError(error.code) : error;
      }
      return ok(null);
    },
  };
}
