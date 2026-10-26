// 纪要生成流水线：长转写分段（#18）、中间纪要合并、关键词上下文和来源校验（#20）。
// 不发请求、不写数据库：request 由 deepseek.ts 提供，结果由调用方一次提交。策略见 docs/note-generation.md。
import type { MeetingNote, TranscriptSegment } from '@shared/contracts';
import { requireCondition } from '@shared/result';
import {
  buildMergeMessages,
  buildNoteMessages,
  formatTranscript,
  parseNoteResponse,
  UNSPECIFIED,
  type ChatMessage,
} from './note-prompt';

/** 单次请求的转写字符预算：约半小时英文或一个多小时中文对话，远低于模型上下文 */
export const CHUNK_CHAR_BUDGET = 24_000;
/** 段数上限（约 5 小时英文会议）；超过直接拒绝，不截断 */
export const MAX_CHUNKS = 12;

export interface ChunkLimits {
  chunkChars?: number;
  maxChunks?: number;
}

/** 只在片段边界切分；每个片段恰好属于一段且顺序不变，单个超长片段独占一段、不拆开 */
export function chunkSegments(
  segments: readonly TranscriptSegment[],
  limits: ChunkLimits = {},
): TranscriptSegment[][] {
  const budget = limits.chunkChars ?? CHUNK_CHAR_BUDGET;
  const chunks: TranscriptSegment[][] = [];
  let current: TranscriptSegment[] = [];
  let size = 0;
  for (const segment of segments) {
    const length = formatTranscript([segment]).length + 1;
    if (current.length > 0 && size + length > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(segment);
    size += length;
  }
  if (current.length > 0) chunks.push(current);
  requireCondition(chunks.length <= (limits.maxChunks ?? MAX_CHUNKS), 'TRANSCRIPT_TOO_LONG');
  return chunks;
}

type Sourced = { timestampMs?: number };

/** 只保留与某个片段 startMs 完全相同的 timestampMs；其余删除，不就近吸附、不补造 */
export function alignSources(
  note: MeetingNote,
  segments: readonly TranscriptSegment[],
): MeetingNote {
  return keepSources(note, new Set(segments.map((segment) => segment.startMs)));
}

function keepSources(note: MeetingNote, allowed: ReadonlySet<number>): MeetingNote {
  const source = <T extends Sourced>({ timestampMs, ...item }: T): T =>
    (timestampMs !== undefined && allowed.has(timestampMs) ? { ...item, timestampMs } : item) as T;
  return {
    ...note,
    decisions: note.decisions.map(source),
    actionItems: note.actionItems.map(source),
  };
}

function sourcesOf(notes: readonly MeetingNote[]): Set<number> {
  return new Set(
    notes.flatMap((note) =>
      [...note.decisions, ...note.actionItems].flatMap((item) =>
        item.timestampMs === undefined ? [] : [item.timestampMs],
      ),
    ),
  );
}

const textKey = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** 按 key 去重，保留首次出现的位置 */
function unique<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  combine: (kept: T, duplicate: T) => T,
) {
  const kept = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    const previous = kept.get(key);
    kept.set(key, previous === undefined ? item : combine(previous, item));
  }
  return [...kept.values()];
}

/** 重复条目取最早的来源时间 */
function earliest<T extends Sourced>(kept: T, duplicate: T): T {
  const times = [kept.timestampMs, duplicate.timestampMs].filter((time) => time !== undefined);
  return times.length ? { ...kept, timestampMs: Math.min(...times) } : kept;
}

const explicit = (kept: string, duplicate: string) => (kept === UNSPECIFIED ? duplicate : kept);

/** 去除完全重复的条目（忽略大小写和空白）；语义合并由合并 prompt 完成 */
export function dedupeNote(note: MeetingNote): MeetingNote {
  const same = <T>(kept: T) => kept;
  return {
    summary: note.summary,
    keyTopics: unique(note.keyTopics, textKey, same),
    decisions: unique(note.decisions, (item) => textKey(item.text), earliest),
    openQuestions: unique(note.openQuestions, textKey, same),
    actionItems: unique(
      note.actionItems,
      (item) => textKey(item.task),
      (kept, duplicate) => ({
        ...earliest(kept, duplicate),
        owner: explicit(kept.owner, duplicate.owner),
        dueDate: explicit(kept.dueDate, duplicate.dueDate),
      }),
    ),
  };
}

export interface GenerateNoteInput {
  segments: readonly TranscriptSegment[];
  /** meeting.keywords；只引导组织重点 */
  keywords?: readonly string[];
  /** 发送一次请求并返回 assistant content */
  request: (messages: ChatMessage[]) => Promise<string>;
  /** 0-100 整数，按已完成请求数计算 */
  onProgress?: (percent: number) => void;
  limits?: ChunkLimits;
}

/**
 * 短转写一次请求；长转写逐段生成中间纪要后再合并。任一请求、校验或合并失败都抛出，
 * 不返回部分结果，调用方据此结束任务并保留转写和已有版本。
 */
export async function generateNote(input: GenerateNoteInput): Promise<MeetingNote> {
  const chunks = chunkSegments(input.segments, input.limits);
  requireCondition(chunks.length > 0, 'INVALID_STATE');
  const keywords = input.keywords ?? [];
  const total = chunks.length === 1 ? 1 : chunks.length + 1;
  let completed = 0;
  async function step(messages: ChatMessage[], sources: ReadonlySet<number>) {
    const note = keepSources(parseNoteResponse(await input.request(messages)), sources);
    completed += 1;
    input.onProgress?.(Math.round((completed / total) * 100));
    return note;
  }

  input.onProgress?.(0);
  const partials: MeetingNote[] = [];
  for (const [i, chunk] of chunks.entries()) {
    const part = { index: i + 1, total: chunks.length };
    const starts = new Set(chunk.map((segment) => segment.startMs));
    partials.push(await step(buildNoteMessages(chunk, { keywords, part }), starts));
  }
  if (partials.length === 1) return dedupeNote(partials[0]);
  // 合并只能沿用中间纪要中已核对过的来源时间，不能引入新的
  return dedupeNote(await step(buildMergeMessages(partials, { keywords }), sourcesOf(partials)));
}
