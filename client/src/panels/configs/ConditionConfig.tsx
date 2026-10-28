/** 条件分支节点配置：关键词分区；大小写开关收进底部工具条 */
import { IconCheck } from '../../components/icons';
import { TextField } from '../../components/fields';
import { useCanvasStore } from '../../store/canvasStore';
import { readConditionConfig } from '../../nodes/nodeConfigs';
import type { NodeConfigFormProps } from './types';

export function ConditionConfig({ id, data }: NodeConfigFormProps) {
  const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
  const config = readConditionConfig(data.config);

  return (
    <TextField
      label="关键词"
      description="对上游节点的文本做包含判断：包含关键词走真出口，否则走假出口"
      value={config.keyword}
      onChange={(keyword) => updateNodeConfig(id, { keyword })}
      placeholder="输入关键词…"
    />
  );
}

/** 底部工具条：区分大小写开关 chip */
export function ConditionFooter({ id, data }: NodeConfigFormProps) {
  const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
  const config = readConditionConfig(data.config);

  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-wash ${
        config.caseSensitive ? 'text-ink' : 'text-ink-muted'
      }`}
      title="关键词匹配时是否区分大小写"
      aria-pressed={config.caseSensitive}
      onClick={() => updateNodeConfig(id, { caseSensitive: !config.caseSensitive })}
    >
      {config.caseSensitive && <IconCheck className="h-3 w-3" />}
      区分大小写
    </button>
  );
}
