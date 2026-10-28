/** 提示词模板节点配置：模板内容创作区（支持 {{上游节点名}} 变量插入） */
import { ComposerArea } from '../../components/fields';
import { useCanvasStore } from '../../store/canvasStore';
import { readTemplateConfig } from '../../nodes/nodeConfigs';
import type { NodeConfigFormProps } from './types';

export function TemplateConfig({ id, data, expanded, variables }: NodeConfigFormProps) {
  const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
  const config = readTemplateConfig(data.config);

  return (
    <ComposerArea
      label="模板内容"
      description="支持 {{上游节点名}} 占位符，运行时替换为对应节点的输出"
      value={config.template}
      onChange={(template) => updateNodeConfig(id, { template })}
      placeholder={'例如：\n请总结以下内容：\n{{大模型调用 1}}'}
      expanded={expanded}
      variables={variables}
    />
  );
}
