// 会议库右缘的拖拽手柄：可用指针拖动，也可用方向键、Home / End 调整，双击复位。
// 宽度只是界面偏好，保存在 localStorage；窄于 1100px 时会议库是抽屉，手柄不显示。
import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from 'react';

export const SIDEBAR_DEFAULT = 264;
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 420;
const STEP = 16;
const STORAGE_KEY = 'turnnote.sidebarWidth';

export function clampSidebar(width: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)));
}

function readStored(): number {
  try {
    const value = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? clampSidebar(value) : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

export function useSidebarWidth(): [number, (width: number) => void] {
  const [width, setWidth] = useState(readStored);
  const update = useCallback((next: number) => {
    const clamped = clampSidebar(next);
    setWidth(clamped);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(clamped));
    } catch {
      /* 偏好无法保存时只在本次会话生效 */
    }
  }, []);
  return [width, update];
}

export function SidebarResizer({
  width,
  onChange,
}: {
  width: number;
  onChange(width: number): void;
}): ReactElement {
  const [dragging, setDragging] = useState(false);
  const origin = useRef<{ x: number; width: number } | null>(null);

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    event.currentTarget.setPointerCapture(event.pointerId);
    origin.current = { x: event.clientX, width };
    setDragging(true);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (!origin.current) return;
    onChange(origin.current.width + event.clientX - origin.current.x);
  }

  function endDrag(): void {
    origin.current = null;
    setDragging(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const next =
      event.key === 'ArrowLeft'
        ? width - STEP
        : event.key === 'ArrowRight'
          ? width + STEP
          : event.key === 'Home'
            ? SIDEBAR_MIN
            : event.key === 'End'
              ? SIDEBAR_MAX
              : null;
    if (next === null) return;
    event.preventDefault();
    onChange(next);
  }

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整会议库宽度"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={width}
      tabIndex={0}
      data-dragging={dragging ? 'true' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onChange(SIDEBAR_DEFAULT)}
      onKeyDown={onKeyDown}
    />
  );
}
