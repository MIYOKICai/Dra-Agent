/**
 * 知识检索节点：正文显示目标知识库名称与 top-k；
 * 运行后展示命中片段摘要（来源 + 得分 + 内容截断）。
 */
import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import { readRetrievalConfig } from './nodeConfigs';
import { Chip } from '../components/Chip';
import { useKBStore } from '../store/kbStore';
import type { CanvasNode } from '../store/canvasStore';

/** 按字符数截断（不截断代理对） */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

function RetrievalNodeInner({ id, data, selected }: NodeProps<CanvasNode>) {
  const config = readRetrievalConfig(data.config);
  const kbName = useKBStore((s) => s.kbs.find((kb) => kb.id === config.kbId)?.name);
  const fragments = data.output?.fragments ?? [];

  return (
    <NodeShell id={id} data={data} selected={selected}>
      <div className="p-2">
        <p className="text-[11px] leading-snug text-ink-muted">
          知识库：
          <span
            className={kbName ? 'text-ink' : 'text-ink-muted'}
            title={kbName ?? undefined}
          >
            {kbName ?? (config.kbId ? '（库已删除）' : '未选择')}
          </span>
          {' / '}
          top-k {config.topK}
        </p>
        {config.query && (
          <div className="mt-1.5">
            <Chip>查询：{clip(config.query, 20)}</Chip>
          </div>
        )}
        {fragments.length > 0 && (
          <div className="mt-1.5 space-y-1">
            {fragments.map((f, i) => (
              <div key={i} className="rounded border border-line bg-elevated px-1.5 py-1">
                <div className="flex items-center justify-between gap-1">
                  <Chip title={f.source}>来源：{clip(f.source, 12)}</Chip>
                  <span className="shrink-0 text-[10px] text-ink-muted">
                    得分 {f.score.toFixed(2)}
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-snug text-ink-muted">{clip(f.text, 60)}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </NodeShell>
  );
}

export const RetrievalNode = memo(RetrievalNodeInner);
