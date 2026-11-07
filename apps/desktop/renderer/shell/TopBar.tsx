// 顶栏：窗口拖动区，也是应用的身份条。左侧是产品名，右侧是会议库/转写/设置。
// 会议标题在文档里，不在顶栏重复。
import type { ReactElement } from 'react';
import { Icon } from '../ui/icons';
import { shortcutAria } from '../ui/shortcuts';

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
      <span className="brand">Turnnote</span>
      <button
        type="button"
        className="key key-icon key-quiet topbar-library"
        aria-label="会议库"
        aria-expanded={libraryOpen}
        aria-controls="meeting-library"
        aria-keyshortcuts={shortcutAria('\\')}
        data-tip="会议库"
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
            data-tip="转写"
            data-tip-align="end"
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
          data-tip="设置"
          data-tip-align="end"
          onClick={onOpenSettings}
        >
          <Icon name="settings" />
        </button>
      </div>
    </header>
  );
}
