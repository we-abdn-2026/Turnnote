// 未打开会议：一句说明、一个主操作和两个快捷键提示。点击主操作聚焦会议库的新建输入。
import type { ReactElement } from 'react';
import { Icon } from '../ui/icons';
import { shortcutLabel } from '../ui/shortcuts';

export function EmptyStage(): ReactElement {
  return (
    <div className="empty-stage">
      <h2 className="empty-stage-title">还没有打开会议</h2>
      <p className="empty-stage-copy">
        从左侧选择一场会议，或新建一场。转写在本机完成，音频不会上传。
      </p>
      <button
        type="button"
        className="key key-primary empty-stage-action"
        onClick={() => {
          const input = document.getElementById('meeting-title');
          input?.focus();
          document.querySelector('.library')?.classList.add('is-prompted');
          window.setTimeout(
            () => document.querySelector('.library')?.classList.remove('is-prompted'),
            900,
          );
        }}
      >
        <Icon name="plus" />
        新建会议
      </button>
      <div className="empty-stage-keys" aria-hidden="true">
        <span>
          <kbd>{shortcutLabel('n')}</kbd>新建会议
        </span>
        <span>
          <kbd>{shortcutLabel('k')}</kbd>搜索
        </span>
      </div>
    </div>
  );
}
