// 纪要生成 provider 的展示信息。后端的真实支持范围在 Main 的 PROVIDER_BASE_URLS（deepseek、openai）；
// 这里只放界面要用的名称和是否需要 Key。Provider 的当前选择始终来自 settings.noteProvider。
// 未登记的 provider（后端后来新增）直接显示其标识，不会因此让界面失效。
export interface ProviderInfo {
  id: string;
  label: string;
  /** 本地 provider 不需要 Key */
  needsKey: boolean;
  /** 常用模型，只用于输入提示，用户可以填任何模型名 */
  models: string[];
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'deepseek', label: 'DeepSeek', needsKey: true, models: ['deepseek-flash'] },
  { id: 'openai', label: 'OpenAI', needsKey: true, models: ['gpt-4o', 'gpt-4o-mini'] },
];

export function providerInfo(id: string): ProviderInfo {
  return (
    PROVIDERS.find((provider) => provider.id === id) ?? {
      id,
      label: id,
      needsKey: true,
      models: [],
    }
  );
}

export function providerLabel(id: string | undefined): string {
  return id ? providerInfo(id).label : 'AI 服务';
}
