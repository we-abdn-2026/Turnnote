// exports.markdown（#29）：Main 打开保存对话框，把用户已保存的最新纪要版本写成 Markdown。
// 取消不写文件；无纪要、会议不存在或写入失败返回稳定错误码，不改变任何会议记录。
import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { InvokeHandlers } from '@shared/invoke';
import { ok, requireCondition, TurnnoteError } from '@shared/result';
import type { MeetingStore } from '../storage/database';
import { markdownFileName, renderMeetingMarkdown, type RenderOptions } from './markdown-export';

export interface ExportOptions extends RenderOptions {
  /** 打开保存对话框，返回用户选择的绝对路径；用户取消返回 null */
  chooseSavePath: (defaultFileName: string) => Promise<string | null>;
}

/** 先写同目录临时文件再 rename：写入中途失败不会截断用户选中的已有文件 */
async function writeFileAtomically(target: string, content: string): Promise<void> {
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, target);
  } catch {
    await unlink(temporary).catch(() => {});
    throw new TurnnoteError('WRITE_FAILED');
  }
}

export function createExportHandlers(
  store: MeetingStore,
  options: ExportOptions,
): NonNullable<InvokeHandlers['exports']> {
  return {
    markdown: async (id) => {
      // 先检查，避免没有可导出的内容时仍弹出对话框
      requireCondition(store.getLatestNote(id), 'INVALID_STATE');
      const defaultFileName = markdownFileName(store.get(id).title);
      const target = await options.chooseSavePath(defaultFileName);
      if (target === null) return ok({ saved: false });
      requireCondition(isAbsolute(target), 'WRITE_FAILED');
      // 对话框打开期间用户可能保存了新编辑或重命名：以写入时刻已保存的最新版本为准
      const meeting = store.get(id);
      const latest = store.getLatestNote(id);
      requireCondition(latest, 'INVALID_STATE');
      await writeFileAtomically(target, renderMeetingMarkdown(meeting, latest.note, options));
      return ok({ saved: true });
    },
  };
}
