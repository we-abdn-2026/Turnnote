// 二次启动（second-instance）时把窗口带到前面。
// macOS 关掉窗口后应用还在跑，此时 window 指向已经销毁的实例，任何方法调用都会抛
// “Object has been destroyed”，所以要按窗口状态决定：还能用就聚焦，不能用就重开。
export interface FocusableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

export function focusMainWindow({
  ready,
  quitting,
  window,
  createWindow,
}: {
  ready: boolean;
  quitting: boolean;
  window: FocusableWindow | undefined;
  createWindow(): void;
}): 'created' | 'focused' | 'ignored' {
  if (!ready || quitting) return 'ignored';
  if (!window || window.isDestroyed()) {
    createWindow();
    return 'created';
  }
  if (window.isMinimized()) window.restore();
  window.focus();
  return 'focused';
}
