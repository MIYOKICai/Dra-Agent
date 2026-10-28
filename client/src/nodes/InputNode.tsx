/**
 * 输入节点：正文内嵌 textarea 直接编辑 config.text，
 * 运行时（Task 5）文本作为 {{节点名}} 变量供下游节点引用。
 */
import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import { readInputConfig } from './nodeConfigs';
import { useCanvasStore, type CanvasNode } from '../store/canvasStore';

function InputNodeInner({ id, data, selected }: NodeProps<CanvasNode>) {
  const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
  const config = readInputConfig(data.config);

  return (
    <NodeShell id={id} data={data} selected={selected}>
      <div className="px-2.5 pb-2.5 pt-1.5">
        <textarea
          className="nodrag nowheel h-20 w-full resize-none rounded border border-line bg-base px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-ink-muted"
          value={config.text}
          placeholder="输入文本内容…"
          onChange={(e) => updateNodeConfig(id, { text: e.target.value })}
        />
        <p className="mt-1.5 text-[10px] leading-snug text-ink-muted">
          运行时作为{' '}
          <code className="rounded bg-elevated px-1 font-mono text-ink">{`{{${data.label}}}`}</code>{' '}
          供下游引用
        </p>
      </div>
    </NodeShell>
  );
}

export const InputNode = memo(InputNodeInner);
