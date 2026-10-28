/**
 * 输出节点：工作流终点，分节展示文本（Markdown 渲染）+ 图片画廊 + 检索片段。
 * output 默认渲染由 NodeShell 提供，此处关闭并用富文本布局自行展示。
 */
import { memo, useState, type ReactNode } from 'react';
import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import { MarkdownView } from '../components/MarkdownView';
import { Lightbox } from '../components/Lightbox';
import type { CanvasNode } from '../store/canvasStore';

/** 分节标题：小号间隔字标题 + 右侧细线延伸 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-ink-faint">
          {title}
        </span>
        <span className="h-px flex-1 bg-line" />
      </div>
      {children}
    </section>
  );
}

function OutputNodeInner({ id, data, selected }: NodeProps<CanvasNode>) {
  const output = data.output;
  const images = output?.images ?? [];
  const hasText = typeof output?.text === 'string' && output.text.length > 0;
  const fragments = output?.fragments ?? [];
  const hasAny = hasText || images.length > 0 || fragments.length > 0;
  const running = data.status === 'running';
  /** 灯箱当前预览的图片下标（null=关闭），与图像生成节点同款点击放大 */
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);

  return (
    <NodeShell id={id} data={data} selected={selected} hideDefaultOutput>
      <div className="nowheel no-scrollbar max-h-80 space-y-3.5 overflow-y-auto px-3 pb-3 pt-1">
        {/* 运行中且尚无任何产物：按最终布局铺骨架屏（图片画廊格 + 文本条，与展示顺序一致） */}
        {!hasAny && running && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1.5">
              <div className="skeleton-bar aspect-square rounded-lg" />
              <div className="skeleton-bar aspect-square rounded-lg" />
            </div>
            <div className="space-y-1.5">
              <div className="skeleton-bar h-2 w-1/4" />
              <div className="skeleton-bar h-2 w-full" />
              <div className="skeleton-bar h-2 w-3/4" />
            </div>
          </div>
        )}
        {!hasAny && !running && (
          <div className="flex flex-col items-center gap-2 py-6">
            <span className="h-2.5 w-2.5 rounded-full border border-line" />
            <p className="text-[11px] italic text-ink-faint">运行后在此查看结果</p>
          </div>
        )}

        {/* 图片在前：与图像生成节点一致的同比例框（contain 完整显示 + 点击放大灯箱） */}
        {images.length > 0 && (
          <Section title={`图片（${images.length}）`}>
            <div className={`grid gap-1.5 ${images.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
              {images.map((src, i) => (
                <button
                  key={i}
                  type="button"
                  className="group relative aspect-square w-full cursor-zoom-in overflow-hidden rounded-lg border border-line"
                  onClick={() => setPreviewIdx(i)}
                  title="点击放大"
                >
                  <img
                    src={src}
                    alt={`聚合图片 ${i + 1}`}
                    className="h-full w-full object-contain transition-transform duration-300 group-hover:scale-[1.03]"
                    loading="lazy"
                    draggable={false}
                  />
                </button>
              ))}
            </div>
          </Section>
        )}

        {hasText && (
          <Section title="文本">
            <MarkdownView text={output?.text ?? ''} />
          </Section>
        )}

        {fragments.length > 0 && (
          <Section title={`检索片段（${fragments.length}）`}>
            <ul className="space-y-1.5">
              {fragments.map((f, i) => (
                <li key={i} className="border-l-2 border-line py-0.5 pl-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[10px] text-ink">{f.source}</span>
                    <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                      {f.score.toFixed(2)}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 break-all text-[10px] leading-snug text-ink-muted">
                    {f.text}
                  </p>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
      {/* 图片放大灯箱（portal 到 body，全屏覆盖） */}
      {previewIdx !== null && images[previewIdx] && (
        <Lightbox src={images[previewIdx]} alt={`聚合图片 ${previewIdx + 1}`} onClose={() => setPreviewIdx(null)} />
      )}
    </NodeShell>
  );
}

export const OutputNode = memo(OutputNodeInner);
