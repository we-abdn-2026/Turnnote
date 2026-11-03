// 确认型交互统一使用原生 <dialog>：showModal 提供焦点约束和背景惰性，Escape 与关闭按钮都只走 onClose。
// 对话框就地渲染在所属区域内，不 portal，保证所属组件卸载时一并消失。
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Icon } from './icons';

export type DialogTone = 'consent' | 'caution' | 'neutral';

interface DialogProps {
  titleId: string;
  descriptionId: string;
  title: string;
  tone?: DialogTone;
  /** 提供时显示右上角关闭按钮，其可访问名称为该文字 */
  closeLabel?: string;
  onClose(): void;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  role?: 'alertdialog' | 'dialog';
}

export function Dialog({
  titleId,
  descriptionId,
  title,
  tone = 'neutral',
  closeLabel,
  onClose,
  children,
  actions,
  className,
  role = 'alertdialog',
}: DialogProps): ReactElement {
  const ref = useRef<HTMLDialogElement>(null);
  // 关闭始终调用最新的 onClose，而打开时的初始化只运行一次
  const close = useEffectEvent(() => onClose());

  // 打开按钮常在同一次提交中被禁用，浏览器会立即把焦点移到 body；在渲染阶段先记下它。
  // 不依赖 HTMLElement 全局，jsdom 测试也能运行
  const [opener] = useState(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  );

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    try {
      if (!dialog.open) dialog.showModal();
    } catch {
      // jsdom 等环境没有 showModal；仍保持可见和可操作
      dialog.setAttribute('open', '');
    }
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();

    // 原生 cancel 只在真实 Escape 按键时触发；窗口级监听同时覆盖合成事件和非模态回退
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
      // ⌘/Ctrl+Enter 只确认标为主操作的肯定动作；删除、丢弃的默认焦点在取消上，不响应
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        const primary = ref.current?.querySelector<HTMLButtonElement>('[data-primary]');
        if (primary && !primary.disabled) {
          event.preventDefault();
          primary.click();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 关闭后归还焦点。被动清理在本次提交的 DOM 更新之后运行，此时打开按钮已重新可用
  useEffect(
    () => () => {
      if (opener?.isConnected) opener.focus?.();
    },
    [opener],
  );

  return (
    <dialog
      ref={ref}
      className={`dialog dialog-${tone}${className ? ` ${className}` : ''}`}
      role={role}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-head">
        <span className={`lamp lamp-${tone === 'caution' ? 'amber' : 'lit'}`} aria-hidden="true" />
        <strong id={titleId}>{title}</strong>
        {closeLabel && (
          <button
            type="button"
            className="key key-icon key-quiet dialog-close"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        )}
      </div>
      <div className="dialog-body" id={descriptionId}>
        {children}
      </div>
      {actions && <div className="dialog-actions">{actions}</div>}
    </dialog>
  );
}
