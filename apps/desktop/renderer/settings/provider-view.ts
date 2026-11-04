// 设置里"纪要服务"区域的纯视图推导：状态文字、数据去向说明和自定义表单校验。
// 不依赖 React，便于单测；所有服务商名称、网址和 Key 状态都来自 Main 的目录（providers.list）。
import type { AiProviderInfo, AppSettings } from '@shared/contracts';
import { PROVIDER_URL_PROBLEMS, parseProviderUrl } from '@shared/providers';

export type ProviderBadge = 'ready' | 'needs-key' | 'local';

export interface ProviderRowView {
  id: string;
  label: string;
  /** 数据发往哪里：云端显示主机名，本机显示"本机" */
  destination: string;
  /** 一句话状态，例如"已保存 Key"或"还没有 Key" */
  status: string;
  badge: ProviderBadge;
  active: boolean;
  /** 自定义服务商可以编辑和删除 */
  editable: boolean;
}

export function describeDestination(provider: AiProviderInfo): string {
  return provider.local ? `本机（${provider.host}）` : provider.host;
}

export function deriveProviderRows(
  providers: readonly AiProviderInfo[],
  settings: Pick<AppSettings, 'noteProvider'>,
): ProviderRowView[] {
  return providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    destination: describeDestination(provider),
    status: !provider.needsKey ? '无需 Key' : provider.hasKey ? '已保存 Key' : '还没有 Key',
    badge: provider.ready ? (provider.needsKey ? 'ready' : 'local') : 'needs-key',
    active: provider.id === settings.noteProvider,
    editable: !provider.builtin,
  }));
}

/** 选中服务商下的一句话说明：能不能直接用，数据会去哪里 */
export function describeSelection(provider: AiProviderInfo): string {
  if (provider.local) {
    return `请求只发往这台电脑上的 ${provider.host}，数据不会离开本机。`;
  }
  return provider.ready
    ? `生成纪要时，转写文本会发送到 ${provider.host}。不含音频。`
    : `还需要 ${provider.label} 的 API Key 才能使用。生成时转写文本会发送到 ${provider.host}，不含音频。`;
}

export interface CustomDraft {
  label: string;
  baseUrl: string;
  needsKey: boolean;
}

export interface CustomDraftCheck {
  /** 可以提交 */
  valid: boolean;
  /** 只在用户已经输入内容后才给出，避免一打开表单就报错 */
  labelProblem: string | null;
  urlProblem: string | null;
  /** 网址有效时，提示数据会发往哪里 */
  destination: string | null;
}

export function checkCustomDraft(
  draft: CustomDraft,
  existing: readonly Pick<AiProviderInfo, 'id' | 'label'>[],
  editingId: string | null,
): CustomDraftCheck {
  const label = draft.label.trim();
  const clash = existing.some(
    (item) => item.id !== editingId && item.label.toLowerCase() === label.toLowerCase(),
  );
  const labelProblem = !label
    ? draft.label.length > 0
      ? '名称不能只有空格。'
      : null
    : label.length > 40
      ? '名称不能超过 40 个字符。'
      : clash
        ? `已经有一个叫“${label}”的服务商。`
        : null;
  const url = draft.baseUrl.trim();
  const parsed = url ? parseProviderUrl(url) : null;
  const urlProblem = parsed && !parsed.ok ? PROVIDER_URL_PROBLEMS[parsed.problem] : null;
  return {
    valid: !!label && !labelProblem && !!parsed && parsed.ok,
    labelProblem,
    urlProblem,
    destination:
      parsed && parsed.ok ? (parsed.local ? `本机（${parsed.host}）` : parsed.host) : null,
  };
}

/** 服务商名称在界面里的统一写法：模型名跟在后面 */
export function formatService(label: string, model: string): string {
  return model ? `${label} · ${model}` : label;
}

/** 工作区里需要的当前纪要服务信息：名称、模型和数据发往哪里 */
export interface NoteService {
  label: string;
  model: string;
  /** 数据去向的一句话；服务信息读取失败时为空 */
  destination: string;
  /** 本机服务：数据不会离开这台电脑 */
  local: boolean;
}

export const GENERIC_SERVICE: NoteService = {
  label: 'AI 服务',
  model: '',
  destination: '',
  local: false,
};

export function deriveNoteService(
  settings: Pick<AppSettings, 'noteProvider' | 'noteModel'>,
  providers: readonly AiProviderInfo[],
): NoteService {
  const found = providers.find((item) => item.id === settings.noteProvider);
  // 目录里找不到（刚被删除等短暂状态）：不猜名称，用通用文字
  if (!found) return { ...GENERIC_SERVICE, model: settings.noteModel };
  return {
    label: found.label,
    model: settings.noteModel,
    destination: describeDestination(found),
    local: found.local,
  };
}
