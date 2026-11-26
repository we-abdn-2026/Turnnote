// 全局快捷键：macOS 用 ⌘，其他平台用 Ctrl。只在没有打开对话框时响应，避免打断确认流程。
import { useEffect } from 'react';

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

export type ShortcutKey = 'n' | 'k' | '\\' | 'j' | ',';

/** 给 aria-keyshortcuts 用的写法 */
export function shortcutAria(key: ShortcutKey): string {
  return `${isMac ? 'Meta' : 'Control'}+${key === '\\' ? 'Backslash' : key.toUpperCase()}`;
}

export function useShortcuts(handlers: Partial<Record<ShortcutKey, () => void>>): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!modifier || event.altKey || event.shiftKey) return;
      if (document.querySelector('dialog[open]')) return;
      const handler = handlers[event.key.toLowerCase() as ShortcutKey];
      if (!handler) return;
      event.preventDefault();
      handler();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handlers]);
}
