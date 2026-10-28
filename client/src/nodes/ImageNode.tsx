/**
 * 图像生成节点：正文显示 prompt 摘要 + 尺寸 / 数量摘要。
 * 生成的图片（output.images）由 NodeShell 输出区以 ImageGrid 缩略图渲染，
 * 点击弹出 Lightbox 放大。
 */
import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { NodeShell } from './NodeShell';
import { readImageConfig } from './nodeConfigs';
import { Chip } from '../components/Chip';
import type { CanvasNode } from '../store/canvasStore';

function ImageNodeInner({ id, data, selected }: NodeProps<CanvasNode>) {
  const config = readImageConfig(data.config);

  return (
    <NodeShell id={id} data={data} selected={selected}>
      <div className="p-2">
        <p className="line-clamp-3 break-all text-[11px] leading-snug text-ink-muted">
          {config.prompt || '未填写图像提示词'}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <Chip>{config.size}</Chip>
          <Chip>×{config.count}</Chip>
        </div>
      </div>
    </NodeShell>
  );
}

export const ImageNode = memo(ImageNodeInner);
