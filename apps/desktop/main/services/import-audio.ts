// meetings.importAudio（#90）：Main 打开文件选择，把用户选的音频复制进应用管理目录，
// 创建 captured 会议并触发自动转写。Renderer 不提交路径；原始文件只读，永远不会被修改或删除。
// 之后的保留/清理沿用 #27 的策略，清理只作用于管理目录内的副本。
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import type { MeetingDetail } from '@shared/contracts';
import type { InvokeHandlers } from '@shared/invoke';
import { ok, requireCondition, TurnnoteError } from '@shared/result';
import type { MeetingStore } from '../storage/database';
import { removeManagedFile } from '../storage/managed-file';

/** 与 sidecar（services/asr-worker/worker.py 的 AUDIO_EXTENSIONS）保持一致；测试校验两者同步 */
export const IMPORT_EXTENSIONS = ['.wav', '.mp3', '.m4a'] as const;
/** 单文件上限：防止误选超大文件占满磁盘；1 小时 48 kHz 立体声 WAV 约 0.7 GiB */
export const MAX_IMPORT_BYTES = 2 * 1024 ** 3;
const DEFAULT_TITLE = '导入的音频';
const MAX_TITLE_LENGTH = 200;

export interface ImportOptions {
  audioDirectory: string;
  /** 打开文件选择，返回所选文件的绝对路径；用户取消返回 null */
  chooseFile: () => Promise<string | null>;
  emit: (meeting: MeetingDetail) => void;
  /** 触发自动转写（与录音停止后相同的入口） */
  schedule: (meetingId: string) => void;
  /** 单文件上限，默认 MAX_IMPORT_BYTES；测试注入小值 */
  maxBytes?: number;
}

function titleFor(sourcePath: string): string {
  const name = basename(sourcePath, extname(sourcePath)).replace(/\s+/g, ' ').trim();
  return [...name].slice(0, MAX_TITLE_LENGTH).join('') || DEFAULT_TITLE;
}

/** 校验来源并返回规范化扩展名；失败不产生任何副作用 */
async function inspectSource(sourcePath: string, maxBytes: number): Promise<string> {
  requireCondition(isAbsolute(sourcePath), 'AUDIO_NOT_FOUND');
  const extension = extname(sourcePath).toLowerCase();
  // 不支持的格式与无法解码同属 AUDIO_DECODE_FAILED（docs/sidecar-protocol.md）
  requireCondition(
    (IMPORT_EXTENSIONS as readonly string[]).includes(extension),
    'AUDIO_DECODE_FAILED',
  );
  let size: number;
  try {
    const info = await stat(sourcePath);
    requireCondition(info.isFile(), 'AUDIO_NOT_FOUND');
    size = info.size;
  } catch {
    throw new TurnnoteError('AUDIO_NOT_FOUND');
  }
  requireCondition(size > 0, 'AUDIO_DECODE_FAILED');
  requireCondition(size <= maxBytes, 'INVALID_INPUT');
  return extension;
}

export function createImportHandlers(
  store: MeetingStore,
  options: ImportOptions,
): NonNullable<InvokeHandlers['meetings']> {
  /** 回收尚未被会议引用的副本；回收失败不掩盖原始错误 */
  function discard(target: string): void {
    try {
      removeManagedFile(options.audioDirectory, target);
    } catch {
      /* 原始错误更有诊断价值 */
    }
  }

  return {
    importAudio: async () => {
      const sourcePath = await options.chooseFile();
      if (sourcePath === null) return ok(null);
      const extension = await inspectSource(sourcePath, options.maxBytes ?? MAX_IMPORT_BYTES);
      // 随机文件名：不沿用用户路径和文件名，副本与原文件之间没有任何关联
      const target = join(options.audioDirectory, `${randomUUID()}${extension}`);
      try {
        await copyFile(sourcePath, target, constants.COPYFILE_EXCL);
      } catch {
        discard(target);
        throw new TurnnoteError('WRITE_FAILED');
      }
      // 已知限制：进程恰在复制完成与入库提交之间被终止时，会留下一个无人引用的副本。
      // 只占用磁盘，不丢数据，也不影响原文件；正常失败路径都会回收。
      let meeting: MeetingDetail;
      try {
        meeting = store.createCaptured(titleFor(sourcePath), target);
      } catch (error) {
        discard(target);
        throw error;
      }
      options.emit(meeting);
      options.schedule(meeting.id);
      return ok(meeting);
    },
  };
}
