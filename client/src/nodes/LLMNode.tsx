/**
 * 大模型调用节点：正文显示 provider/model 徽标 + userPrompt 摘要。
 * 流式输出由 NodeShell 输出区渲染（StreamingText，运行中带光标动画），
 * 引擎（Task 5）接入后随 output.text 自动生效。
 */
import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import { readLLMConfig } from './nodeConfigs';
import { Chip } from '../components/Chip';
import type { CanvasNode } from '../store/canvasStore';

function LLMNodeInner({ id, data, selected }: NodeProps<CanvasNode>) {
  const config = readLLMConfig(data.config);

  return (
    <NodeShell id={id} data={data} selected={selected}>
      <div className="p-2">
        <div className="flex flex-wrap items-center gap-1">
          {config.model ? (
            <Chip tone="primary" title={`服务商：${config.provider || '未选择'}`}>
              {config.model}
            </Chip>
          ) : (
            <Chip>未选择模型</Chip>
          )}
          <Chip>temp {config.temperature}</Chip>
        </div>
        <p className="mt-1.5 line-clamp-3 break-all text-[11px] leading-snug text-ink-muted">
          {config.userPrompt || '未填写用户提示词'}
        </p>
      </div>
    </NodeShell>
  );
}

export const LLMNode = memo(LLMNodeInner);
