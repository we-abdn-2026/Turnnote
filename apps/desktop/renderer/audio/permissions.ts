// 系统音频与屏幕录制权限的判断和提示文案。采集失败时的原因、设备面板里的事先提示都用这里，
// 避免各处各写一句"系统音频不可用"而把真正的原因（权限）吞掉。
import type { CapturePermissions } from '@shared/contracts';

/**
 * 系统音频采集需要 macOS 的"屏幕与系统音频录制"权限。Windows 没有这项权限（Main 恒报 granted），
 * Linux 无法查询（unknown），这两种情况都不是权限问题。
 */
export function systemAudioBlocked(permissions: CapturePermissions | null | undefined): boolean {
  const screen = permissions?.screen;
  return screen === 'denied' || screen === 'restricted' || screen === 'not-determined';
}

export const SYSTEM_AUDIO_UNAVAILABLE = '系统音频不可用，本次只录制麦克风。';

export const SYSTEM_AUDIO_NEEDS_PERMISSION =
  '系统音频需要“屏幕与系统音频录制”权限，目前没有授权，本次只录制麦克风。授权后需要重新打开 Turnnote。';

/** 系统音频采集失败后给用户的提示：查得到权限问题就明说，查不到才用通用说法 */
export function systemAudioWarning(permissions: CapturePermissions | null | undefined): string {
  return systemAudioBlocked(permissions) ? SYSTEM_AUDIO_NEEDS_PERMISSION : SYSTEM_AUDIO_UNAVAILABLE;
}
