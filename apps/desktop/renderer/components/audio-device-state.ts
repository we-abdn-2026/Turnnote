// AudioDeviceSelector 的数据与状态逻辑，不依赖 React，便于单元测试。
import type {
  AppError,
  AppSettings,
  CapturePermissions,
  TurnnoteInvokeApi,
} from '@shared/contracts';

type SettingsApi = Pick<TurnnoteInvokeApi, 'settings' | 'recording'>;

// 底层异常可能包含路径或传输细节，界面只展示通用信息
export const LOAD_FAILED_MESSAGE = '加载失败，请重试。';
export const SAVE_FAILED_MESSAGE = '设置未保存，请重试。';
export const ENUMERATE_FAILED_MESSAGE = '无法获取音频设备列表，请点击刷新重试。';

export type LoadOutcome =
  | { ok: true; settings: AppSettings; permissions: CapturePermissions }
  | { ok: false; error: AppError | null };

/** 失败 Result 返回其错误；Promise 拒绝返回 error: null，由界面显示通用信息 */
export async function loadDeviceSettings(api: SettingsApi): Promise<LoadOutcome> {
  try {
    const [settings, permissions] = await Promise.all([
      api.settings.get(),
      api.recording.getPermissions(),
    ]);
    if (!settings.ok) return { ok: false, error: settings.error };
    if (!permissions.ok) return { ok: false, error: permissions.error };
    return { ok: true, settings: settings.value, permissions: permissions.value };
  } catch {
    return { ok: false, error: null };
  }
}

export interface ScanOutcome {
  devices: MediaDeviceInfo[];
  error: string | null;
}

export async function scanAudioInputs(
  mediaDevices: Pick<MediaDevices, 'enumerateDevices'> | undefined,
): Promise<ScanOutcome> {
  try {
    if (!mediaDevices) throw new Error('mediaDevices unavailable');
    const list = await mediaDevices.enumerateDevices();
    return { devices: list.filter((d) => d.kind === 'audioinput'), error: null };
  } catch {
    return { devices: [], error: ENUMERATE_FAILED_MESSAGE };
  }
}

export type SaveOutcome = { ok: true; settings: AppSettings } | { ok: false; message: string };

/** 只有 Main 确认后才返回新设置；失败时调用方保留最后确认的设置 */
export async function saveDeviceSettings(
  api: SettingsApi,
  patch: Partial<AppSettings>,
): Promise<SaveOutcome> {
  try {
    const result = await api.settings.update(patch);
    return result.ok
      ? { ok: true, settings: result.value }
      : { ok: false, message: result.error.message };
  } catch {
    return { ok: false, message: SAVE_FAILED_MESSAGE };
  }
}

export interface DeviceOption {
  value: string;
  label: string;
  disabled: boolean;
}

export interface DeviceView {
  canSelectDevice: boolean;
  /** 已完成首次枚举 */
  scanned: boolean;
  /** 已保存的设备不在当前列表中 */
  selectedMissing: boolean;
  noDevices: boolean;
  options: DeviceOption[];
}

/** devices 为 null 表示尚未完成首次枚举，避免把“未枚举”误判为“无设备” */
export function deriveDeviceView(
  settings: AppSettings,
  permissions: CapturePermissions,
  devices: MediaDeviceInfo[] | null,
  deviceError: string | null,
): DeviceView {
  const canSelectDevice = permissions.microphone === 'granted';
  const scanned = devices !== null;
  const list = devices ?? [];
  const selectedId = settings.microphoneDeviceId;
  // 保留失效项，与持久化设置保持一致，不擅自改写为默认设备
  const selectedMissing =
    canSelectDevice &&
    scanned &&
    selectedId !== null &&
    !list.some((d) => d.deviceId === selectedId);
  const options: DeviceOption[] = [{ value: '', label: '系统默认麦克风', disabled: false }];
  if (selectedMissing && selectedId !== null) {
    options.push({ value: selectedId, label: '已断开的设备（不可用）', disabled: true });
  }
  for (const device of list) {
    options.push({
      value: device.deviceId,
      label: device.label || `麦克风 ${device.deviceId.slice(0, 8)}`,
      disabled: false,
    });
  }
  return {
    canSelectDevice,
    scanned,
    selectedMissing,
    noDevices: canSelectDevice && scanned && list.length === 0 && !deviceError,
    options,
  };
}
