/**
 * 右上浮动控件：缩放胶囊 [− | % | + | ▼]。
 * 点击 ▼：缩放按钮组淡出，胶囊向下弹性增高（过冲缓动）展开自绘画布略缩图；
 * 略缩图左下角浮出 ▲（透明底），点击反向收起缩回缩放条。百分比实时订阅 RF store。
 * 略缩图支持交互：按住拖动 = 取景框跟随指针平移主画布视口；滚轮 = 步进缩放主画布。
 * （原位于左下角向上展开，现与功能操作栏对调位置：略缩图改为向下展开，
 *  收起钮由右上角对调至左下角，箭头方向随之对调）
 */
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { useCanvasStore } from '../../store/canvasStore';
import { useUiStore } from '../../store/uiStore';
import { IconChevronDown, IconMinus, IconPlus } from '../icons';

const ELASTIC = { transitionDuration: '340ms', transitionTimingFunction: 'cubic-bezier(0.34, 1.56, 0.64, 1)' };

/** 略缩图内容宽度（与胶囊展开后的 inset 区域一致） */
const MM_W = 272;
/** 略缩图渲染区纵横比基准（viewBox 动态覆盖全部节点 ∪ 当前视口，保持该比例无留白） */
const WORLD = { w: 4240, h: 2640 };
/** 略缩图内容高度（世界窗口纵横比决定，固定值） */
const MM_H = Math.round((MM_W * WORLD.h) / WORLD.w);

/**
 * 自绘画布略缩图：固定世界窗口作为 viewBox，SVG meet-fit 等比缩放。
 * 节点矩形取实测尺寸（未测量时退回默认卡片尺寸），另绘制当前视口取景框。
 */
function CanvasMinimap({ dark }: { dark: boolean }) {
  const nodes = useCanvasStore((s) => s.nodes);
  const nodeLookup = useStore((s) => s.nodeLookup);
  const [tx, ty, zoom] = useStore((s) => s.transform);
  const vpW = useStore((s) => s.width);
  const vpH = useStore((s) => s.height);
  const { setViewport, zoomIn, zoomOut } = useReactFlow();
  const svgRef = useRef<SVGSVGElement>(null);
  const [grabbing, setGrabbing] = useState(false);
  /** 拖动锚点：按下时指针 flow 坐标 + 当时视口 transform（move 时按位移回放，避免漂移累积） */
  const dragRef = useRef<{ px: number; py: number; tx0: number; ty0: number } | null>(null);

  if (nodes.length === 0) {
    return (
      <svg viewBox={`0 0 ${MM_W} ${Math.round(MM_W * (WORLD.h / WORLD.w))}`} className="h-full w-full" preserveAspectRatio="xMidYMid meet">
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={11}
          className="fill-current text-ink-faint"
        >
          画布暂无节点
        </text>
      </svg>
    );
  }

  // 节点矩形（运行中高亮），包围盒取实测尺寸（未测量时退回默认卡片尺寸）
  const rects = nodes.map((n) => {
    const m = nodeLookup.get(n.id)?.measured;
    const status = (n.data as { status?: string } | undefined)?.status;
    return {
      x: n.position.x,
      y: n.position.y,
      w: m?.width ?? 280,
      h: m?.height ?? 150,
      running: status === 'running',
    };
  });

  // 当前视口在流坐标中的矩形，作为取景框
  const viewX = -tx / zoom;
  const viewY = -ty / zoom;
  const viewW = vpW / zoom;
  const viewH = vpH / zoom;

  // 节点包围盒（取实测尺寸）
  const bbMinX = Math.min(...rects.map((r) => r.x));
  const bbMaxX = Math.max(...rects.map((r) => r.x + r.w));
  const bbMinY = Math.min(...rects.map((r) => r.y));
  const bbMaxY = Math.max(...rects.map((r) => r.y + r.h));

  // viewBox 动态覆盖「全部节点 ∪ 当前视口」并保持 WORLD 纵横比（meet-fit 无留白），
  // 外扩 15% 呼吸边距——略缩图始终完整呈现整个画布的节点与当前视窗取景框
  const minX = Math.min(bbMinX, viewX);
  const minY = Math.min(bbMinY, viewY);
  const maxX = Math.max(bbMaxX, viewX + viewW);
  const maxY = Math.max(bbMaxY, viewY + viewH);
  const RATIO = WORLD.w / WORLD.h;
  let winW = (maxX - minX) * 1.15;
  let winH = (maxY - minY) * 1.15;
  if (winW / winH < RATIO) winW = winH * RATIO;
  else winH = winW / RATIO;
  const vx = (minX + maxX) / 2 - winW / 2;
  const vy = (minY + maxY) / 2 - winH / 2;
  /** 当前窗口下 1 略缩图像素对应的 flow 单位（用于描边宽随窗口自适应） */
  const unitPerPx = winW / MM_W;

  /** 指针屏幕坐标 → flow 世界坐标（SVG meet-fit：渲染区等比缩放 + 居中留白补偿） */
  const toFlow = (clientX: number, clientY: number): { x: number; y: number } => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const scale = Math.min(rect.width / winW, rect.height / winH);
    const ox = (rect.width - winW * scale) / 2;
    const oy = (rect.height - winH * scale) / 2;
    return { x: vx + (clientX - rect.left - ox) / scale, y: vy + (clientY - rect.top - oy) / scale };
  };

  /** 按住拖动：视口 transform = 按下时起点 − flow 位移 × zoom（取景框跟随指针走） */
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const p = toFlow(e.clientX, e.clientY);
    dragRef.current = { px: p.x, py: p.y, tx0: tx, ty0: ty };
    e.currentTarget.setPointerCapture(e.pointerId);
    setGrabbing(true);
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const p = toFlow(e.clientX, e.clientY);
    setViewport({ x: d.tx0 - (p.x - d.px) * zoom, y: d.ty0 - (p.y - d.py) * zoom, zoom });
  };
  const endDrag = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setGrabbing(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };
  /** 滚轮：步进缩放主画布（容器无滚动条，无需 preventDefault） */
  const onWheel = (e: ReactWheelEvent<SVGSVGElement>) => {
    void (e.deltaY < 0 ? zoomIn({ duration: 140 }) : zoomOut({ duration: 140 }));
  };

  return (
    <svg
      ref={svgRef}
      viewBox={`${vx} ${vy} ${winW} ${winH}`}
      className={`h-full w-full touch-none select-none ${grabbing ? 'cursor-grabbing' : 'cursor-grab'}`}
      preserveAspectRatio="xMidYMid meet"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onWheel={onWheel}
    >
      {rects.map((r) => (
        <rect
          key={`${r.x}-${r.y}-${r.w}-${r.h}`}
          x={r.x}
          y={r.y}
          width={r.w}
          height={r.h}
          rx={10}
          fill={r.running ? (dark ? '#5b8cff' : '#3b6fe0') : dark ? '#4b5563' : '#c3c8d0'}
        />
      ))}
      <rect
        x={viewX}
        y={viewY}
        width={viewW}
        height={viewH}
        rx={6}
        fill="none"
        stroke={dark ? 'rgba(140,160,255,0.8)' : 'rgba(59,111,224,0.7)'}
        strokeWidth={Math.max(unitPerPx * 1.5, 0.5)}
      />
    </svg>
  );
}

export function TopRightBar() {
  const zoom = useStore((s) => s.transform[2]);
  const dark = useUiStore((s) => s.theme) === 'dark';
  const { fitView, zoomTo, zoomIn, zoomOut } = useReactFlow();
  const [expanded, setExpanded] = useState(false);

  /** 点击百分比：有节点 → fitView 适配全部；空画布 → 回到 100% */
  const onZoomReset = useCallback(() => {
    if (useCanvasStore.getState().nodes.length > 0) {
      void fitView({ padding: 0.25, duration: 300 });
    } else {
      void zoomTo(1, { duration: 300 });
    }
  }, [fitView, zoomTo]);

  const iconBtn =
    'flex h-9 w-9 shrink-0 items-center justify-center rounded-8 text-ink-muted transition-colors hover:bg-wash hover:text-ink';

  return (
    <div className="absolute right-4 top-4 z-10">
      {/* 胶囊本体：高度/宽度弹性过渡（过冲回弹），顶端固定、向下展开增高 */}
      <div
        className={`relative overflow-hidden rounded-xl border border-line bg-panel shadow-lg shadow-black/40 backdrop-blur transition-[height,width] ${
          expanded ? 'w-[280px]' : 'h-11 w-[184px]'
        }`}
        style={{ ...ELASTIC, height: expanded ? MM_H + 8 : 44 }}
      >
        {/* 收起按钮：直接放在略缩图左下角（胶囊内部），点击反向收起 */}
        <button
          type="button"
          onClick={() => setExpanded(false)}
          title="收起略缩图"
          className={`absolute bottom-2 left-2 z-10 flex h-8 w-8 items-center justify-center rounded-lg border-none bg-transparent text-ink-muted transition-all duration-200 hover:bg-wash hover:text-ink ${
            expanded ? 'scale-100 opacity-100' : 'pointer-events-none scale-75 opacity-0'
          }`}
        >
          <IconChevronDown className="h-4 w-4 rotate-180" />
        </button>
        {/* 缩放条：展开时上移淡出 */}
        <div
          className={`absolute left-1 top-1 flex items-center gap-0.5 transition-all duration-200 ${
            expanded ? 'pointer-events-none -translate-y-2 opacity-0' : 'translate-y-0 opacity-100'
          }`}
        >
          <button type="button" className={iconBtn} onClick={() => void zoomOut({ duration: 200 })} title="缩小">
            <IconMinus className="h-4 w-4" />
          </button>
          <span className="h-4 w-px shrink-0 bg-line" />
          <button
            type="button"
            onClick={onZoomReset}
            title="重置视图（适配画布）"
            className="flex h-9 min-w-[3.25rem] shrink-0 items-center justify-center rounded-8 px-2 font-mono text-xs text-ink-muted transition-colors hover:bg-wash hover:text-ink"
          >
            {Math.round(zoom * 100)}%
          </button>
          <span className="h-4 w-px shrink-0 bg-line" />
          <button type="button" className={iconBtn} onClick={() => void zoomIn({ duration: 200 })} title="放大">
            <IconPlus className="h-4 w-4" />
          </button>
          {/* 与放大按钮无缝衔接（不加分隔线） */}
          <button
            type="button"
            className={iconBtn}
            onClick={() => setExpanded(true)}
            title="展开画布略缩图"
          >
            <IconChevronDown className="h-4 w-4" />
          </button>
        </div>

        {/* 略缩图：收起时上移淡出。自绘 SVG 按节点包围盒等比 fit，完整呈现所有节点 */}
        <div
          className={`absolute inset-1 transition-all duration-200 ${
            expanded ? 'translate-y-0 opacity-100 delay-100' : 'pointer-events-none -translate-y-2 opacity-0'
          }`}
        >
          <CanvasMinimap dark={dark} />
        </div>
      </div>
    </div>
  );
}
