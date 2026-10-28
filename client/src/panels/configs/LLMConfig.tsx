/** 大模型调用节点配置：用户提示词创作区 + 系统提示词分区；服务商/模型收进参数条，温度收进底部操作行 chip */
import { ModelSelect } from '../../components/ModelSelect';
import { ComposerArea, FieldRule, SelectField, TextArea } from '../../components/fields';
import { useCanvasStore } from '../../store/canvasStore';
import { readLLMConfig } from '../../nodes/nodeConfigs';
import type { NodeConfigFormProps } from './types';

export function LLMConfig({ id, data, expanded, variables }: NodeConfigFormProps) {
  const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
  const config = readLLMConfig(data.config);

  return (
    <>
      <ComposerArea
        label="用户提示词"
        description="将发送给模型的用户消息，支持 {{上游节点名}} 变量"
        value={config.userPrompt}
        onChange={(userPrompt) => updateNodeConfig(id, { userPrompt })}
        placeholder="输入提示词…"
        expanded={expanded}
        variables={variables}
      />
      <FieldRule className="my-4" />
      <TextArea
        label="系统提示词"
        description="设定助手的角色与行为约束"
        value={config.systemPrompt}
        onChange={(systemPrompt) => updateNodeConfig(id, { systemPrompt })}
        rows={4}
      />
    </>
  );
}

/** 参数条：服务商 / 模型紧凑下拉 chip */
export function LLMFooter({ id, data }: NodeConfigFormProps) {
  const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
  const config = readLLMConfig(data.config);

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

/** 底部操作行 chip：温度（0 ~ 2，步长 0.1；历史数据不在档位时补一项保证回显） */
export function LLMTailChips({ id, data }: NodeConfigFormProps) {
  const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
  const config = readLLMConfig(data.config);

  const options = Array.from({ length: 21 }, (_, i) => {
    const v = Number((i * 0.1).toFixed(1));
    return { value: String(v), label: v.toFixed(1) };
  });
  const value = String(Number(config.temperature.toFixed(1)));
  if (!options.some((opt) => opt.value === value)) {
    options.push({ value, label: String(config.temperature) });
  }

  return (
    <SelectField
      variant="chip"
      label="温度"
      description="越高输出越随机，越低越确定；0 ~ 2"
      value={value}
      options={options}
      onChange={(v) => updateNodeConfig(id, { temperature: Number(v) })}
    />
  );
}
