// Markdown 导出的纯渲染（#29）：不读数据库、不访问文件系统、不弹对话框。
// 小节名与界面 NoteView 一致；用户文本一律按数据转义，不能被解释为 Markdown 或 HTML。
import type { MeetingNote } from '@shared/contracts';
import { formatTimecode } from '@shared/timecode';

const UNSPECIFIED = '未指定';

export interface MarkdownMeeting {
  title: string;
  /** 会议创建时间，ISO 8601 */
  createdAt: string;
}

export interface RenderOptions {
  /** IANA 时区；默认使用系统时区。测试注入以得到确定输出 */
  timeZone?: string;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** 换行统一为 \n，并去掉除 \t、\n 之外的控制字符 */
function clean(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '');
}

function escapeInline(text: string): string {
  return text.replace(/[\\`*_[\]<>~]/g, '\\$&');
}

/** 行首字符可能构成标题、无序列表、引用或 setext 下划线；编号列表需转义数字后的 . 或 ) */
function escapeLineStart(line: string): string {
  return line.replace(/^([#\-+=>])/, '\\$1').replace(/^(\d+)([.)])/, '$1\\$2');
}

/** 单行文本：折叠所有空白（含换行），用于标题、列表项和字段值 */
function singleLine(text: string): string {
  return escapeInline(clean(text).replace(/\s+/g, ' ').trim());
}

/** 多行文本：空行分段，段内换行保留为硬换行 */
function paragraphs(text: string): string {
  return clean(text)
    .split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map((line) => escapeLineStart(escapeInline(line.trim())))
        .filter((line) => line !== '')
        .join('  \n'),
    )
    .filter((paragraph) => paragraph !== '')
    .join('\n\n');
}

function valueOrUnspecified(value: string): string {
  const normalized = singleLine(value);
  return normalized === '' || normalized.toLowerCase() === 'unspecified' ? UNSPECIFIED : normalized;
}

function formatCreatedAt(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return UNSPECIFIED;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

/** 决策、行动项的一行正文：文本（空则“未指定”）加可选的来源时间码 */
function entry(text: string, timestampMs?: number): string {
  const source = timestampMs === undefined ? '' : `（来源 ${formatTimecode(timestampMs)}）`;
  return `${singleLine(text) || UNSPECIFIED}${source}`;
}

/** 有序列表；子行缩进到列表标记之后，序号位数增加时仍属于同一条目 */
function numbered(items: string[][]): string {
  if (items.length === 0) return UNSPECIFIED;
  return items
    .map(([first, ...children], i) => {
      const marker = `${i + 1}. `;
      const indent = ' '.repeat(marker.length);
      return [`${marker}${first}`, ...children.map((child) => `${indent}${child}`)].join('\n');
    })
    .join('\n');
}

export function renderMeetingMarkdown(
  meeting: MarkdownMeeting,
  note: MeetingNote,
  options: RenderOptions = {},
): string {
  // 标题以 # 结尾会被当作 ATX 标题的闭合序列，因此标题中的 # 一并转义
  const title = singleLine(meeting.title).replace(/#/g, '\\#') || UNSPECIFIED;
  const topics = note.keyTopics.map(singleLine).filter((topic) => topic !== '');
  const actions = note.actionItems.map((item) => [
    entry(item.task, item.timestampMs),
    `- 负责人：${valueOrUnspecified(item.owner)}`,
    `- 截止时间：${valueOrUnspecified(item.dueDate)}`,
  ]);
  const sections = [
    `# ${title}`,
    `- 时间：${formatCreatedAt(meeting.createdAt, options.timeZone)}`,
    `## 摘要\n\n${paragraphs(note.summary) || '未填写'}`,
    `## 关键主题\n\n${topics.length === 0 ? UNSPECIFIED : topics.map((topic) => `- ${topic}`).join('\n')}`,
    `## 决策\n\n${numbered(note.decisions.map((d) => [entry(d.text, d.timestampMs)]))}`,
    `## 未决问题\n\n${numbered(note.openQuestions.map((q) => [entry(q)]))}`,
    `## 行动项\n\n${numbered(actions)}`,
  ];
  return `${sections.join('\n\n')}\n`;
}

const RESERVED_FILE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 保存对话框的默认文件名：去掉路径分隔符和 Windows 非法字符，避开保留名，限制长度 */
export function markdownFileName(title: string): string {
  const base = [...clean(title).replace(/[\\/:*?"<>|\n\t]/g, ' ')]
    .slice(0, 80)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|[. ]+$/g, '');
  const safe = base === '' ? '会议纪要' : RESERVED_FILE_NAMES.test(base) ? `_${base}` : base;
  return `${safe}.md`;
}
