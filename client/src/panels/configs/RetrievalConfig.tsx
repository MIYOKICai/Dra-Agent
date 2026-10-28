/** 知识检索节点配置：查询语句创作区；知识库与 top-k 收进底部工具条（数据源来自 kbStore） */
import { ComposerArea, SelectField, type SelectOption } from '../../components/fields';
import { useCanvasStore } from '../../store/canvasStore';
import { useKBStore } from '../../store/kbStore';
import { readRetrievalConfig } from '../../nodes/nodeConfigs';
import type { NodeConfigFormProps } from './types';

export function RetrievalConfig({ id, data, expanded, variables }: NodeConfigFormProps) {
  const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
  const setPanelOpen = useKBStore((s) => s.setPanelOpen);
  const kbs = useKBStore((s) => s.kbs);

  return (
    <>
      {kbs.length === 0 && (
        <button
          type="button"
          className="mb-3 w-full rounded-base border border-dashed border-line px-2 py-1.5 text-xs text-ink-muted transition-colors hover:border-ink-muted hover:text-ink"
          onClick={() => setPanelOpen(true)}
        >
          📚 打开知识库面板
        </button>
      )}
      <ComposerArea
        label="查询语句"
        description="要检索的问题或关键词，支持 {{上游节点名}} 变量插值；留空时默认使用上游输出"
        value={readRetrievalConfig(data.config).query}
        onChange={(query) => updateNodeConfig(id, { query })}
        placeholder="例如：{{输入节点 1}}"
        expanded={expanded}
        variables={variables}
      />
    </>
  );
}

/** 底部工具条：知识库 / 返回条数（top-k）紧凑下拉 chip */
export function RetrievalFooter({ id, data }: NodeConfigFormProps) {
  const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
  const kbs = useKBStore((s) => s.kbs);
  const config = readRetrievalConfig(data.config);

  const kbOptions: SelectOption[] =
    kbs.length > 0
      ? kbs.map((kb) => ({
          value: kb.id,
          label: `${kb.name}（${kb.chunkCount} 块 · ${kb.mode === 'vector' ? '向量' : '关键词'}）`,
        }))
      : [{ value: '', label: '请先创建知识库', disabled: true }];

  return (
    <>
      <SelectField
        variant="chip"
        label="知识库"
        value={config.kbId}
        options={kbOptions}
        onChange={(kbId) => updateNodeConfig(id, { kbId })}
      />
      <SelectField
        variant="chip"
        label="条数"
        value={String(config.topK)}
        options={Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: `top ${i + 1}` }))}
        onChange={(v) => updateNodeConfig(id, { topK: Number(v) })}
      />
    </>
  );
}
