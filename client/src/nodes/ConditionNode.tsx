/**
 * 条件分支节点：正文显示规则摘要「包含『xx』→ 真出口，否则假出口」，
 * 判定对象为上游文本（引擎 Task 5 执行）。
 */
import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import { readConditionConfig } from './nodeConfigs';
import { Chip } from '../components/Chip';
import type { CanvasNode } from '../store/canvasStore';

function ConditionNodeInner({ id, data, selected }: NodeProps<CanvasNode>) {
  const config = readConditionConfig(data.config);

  return (
    <NodeShell id={id} data={data} selected={selected}>
      <div className="p-2">
        <p className="text-[11px] leading-snug text-ink-muted">
          包含『
          <span className={config.keyword ? 'text-ink' : 'text-ink-muted'}>
            {config.keyword || '…'}
          </span>
          』→ 真出口，否则假出口
        </p>
        {config.caseSensitive && (
          <div className="mt-1.5">
            <Chip>区分大小写</Chip>
          </div>
        )}
      </div>
    </NodeShell>
  );
}

export const ConditionNode = memo(ConditionNodeInner);
