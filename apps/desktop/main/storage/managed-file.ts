import { realpathSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { requireCondition, TurnnoteError } from '@shared/result';

/**
 * 删除应用管理目录内的音频文件。文件已不存在视为成功，使清理可以安全重试；
 * 目录外路径（包括被符号链接替换的父目录）一律拒绝，绝不触碰用户原始文件。
 * 失败时抛出 WRITE_FAILED，不携带路径。
 */
export function removeManagedFile(audioDirectory: string, filePath: string): void {
  try {
    const root = realpathSync(audioDirectory);
    const parent = realpathSync(dirname(filePath));
    const child = relative(root, resolve(parent, basename(filePath)));
    requireCondition(
      child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child),
      'WRITE_FAILED',
    );
    unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new TurnnoteError('WRITE_FAILED');
  }
}
