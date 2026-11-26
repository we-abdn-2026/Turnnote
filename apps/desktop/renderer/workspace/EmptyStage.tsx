// 未打开会议：只留状态和唯一的动作。会议库、设备条和录音条已经把界面摆出来了，这里不再解释。
import type { ReactElement } from 'react';
import { Icon } from '../ui/icons';

export function EmptyStage({ onCreate }: { onCreate(): void }): ReactElement {
  return (
    <div className="empty-stage">
      <p className="empty-stage-note">还没有打开会议</p>
      <button type="button" className="key key-quiet" onClick={onCreate}>
        <Icon name="plus" />
        新建会议
      </button>
    </div>
  );
}
