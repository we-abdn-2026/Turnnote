// AI 服务商网址的共享校验：Main 保存自定义服务商前和 Renderer 表单即时校验使用同一份规则。
// 规则：必须是 https；只有本机地址（localhost / 127.0.0.1 / ::1）允许 http，用于 Ollama 等本地服务；
// 不能带账号密码、查询串或片段；结果去掉末尾斜杠，请求时在其后追加 /chat/completions。

export type ProviderUrlProblem = 'format' | 'scheme' | 'credentials' | 'query';

export type ProviderUrlResult =
  | {
      ok: true;
      /** 规范化后的 base URL，无末尾斜杠 */
      baseUrl: string;
      /** 主机名（含非默认端口），用于告知用户数据发往哪里 */
      host: string;
      /** 本机服务：数据不会离开这台电脑 */
      local: boolean;
    }
  | { ok: false; problem: ProviderUrlProblem };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

export function parseProviderUrl(input: string): ProviderUrlResult {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, problem: 'format' };
  }
  const local = isLocalHostname(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    return { ok: false, problem: 'scheme' };
  }
  if (url.username || url.password) return { ok: false, problem: 'credentials' };
  if (url.search || url.hash) return { ok: false, problem: 'query' };
  const path = url.pathname.replace(/\/+$/, '');
  return { ok: true, baseUrl: `${url.origin}${path}`, host: url.host, local };
}

export const PROVIDER_URL_PROBLEMS: Record<ProviderUrlProblem, string> = {
  format: '网址格式不正确，请填写完整的地址，例如 https://api.example.com/v1。',
  scheme: '只支持 https 地址；仅本机服务（localhost、127.0.0.1）可以使用 http。',
  credentials: '网址里不能包含账号或密码，API Key 请填在下面的 API Key 一栏。',
  query: '网址里不能包含 ? 或 # 参数，只需要填写到 /v1 这一级。',
};

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  needsKey: boolean;
  /** 第一项是默认模型；其余只是输入提示 */
  models: readonly string[];
}

/**
 * 内置服务商的数据，Main 的服务商目录和浏览器 mock 共用。请求体里服务商之间的差异
 * （例如 DeepSeek 专有的 thinking 参数）属于 Main 的请求层，不在这里。
 */
export const BUILTIN_PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    needsKey: true,
    // deepseek-chat 已于 2026-07-24 停用
    models: ['deepseek-flash'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    models: ['gpt-4o', 'gpt-4o-mini'],
  },
  {
    id: 'ollama',
    label: 'Ollama（本机）',
    baseUrl: 'http://localhost:11434/v1',
    needsKey: false,
    models: ['llama3.1:8b', 'qwen2.5:7b'],
  },
];
