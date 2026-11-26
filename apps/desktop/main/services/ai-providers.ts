// AI 服务商目录：界面里所有服务商的名称、网址、可选模型和数据去向都来自这里，是唯一事实源。
// 内置服务商写在代码里；用户可以再添加自己的 OpenAI 兼容端点（Ollama、各家兼容网关）。
// 每个服务商带一份请求参数配置：DeepSeek 专有的 `thinking` 参数不会发给其他服务商，
// OpenAI 使用 max_completion_tokens。API Key 不在这里，按服务商 id 保存在系统安全存储。
import { randomUUID } from 'node:crypto';
import type { AiProviderInfo, CustomProviderInput } from '@shared/contracts';
import { BUILTIN_PROVIDER_PRESETS, parseProviderUrl, type ProviderPreset } from '@shared/providers';
import { requireCondition } from '@shared/result';
import type { CredentialStore } from '../platform/credentials';
import type { MeetingStore } from '../storage/database';

/** 服务商之间有差异的请求体部分 */
export interface RequestProfile {
  /** 追加到请求体的服务商专有字段 */
  extraBody?: Readonly<Record<string, unknown>>;
  /** 输出长度上限使用的字段名：OpenAI 新模型要求 max_completion_tokens，兼容服务普遍用 max_tokens */
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
}

export interface ProviderDefinition {
  id: string;
  label: string;
  baseUrl: string;
  host: string;
  local: boolean;
  builtin: boolean;
  needsKey: boolean;
  defaultModel: string;
  models: readonly string[];
  request: RequestProfile;
}

const GENERIC_PROFILE: RequestProfile = { maxTokensField: 'max_tokens' };

export const DEEPSEEK_PROFILE: RequestProfile = {
  // 纪要不需要思维链：关闭后更快，且 content 不混入推理过程
  extraBody: { thinking: { type: 'disabled' } },
  maxTokensField: 'max_tokens',
};

/** 只有和通用配置不同的服务商才需要登记；其余都用 GENERIC_PROFILE */
const BUILTIN_PROFILES: Readonly<Record<string, RequestProfile>> = {
  deepseek: DEEPSEEK_PROFILE,
  // OpenAI 新模型要求 max_completion_tokens，且不认识 DeepSeek 的 thinking 字段
  openai: { maxTokensField: 'max_completion_tokens' },
};

function fromPreset(preset: ProviderPreset): ProviderDefinition {
  const parsed = parseProviderUrl(preset.baseUrl);
  if (!parsed.ok) throw new Error(`Invalid built-in provider URL for ${preset.id}`);
  return {
    id: preset.id,
    label: preset.label,
    baseUrl: parsed.baseUrl,
    host: parsed.host,
    local: parsed.local,
    builtin: true,
    needsKey: preset.needsKey,
    defaultModel: preset.models[0],
    models: preset.models,
    request: BUILTIN_PROFILES[preset.id] ?? GENERIC_PROFILE,
  };
}

export const BUILTIN_PROVIDERS: readonly ProviderDefinition[] =
  BUILTIN_PROVIDER_PRESETS.map(fromPreset);

export const DEFAULT_PROVIDER = BUILTIN_PROVIDERS[0];
export const MAX_CUSTOM_PROVIDERS = 10;

/** 没有登记的服务商（例如测试直接传 baseUrl）使用通用配置 */
export function profileFor(providerId: string | undefined): RequestProfile {
  return BUILTIN_PROVIDERS.find((item) => item.id === providerId)?.request ?? GENERIC_PROFILE;
}

function toDefinition(record: {
  id: string;
  label: string;
  baseUrl: string;
  needsKey: boolean;
}): ProviderDefinition | null {
  const parsed = parseProviderUrl(record.baseUrl);
  // 库里的记录理论上都通过了校验；被外部改坏时忽略这一条，不让整个目录失效
  if (!parsed.ok) return null;
  return {
    id: record.id,
    label: record.label,
    baseUrl: parsed.baseUrl,
    host: parsed.host,
    local: parsed.local,
    builtin: false,
    needsKey: record.needsKey,
    defaultModel: '',
    models: [],
    request: GENERIC_PROFILE,
  };
}

export function createProviderCatalog(store: MeetingStore, credentials?: CredentialStore) {
  function definitions(): ProviderDefinition[] {
    const custom = store
      .listCustomProviders()
      .map(toDefinition)
      .filter((item): item is ProviderDefinition => item !== null);
    return [...BUILTIN_PROVIDERS, ...custom];
  }
  function info(definition: ProviderDefinition): AiProviderInfo {
    const hasKey = credentials?.has(definition.id) ?? false;
    return {
      id: definition.id,
      label: definition.label,
      baseUrl: definition.baseUrl,
      host: definition.host,
      builtin: definition.builtin,
      local: definition.local,
      needsKey: definition.needsKey,
      hasKey,
      ready: !definition.needsKey || hasKey,
      defaultModel: definition.defaultModel,
      models: [...definition.models],
    };
  }

  function get(id: string): ProviderDefinition | null {
    return definitions().find((item) => item.id === id) ?? null;
  }

  return {
    get,
    list(): AiProviderInfo[] {
      return definitions().map(info);
    },
    /** 校验网址和名称后保存；返回保存后的条目 */
    saveCustom(input: CustomProviderInput): AiProviderInfo {
      const existing = definitions();
      const editing = input.id ? existing.find((item) => item.id === input.id) : undefined;
      requireCondition(!input.id || (editing && !editing.builtin), 'INVALID_INPUT');
      const parsed = parseProviderUrl(input.baseUrl);
      requireCondition(parsed.ok, 'INVALID_INPUT');
      const label = input.label.trim();
      const taken = existing.some(
        (item) => item.id !== input.id && item.label.toLowerCase() === label.toLowerCase(),
      );
      requireCondition(!taken, 'INVALID_INPUT');
      requireCondition(
        editing || existing.filter((item) => !item.builtin).length < MAX_CUSTOM_PROVIDERS,
        'INVALID_INPUT',
      );
      const id = input.id ?? `custom-${randomUUID().slice(0, 8)}`;
      store.saveCustomProvider({ id, label, baseUrl: parsed.baseUrl, needsKey: input.needsKey });
      return info(get(id)!);
    },
    removeCustom(id: string): void {
      const target = get(id);
      requireCondition(target && !target.builtin, 'INVALID_INPUT');
      store.removeCustomProvider(id, {
        noteProvider: DEFAULT_PROVIDER.id,
        noteModel: DEFAULT_PROVIDER.defaultModel,
      });
      credentials?.clear(id);
    },
  };
}

export type ProviderCatalog = ReturnType<typeof createProviderCatalog>;
