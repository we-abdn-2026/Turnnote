// 自绘图标：16px 网格、1.5px 描边、方头端点，与面板按键的刻字同一笔画。
// 图标始终 aria-hidden，按钮的可访问名称来自文字或 aria-label。
import type { ReactElement } from 'react';

const PATHS = {
  search: 'M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM11 11l3.5 3.5',
  plus: 'M8 2.5v11M2.5 8h11',
  import: 'M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 11v2.5h11V11',
  export: 'M8 10V2M4.5 5.5 8 2l3.5 3.5M2.5 11v2.5h11V11',
  settings: 'M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6M10 2.5v4M5 9.5v4',
  edit: 'M10.5 2.5l3 3L6 13H3v-3l7.5-7.5ZM9 4l3 3',
  trash: 'M2.5 4h11M6 4V2.5h4V4M4 4l.75 9.5h6.5L12 4M6.75 6.5v4.5M9.25 6.5v4.5',
  refresh: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3.5H10',
  close: 'M3.5 3.5l9 9M12.5 3.5l-9 9',
  chevronDown: 'M4 6l4 4 4-4',
  bin: 'M2 3.5h12M3 6.5h10M4 9.5h8M5 12.5h6',
  check: 'M3 8.5l3 3 7-7',
  alert: 'M8 2l6.5 11.5h-13L8 2ZM8 6.5v3.25M8 11.75v.01',
  mic: 'M8 10a2.5 2.5 0 0 0 2.5-2.5v-3a2.5 2.5 0 0 0-5 0v3A2.5 2.5 0 0 0 8 10ZM4 7.5a4 4 0 0 0 8 0M8 11.5V14',
  speaker: 'M2.5 6v4h2.5l3.5 3V3L5 6H2.5ZM11 5.5a3.5 3.5 0 0 1 0 5M12.75 3.5a6 6 0 0 1 0 9',
  cue: 'M4 3v10M7 3.5l6 4.5-6 4.5v-9Z',
  send: 'M2 8h9M8 4.5 11.5 8 8 11.5M13.5 3v10',
  key: 'M5.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8.5 8H14M12 8v2.5M14 8v2',
  stop: 'M4 4h8v8H4z',
  record: 'M8 12.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z',
  sidebar: 'M2.5 3h11v10h-11zM6 3v10',
  transcript: 'M2.5 3h11v10h-11zM10 3v10M4.5 6h3M4.5 8.5h3',
  chevronRight: 'M6 3.5 10.5 8 6 12.5',
  sparkles:
    'M8 2.5l1.3 3.7L13 7.5l-3.7 1.3L8 12.5 6.7 8.8 3 7.5l3.7-1.3L8 2.5ZM12.5 10.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5.5-1.5Z',
  tag: 'M2.5 2.5h5l6 6-5 5-6-6v-5ZM5 5h.01',
  help: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM6 6.2a2 2 0 0 1 3.9.6c0 1.2-1.9 1.4-1.9 2.7M8 12v.01',
  list: 'M3 4h10M3 8h10M3 12h6',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }): ReactElement {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
