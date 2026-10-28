/**
 * 提示词模板节点：正文等宽预览模板内容（超长截断），
 * 大段编辑在右侧配置面板；可用 {{上游节点名}} 插值（引擎 Task 5 渲染）。
 */
import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import { readTemplateConfig } from './nodeConfigs';
import type { CanvasNode } from '../store/canvasStore';

function TemplateNodeInner({ id, data, selected }: NodeProps<CanvasNode>) {
  const config = readTemplateConfig(data.config);

  return (
    <NodeShell id={id} data={data} selected={selected}>
      <div className="p-2">
        {config.template ? (
          <pre className="max-h-16 overflow-hidden whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-ink-muted">
            {config.template}
          </pre>
        ) : (
          <p className="text-[11px] italic leading-relaxed text-ink-muted">未配置模板</p>
        )}
        <p className="mt-1.5 text-[10px] leading-snug text-ink-muted">
          支持{' '}
          <code className="rounded bg-elevated px-1 font-mono text-ink">{`{{上游节点名}}`}</code>{' '}
          插值
        </p>
      </div>
    </NodeShell>
  );
}

export const TemplateNode = memo(TemplateNodeInner);
