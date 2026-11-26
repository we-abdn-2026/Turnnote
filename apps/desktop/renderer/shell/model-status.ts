// 转写模型状态到提示条的纯映射。就绪时不打扰用户；其余状态给出明确的下一步。
import type { ModelStatus } from '@shared/contracts';
import { describeError } from '../ui/errors';

export interface ModelBannerView {
  tone: 'info' | 'error';
  title: string;
  detail: string;
  /** 0–1；仅下载中提供，用于进度条 */
  progress: number | null;
  action: { kind: 'download' | 'cancel'; label: string } | null;
}

const MB = 1000 * 1000;
const GB = 1000 * MB;

export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.round(bytes / MB)} MB`;
}

export function deriveModelBanner(status: ModelStatus | null): ModelBannerView | null {
  if (!status || status.state === 'ready') return null;
  const size = formatBytes(status.totalBytes);
  switch (status.state) {
    case 'missing':
      return status.downloadable
        ? {
            tone: 'info',
            title: '转写模型尚未下载',
            detail: `首次转写需要下载约 ${size} 的本地模型。音频不会离开这台电脑。`,
            progress: null,
            action: { kind: 'download', label: '下载' },
          }
        : {
            tone: 'error',
            title: '找不到转写模型',
            detail:
              '当前设置的模型不在内置清单中，请把完整的模型文件夹放进应用数据目录的 models 文件夹。',
            progress: null,
            action: null,
          };
    case 'downloading': {
      const progress =
        status.totalBytes > 0 ? Math.min(1, status.downloadedBytes / status.totalBytes) : 0;
      return {
        tone: 'info',
        title: '正在下载转写模型',
        detail: `${Math.floor(progress * 100)}% · ${formatBytes(status.downloadedBytes)} / ${size}。下载完成后会自动开始转写。`,
        progress,
        action: { kind: 'cancel', label: '取消' },
      };
    }
    case 'failed':
      return {
        tone: 'error',
        title: '转写模型下载失败',
        detail: describeError(status.error),
        progress: null,
        action: { kind: 'download', label: '重试' },
      };
  }
}
