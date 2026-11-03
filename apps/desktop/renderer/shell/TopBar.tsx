// 顶栏：窗口拖动区。只有两个控件——会议库开关（窄窗口）和设置。会议标题在文档里，不在这里重复。
import type { ReactElement } from 'react';
import { Icon } from '../ui/icons';
import { shortcutAria, shortcutLabel } from '../ui/shortcuts';

interface TopBarProps {
  libraryOpen: boolean;
  drawerOpen: boolean;
  canShowDrawer: boolean;
  onToggleLibrary(): void;
  onToggleDrawer(): void;
  onOpenSettings(): void;
}

export function TopBar({
  libraryOpen,
  drawerOpen,
  canShowDrawer,
  onToggleLibrary,
  onToggleDrawer,
  onOpenSettings,
}: TopBarProps): ReactElement {
  return (
    <header className="topbar">
      <button
        type="button"
        className="key key-icon key-quiet topbar-library"
        aria-label="会议库"
        aria-expanded={libraryOpen}
        aria-controls="meeting-library"
        aria-keyshortcuts={shortcutAria('\\')}
        title={`会议库（${shortcutLabel('\\')}）`}
        onClick={onToggleLibrary}
      >
        <Icon name="sidebar" />
      </button>
      <div className="topbar-tail">
        {canShowDrawer && (
          <button
            type="button"
            className="key key-icon key-quiet"
            aria-label="转写"
            aria-pressed={drawerOpen}
            aria-controls="transcript-drawer"
            aria-keyshortcuts={shortcutAria('j')}
            title={`转写（${shortcutLabel('j')}）`}
            onClick={onToggleDrawer}
          >
            <Icon name="transcript" />
          </button>
        )}
        <button
          type="button"
          className="key key-icon key-quiet"
          aria-label="设置"
          aria-keyshortcuts={shortcutAria(',')}
          title={`设置（${shortcutLabel(',')}）`}
          onClick={onOpenSettings}
        >
          <Icon name="settings" />
        </button>
      </div>
    </header>
  );
}
