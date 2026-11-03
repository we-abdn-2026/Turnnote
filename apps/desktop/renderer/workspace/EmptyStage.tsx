// 未打开会议：一句话和一个主操作。点击聚焦会议库的新建输入。
import type { ReactElement } from 'react';
import { Icon } from '../ui/icons';

export function EmptyStage(): ReactElement {
  return (
    <div className="empty-stage">
      <h2 className="empty-stage-title">还没有打开会议</h2>
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
    </div>
  );
}
