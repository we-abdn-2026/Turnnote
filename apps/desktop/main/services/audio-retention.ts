// 音频保留策略（#27）。转写可靠入库且会议未选择保留时，清理应用管理的音频文件和引用。
// 顺序固定为「事务已提交的转写 → 删除文件 → 清除引用」：任何一步中断都不会丢失唯一音频，
// 文件已删而引用残留时，下一次 sweep / release 以 ENOENT 视为成功并完成收敛。
// 全程同步，保留标志的检查与文件删除之间不会插入其他 IPC 处理。
import type { MeetingStore } from '../storage/database';
import { removeManagedFile } from '../storage/managed-file';
import { TurnnoteError } from '@shared/result';
import type { SafeLogger } from '../safe-logger';

export function createAudioRetention(
  store: MeetingStore,
  audioDirectory: string,
  logger?: SafeLogger,
) {
  /** 清理可清理的音频；返回是否移除了引用。文件系统失败时抛出 WRITE_FAILED，引用保持不变。 */
  function release(id: string): boolean {
    const audio = store.getReleasableAudio(id);
    if (!audio) return false;
    removeManagedFile(audioDirectory, audio.filePath);
    store.removeAudioReference(id, audio.id);
    return true;
  }

  /** 失败只记录稳定错误码；转写结果已提交，清理失败不能反向改变会议状态。 */
  function tryRelease(id: string): boolean {
    try {
      return release(id);
    } catch (error) {
      logger?.error(
        'main',
        'audio_cleanup_failed',
        error instanceof TurnnoteError ? error.code : 'INTERNAL',
        error,
      );
      return false;
    }
  }

  return {
    release,
    tryRelease,
    /** 启动时收敛上次中断或失败的清理，以及本功能上线前遗留的音频。 */
    sweep(): void {
      for (const { id } of store.list()) tryRelease(id);
    },
  };
}
