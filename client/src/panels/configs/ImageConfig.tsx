/** 图像生成节点配置：提示词创作区 + 服务商/模型分区；尺寸与数量收进底部工具条 */
import { ModelSelect } from '../../components/ModelSelect';
import { ComposerArea, FieldRule, SelectField } from '../../components/fields';
import { useCanvasStore } from '../../store/canvasStore';
import { IMAGE_SIZES, readImageConfig } from '../../nodes/nodeConfigs';
import type { NodeConfigFormProps } from './types';

export function ImageConfig({ id, data, expanded, variables }: NodeConfigFormProps) {
  const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
  const config = readImageConfig(data.config);

  return (
    <>
      <ComposerArea
        label="提示词"
        description="描述要生成的图像内容，支持 {{上游节点名}} 变量"
        value={config.prompt}
        onChange={(prompt) => updateNodeConfig(id, { prompt })}
        placeholder="例如：水彩风格的猫咪插画…"
        expanded={expanded}
        variables={variables}
      />
      <FieldRule className="my-4" />
      <ModelSelect
        kind="image"
        provider={config.provider}
        model={config.model}
        onChange={(patch) => updateNodeConfig(id, patch)}
      />
    </>
  );
}

/** 底部工具条：尺寸 / 生成数量紧凑下拉 chip */
export function ImageFooter({ id, data }: NodeConfigFormProps) {
  const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
  const config = readImageConfig(data.config);

  return (
    <>
      <SelectField
        variant="chip"
        label="尺寸"
        value={config.size}
        options={IMAGE_SIZES.map((size) => ({ value: size, label: size }))}
        onChange={(size) => updateNodeConfig(id, { size })}
      />
      <SelectField
        variant="chip"
        label="数量"
        value={String(config.count)}
        options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: `${n} 张` }))}
        onChange={(v) => updateNodeConfig(id, { count: Number(v) })}
      />
    </>
  );
}
