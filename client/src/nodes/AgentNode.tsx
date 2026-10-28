/**
 * 智能体节点：正文显示 model 徽标 + 已选工具 chips；
 * 运行中从 output.steps 推导"第 n 轮 / 已调用 x 次工具"轻量进度；
 * steps 时间线由 NodeShell 输出区渲染（output.steps）。
 */
import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import { AGENT_TOOLS, readAgentConfig } from './nodeConfigs';
import { Chip } from '../components/Chip';
import type { CanvasNode } from '../store/canvasStore';

function toolLabel(value: string): string {
  return AGENT_TOOLS.find((t) => t.value === value)?.label ?? value;
}

function AgentNodeInner({ id, data, selected }: NodeProps<CanvasNode>) {
  const config = readAgentConfig(data.config);
  const steps = data.output?.steps ?? [];
  const rounds = steps.filter((s) => s.kind === 'thought').length;
  const toolUses = steps.filter((s) => s.kind === 'tool_call').length;
  const showProgress = data.status === 'running' && (rounds > 0 || toolUses > 0);

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
          <Chip>≤{config.maxIterations} 轮</Chip>
          {showProgress && (
            <Chip tone="primary" title="Agent 循环运行进度">
              第 {rounds} 轮 · 已调用 {toolUses} 次工具
            </Chip>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {config.tools.length > 0 ? (
            config.tools.map((tool) => (
              <Chip key={tool} title={toolLabel(tool)}>
                {tool}
              </Chip>
            ))
          ) : (
            <Chip>未选择工具</Chip>
          )}
        </div>
      </div>
    </NodeShell>
  );
}

export const AgentNode = memo(AgentNodeInner);
