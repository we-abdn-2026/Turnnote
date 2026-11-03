// 未打开会议：一句话，加一个主操作的位置感。其余信息都在会议库里。
import type { ReactElement } from 'react';

export function EmptyStage(): ReactElement {
  return (
    <div className="empty-stage">
      <h2 className="empty-stage-title">还没有打开会议</h2>
    </div>
  );
}
