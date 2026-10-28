/**
 * 模板展开全屏过渡层（挂在 <Routes> 之上，跨路由不卸载）：
 * 点击模板卡片后 expandStore 挂起「模板 + 卡片矩形」，本层接管全部时序——
 * 1) 从卡片矩形放大到全屏（460ms，快速淡入掩住首帧未适配画面）；
 * 2) 放大完成后导航到 /canvas——路由切换发生在全屏投影背后（投影与画布页
 *    首帧构图一致），切换不可见；
 * 3) 留出画布挂载 + fitView 余量后淡出，露出真实画布，观感无缝。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TemplatePreview } from './TemplatePreview';
import { useExpandStore } from '../../store/expandStore';

/** 卡片矩形放大到全屏的时长（ms） */
const EXPAND_MS = 460;
/** 展开完成后导航到画布的延迟（ms） */
const NAVIGATE_MS = 500;
/** 导航后留给画布挂载 + fitView 的余量，随后开始淡出（ms） */
const FADE_DELAY_MS = 1000;
/** 淡出时长（ms） */
const FADE_MS = 340;

export function TemplateExpandOverlay() {
  const template = useExpandStore((s) => s.template);
  const rect = useExpandStore((s) => s.rect);
  const clear = useExpandStore((s) => s.clear);
  const navigate = useNavigate();
  /** grown：矩形放大到全屏；shown：整体淡入（掩住 RF 首帧未适配画面） */
  const [grown, setGrown] = useState(false);
  const [shown, setShown] = useState(false);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (!template) {
      setGrown(false);
      setShown(false);
      setFading(false);
      return;
    }
    const raf = requestAnimationFrame(() => {
      setGrown(true);
      setShown(true);
    });
    const navTimer = window.setTimeout(() => navigate('/canvas'), NAVIGATE_MS);
    const fadeTimer = window.setTimeout(() => setFading(true), FADE_DELAY_MS);
    const doneTimer = window.setTimeout(() => clear(), FADE_DELAY_MS + FADE_MS);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(navTimer);
      window.clearTimeout(fadeTimer);
      window.clearTimeout(doneTimer);
    };
  }, [template, clear, navigate]);

  if (!template || !rect) return null;

  const geometry = {
    left: grown ? 0 : rect.left,
    top: grown ? 0 : rect.top,
    width: grown ? window.innerWidth : rect.width,
    height: grown ? window.innerHeight : rect.height,
    borderRadius: grown ? 0 : 16,
  };
  return (
    <div className="pointer-events-none fixed inset-0 z-[95]" aria-hidden="true">
      <div
        className="absolute overflow-hidden bg-base"
        style={{
          ...geometry,
          opacity: fading ? 0 : shown ? 1 : 0,
          transition: fading
            ? `opacity ${FADE_MS}ms ease-out`
            : [
                `left ${EXPAND_MS}ms cubic-bezier(.22,.61,.36,1)`,
                `top ${EXPAND_MS}ms cubic-bezier(.22,.61,.36,1)`,
                `width ${EXPAND_MS}ms cubic-bezier(.22,.61,.36,1)`,
                `height ${EXPAND_MS}ms cubic-bezier(.22,.61,.36,1)`,
                `border-radius ${EXPAND_MS}ms cubic-bezier(.22,.61,.36,1)`,
                'opacity 120ms ease-out',
              ].join(', '),
        }}
      >
        <TemplatePreview template={template} />
      </div>
    </div>
  );
}
