// 各平台"隐私权限"设置页的地址。地址只在 Main 里固定写死：Renderer 只能传一个枚举值，
// 不能传任意 URL，所以这个入口无法被用来打开别的东西。
import type { PermissionTarget } from '@shared/contracts';

const PANES: Partial<Record<NodeJS.Platform, Partial<Record<PermissionTarget, string>>>> = {
  darwin: {
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    // "屏幕与系统音频录制"：系统音频采集在 macOS 上依赖它
    screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  },
  // Windows 没有屏幕录制权限；麦克风有隐私设置页
  win32: { microphone: 'ms-settings:privacy-microphone' },
};

/** 没有对应设置页的平台/权限返回 null */
export function permissionSettingsUrl(
  platform: NodeJS.Platform,
  target: PermissionTarget,
): string | null {
  return PANES[platform]?.[target] ?? null;
}
