import type { MeetingStatus, TranscriptSegment } from '@shared/contracts';

/** 片段时长，供场记行的标题提示和朗读使用 */
export function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds} 秒`;
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
}

/** 素材总长取最后一个片段的出点；没有转写时未知 */
export function transcriptLength(segments: TranscriptSegment[]): number | null {
  return segments.length > 0 ? segments[segments.length - 1].endMs : null;
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** 绝对日期时间；不用“几分钟前”，避免界面文字随时间漂移 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : dateFormat.format(date);
}

/** 找到时间码所在的片段：优先精确入点，其次包含该时间的片段 */
export function segmentIndexAt(segments: TranscriptSegment[], timestampMs: number): number {
  const exact = segments.findIndex((segment) => segment.startMs === timestampMs);
  if (exact !== -1) return exact;
  return segments.findIndex(
    (segment) => segment.startMs <= timestampMs && timestampMs < segment.endMs,
  );
}

export const STATUS_LABELS: Record<MeetingStatus, string> = {
  created: '已创建，未开始录音',
  recording: '录音中',
  captured: '录音已保存',
  transcribing: '正在转写',
  transcribed: '转写完成',
  generating: '正在生成纪要',
  ready: '纪要已生成',
  failed: '处理失败',
  deleted: '已删除',
};

/** 会议库里的短状态 */
export const SHORT_STATUS: Record<MeetingStatus, string> = {
  created: '待录音',
  recording: '录音中',
  captured: '已保存',
  transcribing: '转写中',
  transcribed: '已转写',
  generating: '生成中',
  ready: '有纪要',
  failed: '失败',
  deleted: '已删除',
};

/** 状态点：rec 只表示正在采集，busy 表示后台处理，warn 表示故障 */
export type Dot = 'idle' | 'rec' | 'busy' | 'done' | 'warn';

export const STATUS_DOT: Record<MeetingStatus, Dot> = {
  created: 'idle',
  recording: 'rec',
  captured: 'busy',
  transcribing: 'busy',
  transcribed: 'done',
  generating: 'busy',
  ready: 'done',
  failed: 'warn',
  deleted: 'idle',
};
