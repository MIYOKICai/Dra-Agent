/**
 * 全屏灯箱：点击图片后全屏预览。
 * 通过 Portal 挂到 body——React Flow 视口带 transform，fixed 定位在节点内部
 * 会退化为相对画布定位导致盖不满全屏，必须传送到文档根节点。
 * 点击任意处 / 右上角关闭按钮 / Esc 均可关闭。
 */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';

interface LightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

export function Lightbox({ src, alt, onClose }: LightboxProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/95"
      onClick={onClose}
    >
      <img
        src={src}
        alt={alt ?? ''}
        className="h-full w-full object-contain"
        onClick={(e) => e.stopPropagation()}
      />
      <button
        type="button"
        aria-label="关闭预览"
        onClick={onClose}
        className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full border border-zinc-600 bg-zinc-900/80 text-lg leading-none text-zinc-200 transition-colors hover:border-zinc-300 hover:text-white"
      >
        ×
      </button>
    </div>,
    document.body
  );
}
