/**
 * 图片缩略图网格：点击放大（Lightbox）。
 * 节点输出区（紧凑 3 列小图）与输出节点画廊（2 列中图）共用。
 */
import { useState } from 'react';
import { Lightbox } from './Lightbox';

interface ImageGridProps {
  images: string[];
  /** sm: 节点内小缩略图（3 列）；md: 输出节点画廊（2 列） */
  size?: 'sm' | 'md';
}

export function ImageGrid({ images, size = 'sm' }: ImageGridProps) {
  const [active, setActive] = useState<string | null>(null);

  return (
    <>
      <div className={`grid gap-1 ${size === 'sm' ? 'grid-cols-3' : 'grid-cols-2'}`}>
        {images.map((src, i) => (
          <img
            key={i}
            src={src}
            alt={`图片 ${i + 1}`}
            loading="lazy"
            onClick={() => setActive(src)}
            className={`w-full cursor-zoom-in rounded border border-line object-cover transition-opacity hover:opacity-80 ${
              size === 'sm' ? 'h-10' : 'h-24'
            }`}
          />
        ))}
      </div>
      {active && <Lightbox src={active} alt="图片预览" onClose={() => setActive(null)} />}
    </>
  );
}
