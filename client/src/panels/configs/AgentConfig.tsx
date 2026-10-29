/** 智能体节点配置：用户提示词创作区 + 系统提示词/工具分区；服务商/模型收进参数条，迭代轮数收进底部操作行 chip */
import { ModelSelect } from '../../components/ModelSelect';
import { ComposerArea, FieldRule, SelectField, TextArea, MultiCheckboxField } from '../../components/fields';
import { useCanvasStore } from '../../store/canvasStore';
import { AGENT_TOOLS, readAgentConfig } from '../../nodes/nodeConfigs';
import type { NodeConfigFormProps } from './types';

export function AgentConfig({ id, data, expanded, variables }: NodeConfigFormProps) {
  const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
  const config = readAgentConfig(data.config);

  return (
    <>
      <ComposerArea
        label="用户提示词"
        description="下达给智能体的任务，支持 {{上游节点名}} 变量"
        value={config.userPrompt}
        onChange={(userPrompt) => updateNodeConfig(id, { userPrompt })}
        placeholder="描述任务目标…"
        expanded={expanded}
        variables={variables}
      />
      <FieldRule className="my-4" />
      <TextArea
        label="系统提示词"
        description="设定智能体的角色与目标"
        value={config.systemPrompt}
        onChange={(systemPrompt) => updateNodeConfig(id, { systemPrompt })}
        rows={4}
      />
      <MultiCheckboxField
        label="可用工具"
        description="智能体可调用的工具集合；标注「需用户确认」的写/高危工具仅在对话智能体中生效，工作流节点调用会被拒绝"
        value={config.tools}
        options={AGENT_TOOLS.map((tool) => ({
          value: tool.value,
          label: tool.label,
          description: tool.description,
        }))}
        onChange={(tools) => updateNodeConfig(id, { tools })}
      />
    </>
  );
}

/** 参数条：服务商 / 模型紧凑下拉 chip */
export function AgentFooter({ id, data }: NodeConfigFormProps) {
  const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
  const config = readAgentConfig(data.config);

  return (
    <ModelSelect
      variant="chip"
      kind="chat"
      provider={config.provider}
      model={config.model}
      onChange={(patch) => updateNodeConfig(id, patch)}
    />
  );
}

/** 底部操作行 chip：最大迭代轮数（1 ~ 10） */
export function AgentTailChips({ id, data }: NodeConfigFormProps) {
  const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
  const config = readAgentConfig(data.config);

  return (
    <SelectField
      variant="chip"
      label="迭代"
      description="单次运行中『思考 → 调用工具 → 观察结果』的最大循环次数，1 ~ 10"
      value={String(config.maxIterations)}
      options={Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 轮` }))}
      onChange={(v) => updateNodeConfig(id, { maxIterations: Number(v) })}
    />
  );
}
