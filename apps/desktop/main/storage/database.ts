import Database from 'better-sqlite3';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  AppSettings,
  ErrorCode,
  JobKind,
  MeetingDetail,
  MeetingNote,
  MeetingStatus,
  MeetingSummary,
  NoteOrigin,
  NoteVersion,
  TranscriptSegment,
} from '@shared/contracts';
import { canCancelRecording, canEditNote, canStartJob } from '@shared/lifecycle';
import { errorMessages, requireCondition } from '@shared/result';
import {
  defaultSettings,
  errorCodeSchema,
  expectedVersionSchema,
  keywordsSchema,
  meetingIdSchema,
  meetingNoteSchema,
  parseInput,
  querySchema,
  settingsPatchSchema,
  settingsSchema,
  titleSchema,
  transcriptSegmentsSchema,
} from '@shared/schemas';
import { migrate } from './migrations';

export interface AudioAsset {
  id: string;
  meetingId: string;
  filePath: string;
  createdAt: string;
  /** 这是会议的第几段录音（导入的音频是第 1 段） */
  partNo: number;
  /** 已转写过；为 false 表示还在等待转写 */
  transcribed: boolean;
}
/** 一次转写任务里每一段音频的结果；segments 的时间已加上这段在整场会议里的起点 */
export interface TranscribedPart {
  assetId: string;
  /** 解码后的音频时长，下一段录音的转写从这里接着计时 */
  durationMs: number;
}
const AUDIO_COLUMNS =
  'id, meeting_id AS meetingId, file_path AS filePath, created_at AS createdAt, part_no AS partNo, transcribed_at IS NOT NULL AS transcribed';
export interface ProcessingJob {
  id: string;
  meetingId: string;
  kind: JobKind;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  attempt: number;
  baseNoteVersion: number | null;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}
interface MeetingRow {
  id: string;
  title: string;
  status: MeetingStatus;
  retain_audio: number;
  keywords: string;
  created_at: string;
  updated_at: string;
  timeline_ms: number;
  transcript_revision: number;
  note_stale?: number;
}
interface JobRow {
  id: string;
  meeting_id: string;
  kind: JobKind;
  status: ProcessingJob['status'];
  attempt: number;
  base_note_version: number | null;
  error_code: ErrorCode | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}
interface NoteRow {
  version: number;
  source: NoteVersion['source'];
  content_json: string;
  created_at: string;
  generated_by: string | null;
}
export interface CustomProviderRecord {
  id: string;
  label: string;
  baseUrl: string;
  needsKey: boolean;
}
const noteOriginSchema = z.strictObject({
  provider: z.string().min(1).max(64),
  label: z.string().min(1).max(40),
  model: z.string().min(1).max(100),
  // 没有这个字段的记录（本字段加入前写入的）按"非本机"处理：宁可多提醒也不漏提醒
  local: z.boolean().default(false),
});

/** 最新纪要的转写修订落后于会议当前的转写修订 */
const NOTE_STALE_SQL = `EXISTS (
  SELECT 1 FROM note_versions n
  WHERE n.meeting_id = m.id
    AND n.version = (SELECT MAX(version) FROM note_versions WHERE meeting_id = m.id)
    AND n.transcript_revision < m.transcript_revision)`;

const RELEASABLE_STATUSES: readonly MeetingStatus[] = ['transcribed', 'generating', 'ready'];

/** 同步事务只拥有数据库；文件写入/删除和事件发布由 Main 服务在事务外协调。 */
export class MeetingStore {
  private readonly db: Database.Database;
  private readonly audioDirectory: string;

  constructor(databasePath: string, audioDirectory: string) {
    this.audioDirectory = resolve(audioDirectory);
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    try {
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000');
      migrate(this.db);
      this.db.pragma('journal_mode = WAL');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private atomic<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }

  private row(id: string, includeDeleted = false): MeetingRow {
    id = parseInput(meetingIdSchema, id);
    const row = this.db
      .prepare(`SELECT m.*, ${NOTE_STALE_SQL} AS note_stale FROM meetings m WHERE m.id = ?`)
      .get(id) as MeetingRow | undefined;
    requireCondition(row && (includeDeleted || row.status !== 'deleted'), 'NOT_FOUND');
    return row;
  }

  get(id: string, includeDeleted = false): MeetingDetail {
    const row = this.row(id, includeDeleted);
    const failed =
      row.status === 'failed'
        ? (this.db
            .prepare(
              'SELECT * FROM processing_jobs WHERE meeting_id = ? ORDER BY rowid DESC LIMIT 1',
            )
            .get(row.id) as JobRow | undefined)
        : undefined;
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      retainAudio: row.retain_audio === 1,
      hasAudio: this.getAudio(row.id) !== null,
      noteStale: row.note_stale === 1,
      keywords: parseInput(keywordsSchema, JSON.parse(row.keywords)),
      activeJobId:
        (
          this.db
            .prepare(
              "SELECT id FROM processing_jobs WHERE meeting_id = ? AND status IN ('pending','running')",
            )
            .get(row.id) as { id: string } | undefined
        )?.id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastError:
        failed?.status === 'failed' && failed.error_code
          ? {
              kind: failed.kind,
              jobId: failed.id,
              code: failed.error_code,
              message: errorMessages[failed.error_code],
            }
          : null,
    };
  }

  list(query?: string): MeetingSummary[] {
    const q = parseInput(querySchema, query) ?? '';
    const rows = this.db
      .prepare(
        `SELECT id, title, status, created_at, updated_at, ${NOTE_STALE_SQL} AS note_stale FROM meetings m
      WHERE status != 'deleted' AND (? = '' OR instr(lower(title), lower(?)) > 0 OR EXISTS (
        SELECT 1 FROM transcript_segments s WHERE s.meeting_id = m.id AND instr(lower(s.text), lower(?)) > 0
      )) ORDER BY created_at DESC, id DESC`,
      )
      .all(q, q, q) as MeetingRow[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      noteStale: row.note_stale === 1,
    }));
  }

  create(title: string): MeetingDetail {
    title = parseInput(titleSchema, title);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO meetings(id,title,status,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(id, title, 'created', now, now);
    return this.get(id);
  }

  private update(
    id: string,
    field: 'title' | 'keywords' | 'retain_audio',
    value: string | number,
  ): MeetingDetail {
    return this.atomic(() => {
      this.row(id);
      this.db
        .prepare(`UPDATE meetings SET ${field} = ?, updated_at = ? WHERE id = ?`)
        .run(value, new Date().toISOString(), id);
      return this.get(id);
    });
  }
  rename(id: string, title: string): MeetingDetail {
    return this.update(id, 'title', parseInput(titleSchema, title));
  }
  setKeywords(id: string, keywords: string[]): MeetingDetail {
    return this.update(id, 'keywords', JSON.stringify(parseInput(keywordsSchema, keywords)));
  }
  setRetainAudio(id: string, retain: boolean): MeetingDetail {
    requireCondition(typeof retain === 'boolean', 'INVALID_INPUT');
    return this.update(id, 'retain_audio', retain ? 1 : 0);
  }

  private audios(id: string, where = ''): AudioAsset[] {
    const rows = this.db
      .prepare(
        `SELECT ${AUDIO_COLUMNS} FROM audio_assets WHERE meeting_id = ? ${where} ORDER BY part_no`,
      )
      .all(id) as (Omit<AudioAsset, 'transcribed'> & { transcribed: number })[];
    return rows.map((row) => ({ ...row, transcribed: row.transcribed === 1 }));
  }
  /** 会议的所有音频，按录音先后 */
  getAudios(id: string): AudioAsset[] {
    return this.audios(id);
  }
  /** 还没转写的音频，按录音先后；转写任务按这个顺序处理 */
  getPendingAudio(id: string): AudioAsset[] {
    return this.audios(id, 'AND transcribed_at IS NULL');
  }
  /** 最新一段音频：正在录或刚录完的那段，录音恢复和丢弃都作用于它 */
  getAudio(id: string): AudioAsset | null {
    return this.audios(id).at(-1) ?? null;
  }
  /** 已转写音频的总时长；下一段录音的转写时间从这里开始 */
  getTimelineMs(id: string): number {
    return this.row(id).timeline_ms;
  }

  private attachAudio(id: string, filePath: string): void {
    requireCondition(typeof filePath === 'string' && isAbsolute(filePath), 'INVALID_INPUT');
    let path = resolve(filePath);
    const child = relative(this.audioDirectory, path);
    requireCondition(
      child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child),
      'INVALID_INPUT',
    );
    // 录音文件可以尚未创建，但父目录须存在；别名统一到实际目录后登记所有权。
    path = resolve(realpathSync(dirname(path)), basename(path));
    const actualChild = relative(realpathSync(this.audioDirectory), path);
    requireCondition(
      actualChild &&
        actualChild !== '..' &&
        !actualChild.startsWith(`..${sep}`) &&
        !isAbsolute(actualChild),
      'INVALID_INPUT',
    );
    requireCondition(
      !lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink(),
      'INVALID_INPUT',
    );
    const partNo =
      (
        this.db
          .prepare('SELECT COALESCE(MAX(part_no), 0) AS n FROM audio_assets WHERE meeting_id = ?')
          .get(id) as { n: number }
      ).n + 1;
    this.db
      .prepare(
        'INSERT INTO audio_assets(id,meeting_id,file_path,created_at,part_no) VALUES(?,?,?,?,?)',
      )
      .run(randomUUID(), id, path, new Date().toISOString(), partNo);
  }

  createCaptured(title: string, filePath: string): MeetingDetail {
    return this.atomic(() => {
      const meeting = this.create(title);
      this.attachAudio(meeting.id, filePath);
      this.setStatus(meeting.id, 'captured');
      return this.get(meeting.id);
    });
  }

  private setStatus(id: string, status: MeetingStatus): void {
    this.db
      .prepare('UPDATE meetings SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
  }

  private begin(id: string, kind: JobKind): ProcessingJob {
    requireCondition(
      canStartJob(this.get(id), kind, this.getSegments(id).length > 0),
      'INVALID_STATE',
    );
    const attempt =
      (
        this.db
          .prepare(
            'SELECT COALESCE(MAX(attempt),0) AS attempt FROM processing_jobs WHERE meeting_id = ? AND kind = ?',
          )
          .get(id, kind) as { attempt: number }
      ).attempt + 1;
    const jobId = randomUUID();
    const now = new Date().toISOString();
    const baseVersion = kind === 'generating' ? (this.getLatestNote(id)?.version ?? 0) : null;
    this.db
      .prepare(
        `INSERT INTO processing_jobs(id,meeting_id,kind,status,attempt,base_note_version,created_at,updated_at)
      VALUES(?,?,?,'running',?,?,?,?)`,
      )
      .run(jobId, id, kind, attempt, baseVersion, now, now);
    this.setStatus(id, kind);
    return this.getJob(jobId)!;
  }

  beginRecording(id: string, filePath: string): ProcessingJob {
    return this.atomic(() => {
      const job = this.begin(id, 'recording');
      this.attachAudio(id, filePath);
      return job;
    });
  }
  beginTranscription(id: string): ProcessingJob {
    return this.atomic(() => this.begin(id, 'transcribing'));
  }
  beginGeneration(id: string): ProcessingJob {
    return this.atomic(() => this.begin(id, 'generating'));
  }

  getJob(id: string): ProcessingJob | null {
    const row = this.db.prepare('SELECT * FROM processing_jobs WHERE id = ?').get(id) as
      JobRow | undefined;
    return row
      ? {
          id: row.id,
          meetingId: row.meeting_id,
          kind: row.kind,
          status: row.status,
          attempt: row.attempt,
          baseNoteVersion: row.base_note_version,
          errorCode: row.error_code,
          errorMessage: row.error_message,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  }
  getJobs(id: string): ProcessingJob[] {
    this.row(id);
    const rows = this.db
      .prepare('SELECT id FROM processing_jobs WHERE meeting_id = ? ORDER BY rowid')
      .all(id) as { id: string }[];
    return rows.map((row) => this.getJob(row.id)!);
  }
  private activeJob(id: string, kind?: JobKind): ProcessingJob | null {
    const job = this.getJob(id);
    if (!job || job.status !== 'running' || (kind && job.kind !== kind)) return null;
    const meeting = this.db
      .prepare('SELECT status FROM meetings WHERE id = ?')
      .get(job.meetingId) as { status: MeetingStatus } | undefined;
    return meeting?.status === job.kind ? job : null;
  }
  isJobCurrent(id: string): boolean {
    return this.activeJob(id) !== null;
  }
  private finishJob(job: ProcessingJob, status: 'completed' | 'cancelled'): void {
    this.db
      .prepare('UPDATE processing_jobs SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), job.id);
  }

  finishRecording(jobId: string): boolean {
    return this.atomic(() => {
      const job = this.activeJob(jobId, 'recording');
      if (!job) return false;
      this.finishJob(job, 'completed');
      this.setStatus(job.meetingId, 'captured');
      return true;
    });
  }

  /** 调用方先停止采集并删除文件，成功后才调用本方法。失败录音也可显式丢弃。 */
  cancelRecording(id: string, jobId: string): MeetingDetail {
    return this.atomic(() => {
      const meeting = this.get(id);
      requireCondition(
        canCancelRecording(meeting) && (meeting.activeJobId ?? meeting.lastError?.jobId) === jobId,
        'INVALID_STATE',
      );
      this.db
        .prepare(
          "UPDATE processing_jobs SET status = 'cancelled', updated_at = ? WHERE meeting_id = ? AND status IN ('pending','running')",
        )
        .run(new Date().toISOString(), id);
      // 只丢弃这一段（最新的一段）；之前已录的各段和已有转写、纪要都保留
      const discarded = this.getAudio(id);
      if (discarded) this.db.prepare('DELETE FROM audio_assets WHERE id = ?').run(discarded.id);
      this.setStatus(id, this.settledStatus(id));
      return this.get(id);
    });
  }

  /** 没有进行中的任务时，会议应处的状态：有待转写的音频、有转写（有纪要则 ready）、或还是空的 */
  private settledStatus(id: string): MeetingStatus {
    if (this.getPendingAudio(id).length > 0) return 'captured';
    if (this.getSegments(id).length > 0 || this.getTimelineMs(id) > 0) {
      return this.getLatestNote(id) ? 'ready' : 'transcribed';
    }
    return 'created';
  }

  cancelTranscription(id: string, jobId: string): MeetingDetail {
    return this.atomic(() => {
      const meeting = this.get(id);
      requireCondition(
        meeting.status === 'transcribing' && meeting.activeJobId === jobId,
        'INVALID_STATE',
      );
      this.db
        .prepare(
          "UPDATE processing_jobs SET status = 'cancelled', updated_at = ? WHERE meeting_id = ? AND status = 'running'",
        )
        .run(new Date().toISOString(), id);
      this.setStatus(id, 'captured');
      return this.get(id);
    });
  }

  failJob(jobId: string, code: ErrorCode): boolean {
    code = parseInput(errorCodeSchema, code);
    return this.atomic(() => {
      const job = this.activeJob(jobId);
      if (!job) return false;
      this.db
        .prepare(
          "UPDATE processing_jobs SET status = 'failed', error_code = ?, error_message = ?, updated_at = ? WHERE id = ?",
        )
        .run(code, errorMessages[code], new Date().toISOString(), job.id);
      this.setStatus(job.meetingId, 'failed');
      return true;
    });
  }

  getSegments(id: string): TranscriptSegment[] {
    this.row(id);
    return this.db
      .prepare(
        'SELECT start_ms AS startMs,end_ms AS endMs,text FROM transcript_segments WHERE meeting_id = ? ORDER BY sequence',
      )
      .all(id) as TranscriptSegment[];
  }
  /**
   * 提交一次转写：把新片段追加到已有转写之后，标记这些音频已转写，累加时间线并递增转写修订。
   * segments 的时间已包含各段音频的起点；parts 缺省时，把所有待转写音频都视为已转写，
   * 时间线推进到最后一个片段的结束（用于不经过转写服务的调用方）。
   */
  completeTranscription(
    jobId: string,
    segments: TranscriptSegment[],
    parts?: readonly TranscribedPart[],
  ): boolean {
    return this.atomic(() => {
      const job = this.activeJob(jobId, 'transcribing');
      if (!job) return false;
      const validated = parseInput(transcriptSegmentsSchema, segments);
      const existing = this.db
        .prepare(
          'SELECT COALESCE(MAX(sequence), -1) AS last, COALESCE(MAX(start_ms), 0) AS lastStart FROM transcript_segments WHERE meeting_id = ?',
        )
        .get(job.meetingId) as { last: number; lastStart: number };
      // 追加的片段不能排到已有片段之前，否则时间轴会乱
      requireCondition(
        validated.length === 0 || validated[0].startMs >= existing.lastStart,
        'INVALID_INPUT',
      );
      const insert = this.db.prepare(
        'INSERT INTO transcript_segments(meeting_id,sequence,start_ms,end_ms,text) VALUES(?,?,?,?,?)',
      );
      validated.forEach((segment, i) =>
        insert.run(
          job.meetingId,
          existing.last + 1 + i,
          segment.startMs,
          segment.endMs,
          segment.text,
        ),
      );
      const pending = this.getPendingAudio(job.meetingId);
      const done = parts ?? pending.map((asset) => ({ assetId: asset.id, durationMs: 0 }));
      const now = new Date().toISOString();
      for (const part of done) {
        const changed = this.db
          .prepare(
            'UPDATE audio_assets SET transcribed_at = ? WHERE id = ? AND meeting_id = ? AND transcribed_at IS NULL',
          )
          .run(now, part.assetId, job.meetingId).changes;
        requireCondition(changed === 1, 'INVALID_STATE');
      }
      const timeline = parts
        ? this.getTimelineMs(job.meetingId) +
          parts.reduce((total, part) => total + part.durationMs, 0)
        : Math.max(this.getTimelineMs(job.meetingId), validated.at(-1)?.endMs ?? 0);
      this.db
        .prepare(
          'UPDATE meetings SET timeline_ms = ?, transcript_revision = transcript_revision + 1 WHERE id = ?',
        )
        .run(timeline, job.meetingId);
      this.finishJob(job, 'completed');
      this.setStatus(job.meetingId, this.getLatestNote(job.meetingId) ? 'ready' : 'transcribed');
      return true;
    });
  }

  getLatestNote(id: string): NoteVersion | null {
    this.row(id);
    const row = this.db
      .prepare('SELECT * FROM note_versions WHERE meeting_id = ? ORDER BY version DESC LIMIT 1')
      .get(id) as NoteRow | undefined;
    return row
      ? {
          version: row.version,
          source: row.source,
          note: parseInput(meetingNoteSchema, JSON.parse(row.content_json)),
          createdAt: row.created_at,
          generatedBy: row.generated_by
            ? parseInput(noteOriginSchema, JSON.parse(row.generated_by))
            : null,
        }
      : null;
  }
  private insertNote(
    id: string,
    note: MeetingNote,
    source: NoteVersion['source'],
    generatedBy: NoteOrigin | null = null,
  ): NoteVersion {
    const version = (this.getLatestNote(id)?.version ?? 0) + 1;
    // AI 生成的版本看到的是当前全部转写；用户编辑沿用上一版的修订，不会因为编辑就变成"最新"，
    // 首次手写纪要则视为基于当前转写
    const current = this.row(id).transcript_revision;
    const revision =
      source === 'generated'
        ? current
        : ((
            this.db
              .prepare(
                'SELECT transcript_revision AS r FROM note_versions WHERE meeting_id = ? ORDER BY version DESC LIMIT 1',
              )
              .get(id) as { r: number } | undefined
          )?.r ?? current);
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO note_versions(meeting_id,version,source,content_json,created_at,generated_by,transcript_revision) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        id,
        version,
        source,
        JSON.stringify(note),
        createdAt,
        generatedBy ? JSON.stringify(generatedBy) : null,
        revision,
      );
    return { version, source, note, createdAt, generatedBy };
  }
  /** generatedBy 记录这一版由哪个服务和模型生成；省略表示来源未知（例如旧版本数据） */
  completeGeneration(jobId: string, note: MeetingNote, generatedBy?: NoteOrigin): boolean {
    return this.atomic(() => {
      const job = this.activeJob(jobId, 'generating');
      if (!job) return false;
      const validated = parseInput(meetingNoteSchema, note);
      const origin = generatedBy ? parseInput(noteOriginSchema, generatedBy) : null;
      requireCondition(
        (this.getLatestNote(job.meetingId)?.version ?? 0) === job.baseNoteVersion,
        'CONFLICT',
      );
      this.insertNote(job.meetingId, validated, 'generated', origin);
      this.finishJob(job, 'completed');
      this.setStatus(job.meetingId, 'ready');
      return true;
    });
  }
  saveEdit(id: string, note: MeetingNote, expectedVersion: number): NoteVersion {
    const validated = parseInput(meetingNoteSchema, note);
    expectedVersion = parseInput(expectedVersionSchema, expectedVersion);
    return this.atomic(() => {
      const meeting = this.get(id);
      requireCondition(canEditNote(meeting), 'INVALID_STATE');
      requireCondition((this.getLatestNote(id)?.version ?? 0) === expectedVersion, 'CONFLICT');
      const version = this.insertNote(id, validated, 'user');
      if (meeting.status !== 'generating') this.setStatus(id, 'ready');
      return version;
    });
  }

  /**
   * 转写已可靠入库且用户未选择保留时可以清理的音频（已转写的各段），否则为空。
   * 还在等待转写的音频、failed / captured 状态下的音频是重试输入，永远不可清理。
   */
  getReleasableAudio(id: string): AudioAsset[] {
    const meeting = this.get(id);
    if (meeting.retainAudio || !RELEASABLE_STATUSES.includes(meeting.status)) return [];
    return this.audios(id, 'AND transcribed_at IS NOT NULL');
  }

  /** 文件先删除，再清理引用；并发修改保留标志后不再允许删除。由 Main 串行协调文件操作。 */
  removeAudioReference(id: string, assetId: string): void {
    this.atomic(() => {
      const meeting = this.get(id);
      requireCondition(
        !meeting.retainAudio && RELEASABLE_STATUSES.includes(meeting.status),
        'INVALID_STATE',
      );
      requireCondition(
        this.audios(id, 'AND transcribed_at IS NOT NULL').some((asset) => asset.id === assetId),
        'CONFLICT',
      );
      this.db.prepare('DELETE FROM audio_assets WHERE id = ?').run(assetId);
    });
  }

  markDeleted(id: string): MeetingDetail {
    return this.atomic(() => {
      this.row(id, true);
      this.db
        .prepare(
          "UPDATE processing_jobs SET status = 'cancelled', updated_at = ? WHERE meeting_id = ? AND status IN ('pending','running')",
        )
        .run(new Date().toISOString(), id);
      this.setStatus(id, 'deleted');
      return this.get(id, true);
    });
  }
  purgeDeleted(id: string): void {
    this.atomic(() => {
      requireCondition(this.row(id, true).status === 'deleted', 'INVALID_STATE');
      this.db.prepare('DELETE FROM meetings WHERE id = ?').run(id);
    });
  }
  getDeleted(): MeetingDetail[] {
    const ids = this.db.prepare("SELECT id FROM meetings WHERE status = 'deleted'").all() as {
      id: string;
    }[];
    return ids.map(({ id }) => this.get(id, true));
  }

  /** #4 只恢复被中断的 ASR/生成任务；录音 header 修复由 #5 的 AudioWriter 负责。 */
  interruptProcessing(): void {
    this.atomic(() => {
      const jobs = this.db
        .prepare(
          "SELECT id FROM processing_jobs WHERE status IN ('pending','running') AND kind IN ('transcribing','generating')",
        )
        .all() as { id: string }[];
      jobs.forEach(({ id }) => {
        // 历史库可能留下 pending；在同一事务中结束，重启不隐式重试外部请求。
        this.db
          .prepare(
            "UPDATE processing_jobs SET status = 'running' WHERE id = ? AND status = 'pending'",
          )
          .run(id);
        this.failJob(id, 'INTERRUPTED');
      });
    });
  }

  listCustomProviders(): CustomProviderRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, label, base_url AS baseUrl, needs_key AS needsKey FROM custom_providers ORDER BY created_at, id',
      )
      .all() as (Omit<CustomProviderRecord, 'needsKey'> & { needsKey: number })[];
    return rows.map((row) => ({ ...row, needsKey: row.needsKey === 1 }));
  }
  /** 新增或按 id 覆盖；调用方已校验网址和名称 */
  saveCustomProvider(record: CustomProviderRecord): void {
    this.db
      .prepare(
        `INSERT INTO custom_providers(id,label,base_url,needs_key,created_at) VALUES(?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, base_url = excluded.base_url, needs_key = excluded.needs_key`,
      )
      .run(
        record.id,
        record.label,
        record.baseUrl,
        record.needsKey ? 1 : 0,
        new Date().toISOString(),
      );
  }
  /** 删除服务商；如果它正在使用，同一事务内把设置改回给定的默认服务商和模型 */
  removeCustomProvider(
    id: string,
    fallback: Pick<AppSettings, 'noteProvider' | 'noteModel'>,
  ): void {
    this.atomic(() => {
      this.db.prepare('DELETE FROM custom_providers WHERE id = ?').run(id);
      if (this.getSettings().noteProvider === id) this.updateSettings(fallback);
    });
  }

  getSettings(): AppSettings {
    const settings: Record<string, unknown> = { ...defaultSettings };
    const rows = this.db.prepare('SELECT key,value FROM app_settings').all() as {
      key: string;
      value: string;
    }[];
    rows.forEach(({ key, value }) => {
      settings[key] = JSON.parse(value);
    });
    return parseInput(settingsSchema, settings);
  }
  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const validated = parseInput(settingsPatchSchema, patch);
    return this.atomic(() => {
      const insert = this.db.prepare(
        'INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      );
      Object.entries(validated).forEach(([key, value]) => insert.run(key, JSON.stringify(value)));
      return this.getSettings();
    });
  }
}
