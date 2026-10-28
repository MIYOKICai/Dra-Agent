/** 输入节点配置：文本创作区（与节点正文 textarea 双向同步） */
import { ComposerArea } from '../../components/fields';
import { useCanvasStore } from '../../store/canvasStore';
import { readInputConfig } from '../../nodes/nodeConfigs';
import type { NodeConfigFormProps } from './types';

export function InputConfig({ id, data, expanded }: NodeConfigFormProps) {
  const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
  const config = readInputConfig(data.config);

  return (
    <ComposerArea
      label="输入文本"
      description="运行时该文本作为 {{节点名}} 变量供下游节点引用"
      value={config.text}
      onChange={(text) => updateNodeConfig(id, { text })}
      placeholder="输入文本内容…"
      expanded={expanded}
    />
  );
}
