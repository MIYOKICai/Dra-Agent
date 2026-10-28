/**
 * 画布页：全屏沉浸式浮层风格。
 * 近黑画布铺满视口（无点阵网格），四角浮动控件：
 * 左上徽标+工作流名 / 右上缩放+略缩图 / 左侧节点坞 / 左下模板中心+功能 / 右下运行。
 * 点击节点（onNodeClick 真点击，拖拽不触发）进入聚焦编辑模式：聚焦节点平滑移到
 * 画布左侧并放大 1.12 倍，其余节点与全部连线淡出（focus-mode 纯 CSS），右侧滑出
 * 设置面板，面板与节点间画流动虚线标识归属。节点仍支持从节点坞拖放添加。
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type RefObject } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useInternalNode,
  useReactFlow,
  useStore,
  type Edge,
  type NodeChange,
  type XYPosition,
} from '@xyflow/react';
// React Flow 基础样式表：缺失时 .react-flow__pane 无尺寸规则，画布无法拖拽平移与滚轮缩放
import '@xyflow/react/dist/style.css';
// 连线类型与默认样式共享自 components/canvas/FlowEdge（模板投影复用同一渲染，保证构图一致）
import { defaultEdgeOptions, edgeTypes } from '../components/canvas/FlowEdge';
import {
  DEFAULT_WORKFLOW_NAME,
  WORKFLOW_VERSION,
  useCanvasStore,
  type CanvasNode,
} from '../store/canvasStore';
import type { WorkflowJSON } from '@shared/types';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useRunStore } from '../store/runStore';
import { useKBStore } from '../store/kbStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { nodeTypes } from '../nodes';
import { isNodeType } from '../nodes/registry';
import { TopLeftBar } from '../components/canvas/TopLeftBar';
import { TopRightBar } from '../components/canvas/TopRightBar';
import { LeftDock, DRAG_MIME } from '../components/canvas/LeftDock';
import { BottomLeftBar } from '../components/canvas/BottomLeftBar';
import { BottomRightBar } from '../components/canvas/BottomRightBar';
import { ProjectSidebar } from '../components/canvas/ProjectSidebar';
import { CreationPanel } from '../components/canvas/CreationPanel';
import { ConfigPanel } from '../panels/ConfigPanel';
import { KBPanel } from '../panels/KBPanel';
import { NodeContextMenu, type NodeMenuState } from '../components/NodeContextMenu';
import { Toast } from '../components/Toast';
import { Button } from '../components/ui/Button';
import { IconDownload, IconGrid, IconLayers, IconNodeTree, IconPlus, IconSparkles, IconTrash } from '../components/icons';

/**
 * 全局浮层 memo 化：多选拖拽期间 CanvasInner 随 nodes 数组逐帧重渲染，
 * 这些浮层不依赖画布节点状态（数据全走各自 store 订阅），memo 化后拖拽帧
 * 不再连带整棵子树 reconcile——消除「一卡一卡」的掉帧。
 */
const MemoTopLeftBar = memo(TopLeftBar);
const MemoTopRightBar = memo(TopRightBar);
const MemoLeftDock = memo(LeftDock);
const MemoBottomLeftBar = memo(BottomLeftBar);
const MemoBottomRightBar = memo(BottomRightBar);
const MemoKBPanel = memo(KBPanel);
const MemoToast = memo(Toast);

/** 框选工具条定位常量：与框选区间距 / 四周控件安全区（顶底角落钮高 44+边距、左侧节点坞全高） */
const TB_GAP = 12;
const TB_SAFE_TOP = 68;
const TB_SAFE_BOTTOM = 68;
const TB_SAFE_LEFT = 80;
const TB_SAFE_RIGHT = 16;

type ToolbarSide = 'top' | 'bottom' | 'right' | 'left';

/**
 * 框选工具条智能定位：返回工具条左上角屏幕坐标与停靠边。
 * - 所选节点包围盒：flow 坐标 × zoom + transform → 屏幕矩形（随平移缩放/节点拖动实时跟随）
 * - 上/下横排要求「垂直放得下 且 水平能完整容纳」（框选区中点两侧各留出半条宽度）；
 *   横排放不下（框选区偏出视口一侧等）→ 贴框选区左/右缘**竖排**（竖条窄更易容纳），
 *   外侧放不下则夹进可视区（宁可轻遮框选区，保证工具条完整可见）
 */
function useToolbarPosition(
  ids: string[],
  hSize: { w: number; h: number },
  vSize: { w: number; h: number }
): { x: number; y: number; side: ToolbarSide } {
  const nodes = useStore((s) => s.nodes);
  const nodeLookup = useStore((s) => s.nodeLookup);
  const [tx, ty, zoom] = useStore((s) => s.transform);
  const vw = useStore((s) => s.width);
  const vh = useStore((s) => s.height);
  const idSet = useMemo(() => new Set(ids), [ids]);

  return useMemo(() => {
    // 所选节点的屏幕包围盒（未测量节点退回默认卡片尺寸）
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      if (!idSet.has(n.id)) continue;
      const m = nodeLookup.get(n.id)?.measured;
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + (m?.width ?? 280));
      maxY = Math.max(maxY, n.position.y + (m?.height ?? 150));
    }
    if (!Number.isFinite(minX) || vw === 0 || vh === 0) {
      return { x: TB_SAFE_LEFT, y: TB_SAFE_TOP, side: 'top' };
    }
    const rect = {
      left: minX * zoom + tx,
      top: minY * zoom + ty,
      right: maxX * zoom + tx,
      bottom: maxY * zoom + ty,
    };
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    // 横排水平容纳：框选区水平中点两侧各留出半条宽度
    const hFitsX = cx - hSize.w / 2 >= TB_SAFE_LEFT && cx + hSize.w / 2 <= vw - TB_SAFE_RIGHT;
    if (rect.top - TB_GAP - hSize.h >= TB_SAFE_TOP && hFitsX) {
      return { x: cx - hSize.w / 2, y: rect.top - TB_GAP - hSize.h, side: 'top' };
    }
    if (rect.bottom + TB_GAP + hSize.h <= vh - TB_SAFE_BOTTOM && hFitsX) {
      return { x: cx - hSize.w / 2, y: rect.bottom + TB_GAP, side: 'bottom' };
    }
    // 左右竖排：垂直居中于框选区（竖条过高时夹进可视区），左右选剩余空间大的一侧
    const yv = Math.min(
      Math.max(cy - vSize.h / 2, TB_SAFE_TOP),
      Math.max(TB_SAFE_TOP, vh - TB_SAFE_BOTTOM - vSize.h)
    );
    const xl = rect.left - TB_GAP - vSize.w;
    const xr = rect.right + TB_GAP;
    const freeL = xl - TB_SAFE_LEFT;
    const freeR = vw - TB_SAFE_RIGHT - xr - vSize.w;
    if (freeL >= freeR) {
      return { x: Math.max(xl, TB_SAFE_LEFT), y: yv, side: 'left' };
    }
    return { x: Math.min(xr, vw - TB_SAFE_RIGHT - vSize.w), y: yv, side: 'right' };
  }, [nodes, nodeLookup, idSet, tx, ty, zoom, vw, vh, hSize, vSize]);
}

/**
 * 框选工具条：所选 ≥2 节点时贴框选区四边浮现（不再固定视口顶部）。
 * 上下横排 / 左右竖排（智能选边 + 夹紧定位）；rise-in 动画挂在外层（定位用
 * style left/top，不与 transform 冲突——修复原先 -translate-x-1/2 被动画
 * transform 覆盖导致不居中）。
 */
const SelectionToolbar = memo(function SelectionToolbar({
  ids,
  count,
  onStack,
  onGrid,
  onDelete,
  onDownload,
}: {
  ids: string[];
  count: number;
  onStack: () => void;
  onGrid: () => void;
  onDelete: () => void;
  onDownload: () => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  // 横排 / 竖排两套尺寸：首次渲染用估算值，渲染后实测修正（useLayoutEffect 绘制前生效，无闪烁）
  const [hSize, setHSize] = useState({ w: 430, h: 44 });
  const [vSize, setVSize] = useState({ w: 104, h: 224 });
  const pos = useToolbarPosition(ids, hSize, vSize);
  const vertical = pos.side === 'left' || pos.side === 'right';
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (vertical) {
      setVSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    } else {
      setHSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    }
  }, [count, vertical]);

  const itemBtn =
    'flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-xs text-ink-muted transition-colors hover:bg-wash hover:text-ink';
  /** 竖排专属：分隔线不贴容器边（左右留白），标题做成淡色小节标签 */
  const divider = vertical ? 'mx-1 h-px bg-line' : 'h-4 w-px bg-line';
  return (
    // 三层分离：外层只承担 rise-in 入场（transform 动画 fill 会覆盖自身 transform，
    // 不能与位移混用）；中层用 translate3d 定位 + transform 过渡——选区增删节点 /
    // 拖动 / 缩放 / 换边时位置平滑滑动（合成器动画，不触发 reflow）
    <div className="animate-rise-in absolute left-0 top-0 z-10">
      <div
        className="w-max transition-transform duration-200 ease-out will-change-transform"
        style={{ transform: `translate3d(${pos.x}px, ${pos.y}px, 0)` }}
      >
      <div
        ref={barRef}
        className={
          vertical
            ? 'flex flex-col items-stretch gap-1 rounded-xl border border-line bg-panel p-1.5 shadow-lg shadow-black/40 backdrop-blur'
            : 'flex h-11 items-center gap-0.5 rounded-xl border border-line bg-panel px-1.5 shadow-lg shadow-black/40 backdrop-blur'
        }
      >
        <span
          className={
            vertical
              ? 'flex items-center gap-1.5 whitespace-nowrap px-2.5 pb-0.5 pt-1 text-xs text-ink-muted'
              : 'flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2 text-xs text-ink-muted'
          }
        >
          <IconNodeTree className="h-3.5 w-3.5 shrink-0" />
          {count} 节点
        </span>
        <span className={divider} />
        <button type="button" onClick={onStack} title="所选节点纵向堆叠排列" className={itemBtn}>
          <IconLayers className="h-3.5 w-3.5" />
          堆叠
        </button>
        <button type="button" onClick={onGrid} title="所选节点网格布局" className={itemBtn}>
          <IconGrid className="h-3.5 w-3.5" />
          布局
        </button>
        <span className={divider} />
        <button
          type="button"
          onClick={onDelete}
          title="删除所选节点"
          className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-xs text-ink-muted transition-colors hover:bg-wash-strong hover:text-ink"
        >
          <IconTrash className="h-3.5 w-3.5" />
          删除
        </button>
        <button type="button" onClick={onDownload} title="导出所选子图 JSON" className={itemBtn}>
          <IconDownload className="h-3.5 w-3.5" />
          下载
        </button>
        </div>
      </div>
    </div>
  );
});

/** 四角星路径（单位尺寸，绘制时按像素 setTransform 缩放） */
const STAR_PATH = new Path2D('M0 -2 L0.62 -0.62 L2 0 L0.62 0.62 L0 2 L-0.62 0.62 L-2 0 L-0.62 -0.62 Z');

interface BgStar {
  px: number;
  py: number;
  /** 涟漪波延迟（秒）：到画布视觉中心的格距 × 0.1 */
  delay: number;
  /** 闪烁相位与速度（每次运行随机） */
  phase: number;
  speed: number;
}

/**
 * 全屏星空背景（Canvas 实现）：整片天空只有一颗 <canvas>，星星每帧由 rAF
 * 直绘——无 DOM 无布局无样式重算，几千颗星也不拖累拖拽/缩放。
 * 闲置：静止低亮度星空；运行：每颗星按格距错相荡开（亮波）+ 随机相位闪烁。
 */
const StarField = memo(function StarField({ running, dark }: { running: boolean; dark: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: window.innerWidth, h: window.innerHeight });
  const starsRef = useRef<BgStar[]>([]);
  const rafRef = useRef<number | null>(null);
  const runningRef = useRef(running);
  runningRef.current = running;
  const darkRef = useRef(dark);
  darkRef.current = dark;

  /** 生成/重建星表：24px 网格铺满视口，波延迟按到视觉中心（50%,38%）的格距计算 */
  const buildStars = useCallback(() => {
    const { w, h } = sizeRef.current;
    const cols = Math.ceil(w / 24) + 1;
    const rows = Math.ceil(h / 24) + 1;
    const cx = w * 0.5;
    const cy = h * 0.38;
    const list: BgStar[] = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const px = x * 24 + 12;
        const py = y * 24 + 12;
        list.push({
          px,
          py,
          delay: (Math.hypot(px - cx, py - cy) / 24) * 0.1,
          phase: Math.random() * Math.PI * 2,
          speed: 1.5 + Math.random() * 1.5,
        });
      }
    }
    starsRef.current = list;
  }, []);

  /** 绘一帧：running 时 = 基础亮度 + 亮波（delay 错相）× 随机闪烁；闲置 = 纯基础亮度 */
  const draw = useCallback((t: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const rgb = darkRef.current ? '255,255,255' : '0,0,0';
    const base = darkRef.current ? 0.35 : 0.28;
    const isRunning = runningRef.current;
    for (const s of starsRef.current) {
      let alpha = base;
      if (isRunning) {
        const local = (t / 3000 + s.delay) % 1;
        // 亮波包络：0→0.3 升至峰值，0.3→0.5 平顶，0.5→0.9 回落（对应示例 0/40/60/100）
        const wave = local < 0.3 ? local / 0.3 : local < 0.5 ? 1 : Math.max(0, 1 - (local - 0.5) / 0.4);
        const twinkle = 0.55 + 0.45 * Math.sin(s.phase + (t / 1000) * s.speed);
        alpha = base + (1 - base) * wave * twinkle;
      }
      ctx.fillStyle = `rgba(${rgb},${alpha.toFixed(3)})`;
      ctx.setTransform(dpr, 0, 0, dpr, s.px * dpr, s.py * dpr);
      ctx.fill(STAR_PATH);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }, []);

  /** rAF 主循环：running 期间连续绘帧，停止后再绘一帧收尾（回到静态星空） */
  const loop = useCallback(
    (t: number) => {
      draw(t);
      rafRef.current = runningRef.current ? requestAnimationFrame(loop) : null;
    },
    [draw],
  );

  /** 尺寸变化：重设画布物理尺寸 + 重建星表 + 立即绘一帧（运行中由循环接管）
   *  尺寸取画布宿主容器而非视口——左侧抽屉展开会把画布挤窄，星星需随容器重排 */
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement ?? null;
    const resize = () => {
      const w = host?.clientWidth || window.innerWidth;
      const h = host?.clientHeight || window.innerHeight;
      sizeRef.current = { w, h };
      if (canvas) {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      buildStars();
      draw(performance.now());
    };
    resize();
    window.addEventListener('resize', resize);
    const observer = host ? new ResizeObserver(resize) : null;
    if (host) observer?.observe(host);
    return () => {
      window.removeEventListener('resize', resize);
      observer?.disconnect();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [buildStars, draw]);

  /** running 翻转：进入运行启动循环；退出时循环自停（最后一帧回到静态） */
  useEffect(() => {
    if (running && rafRef.current === null) rafRef.current = requestAnimationFrame(loop);
  }, [running, loop]);

  /** 主题切换：闲置状态下立即按新主题色重绘 */
  useEffect(() => {
    if (!running) draw(performance.now());
  }, [dark, running, draw]);

  return <canvas ref={canvasRef} className="star-canvas" aria-hidden />;
});

/** 聚焦节点位移过渡的挂载时长（对应 index.css .focus-node-move 的 0.4s，稍留余量） */
const FOCUS_MOVE_MS = 450;
/** 聚焦节点视觉放大倍数（与 index.css .focus-mode .node-card 的 scale 保持一致） */
const NODE_FOCUS_SCALE = 1.12;
/** 聚焦连线标识两端与节点/面板边缘的留白 */
const CONNECTOR_PAD = 12;
/** 聚焦连线标识测量重试窗口：面板/节点尺寸未就绪时 interval 重试（成功即停） */
const FOCUS_LINK_RETRY_MS = 1000;

/**
 * 聚焦连线标识：从右侧设置面板左缘中点到被选节点右缘中点画一条流动虚线（贝塞尔），
 * 表达「此面板属于该节点」。端点屏幕坐标（画布容器坐标系）：
 * - 节点右缘中点 = positionAbsolute × zoom + 视口平移(useStore transform) + 测量尺寸的一半
 *   （measured 为 flow 坐标系下未缩放尺寸，渲染尺寸需乘 zoom）
 * - 面板左缘中点 = 面板 getBoundingClientRect 与画布容器 rect 相减
 * 只要聚焦即无条件渲染 svg 容器与 path（几何未就绪时整体 hidden、path d 为空，
 * 绝不 return null——否则测量失败一次连线就永远缺席 DOM）；测量经 interval 重试
 * （rAF 在渲染被节流的标签页会被冻结，不可依赖），成功即停，上限 FOCUS_LINK_RETRY_MS。
 * transform（平移/缩放）、节点内部状态、容器与面板尺寸（展开收起宽度过渡、窗口 resize）
 * 变化时经 useLayoutEffect + ResizeObserver 自动重算。
 * path 带内联 stroke-dasharray 属性与 focus-link 类（供检测/查询），svg 带 data-focus-link。
 */
function FocusLink({
  nodeId,
  wrapperRef,
  panelRef,
}: {
  nodeId: string;
  wrapperRef: RefObject<HTMLDivElement>;
  panelRef: RefObject<HTMLElement>;
}) {
  const internalNode = useInternalNode<CanvasNode>(nodeId);
  const transform = useStore((s) => s.transform);
  const [geometry, setGeometry] = useState<{
    d: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } | null>(null);

  useLayoutEffect(() => {
    const deadline = Date.now() + FOCUS_LINK_RETRY_MS;
    let observer: ResizeObserver | null = null;
    let panelObserved = false;
    const measure = (): boolean => {
      const wrapper = wrapperRef.current;
      const width = internalNode?.measured.width;
      const panel = panelRef.current ?? document.getElementById('focus-config-panel');
      if (!wrapper || !width || width <= 0 || !panel) return false;
      const [tx, ty, zoom] = transform;
      const rect = wrapper.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      // 聚焦节点卡片被放大 NODE_FOCUS_SCALE（transform-origin center，垂直中心不动），
      // 缩放后右缘 = 左缘 + 宽 × (1 + scale) / 2，端点据此留白避免扎进放大的卡片
      const x1 =
        internalNode.internals.positionAbsolute.x * zoom +
        tx +
        (width * zoom * (1 + NODE_FOCUS_SCALE)) / 2 +
        CONNECTOR_PAD;
      const y1 =
        internalNode.internals.positionAbsolute.y * zoom +
        ty +
        (internalNode.measured.height ?? 0) * zoom * 0.5;
      const x2 = panelRect.left - rect.left - CONNECTOR_PAD;
      const y2 = panelRect.top + panelRect.height / 2 - rect.top;
      if (![x1, y1, x2, y2].every(Number.isFinite)) return false;
      const cx = (x1 + x2) / 2;
      setGeometry({
        d: `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`,
        x1,
        y1,
        x2,
        y2,
      });
      // 面板可能在聚焦首拍尚未挂载（ConfigPanel 经 effect 延迟一拍渲染），
      // 首次找到时补挂 ResizeObserver 跟踪其尺寸变化（展开收起/内容增减）
      if (observer && !panelObserved) {
        observer.observe(panel);
        panelObserved = true;
      }
      return true;
    };
    measure();
    // 重试用 interval：rAF 在节流标签页被冻结，interval 按 1s 节流后仍会触发
    const retryTimer = window.setInterval(() => {
      if (measure() || Date.now() > deadline) window.clearInterval(retryTimer);
    }, 120);
    observer = new ResizeObserver(measure);
    if (wrapperRef.current) observer.observe(wrapperRef.current);
    window.addEventListener('resize', measure);
    return () => {
      window.clearInterval(retryTimer);
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [internalNode, transform, wrapperRef, panelRef]);

  // 绝不 return null：聚焦期间 svg 与 path 始终存在于 DOM（查询/检测稳定），
  // 几何未就绪时整体 hidden、path d 置空、端点圆点半径 0，不产生任何绘制
  return (
    <svg
      aria-hidden="true"
      data-focus-link="true"
      style={{ visibility: geometry ? 'visible' : 'hidden' }}
      className="pointer-events-none absolute inset-0 z-[8] h-full w-full"
    >
      <path
        className="focus-link flow-dash"
        d={geometry?.d ?? ''}
        fill="none"
        strokeLinecap="round"
        strokeWidth={2}
        strokeDasharray="6 6"
      />
      <circle className="focus-link-dot" cx={geometry?.x1 ?? 0} cy={geometry?.y1 ?? 0} r={geometry ? 3 : 0} />
      <circle className="focus-link-dot" cx={geometry?.x2 ?? 0} cy={geometry?.y2 ?? 0} r={geometry ? 3 : 0} />
    </svg>
  );
}

function CanvasInner() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  /** 聚焦设置面板 aside 的 ref：FocusLink 测量面板矩形用（避免依赖 DOM id 查找时机） */
  const focusPanelRef = useRef<HTMLElement>(null);
  const { screenToFlowPosition, fitView, getViewport } = useReactFlow();
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const onNodesChange = useCanvasStore((s) => s.onNodesChange);
  const onEdgesChange = useCanvasStore((s) => s.onEdgesChange);
  const onConnect = useCanvasStore((s) => s.onConnect);
  const addNode = useCanvasStore((s) => s.addNode);
  const refetchModels = useSettingsStore((s) => s.refetch);
  const refetchKBs = useKBStore((s) => s.refetch);
  const navigate = useNavigate();
  const [nodeMenu, setNodeMenu] = useState<NodeMenuState | null>(null);

  /** 黑白主题：同步到 <html> 类（暗色无类 / 亮色挂 light）；卸载时移除，落地页保持暗色 */
  const theme = useUiStore((s) => s.theme);
  const creationOpen = useUiStore((s) => s.creationOpen);
  /** 画布交互模式：drag=左键拖拽平移（默认）/ select=左键拖拽框选 */
  const canvasMode = useUiStore((s) => s.canvasMode);
  const composing = useUiStore((s) => s.composing);
  const composingBusy = useUiStore((s) => s.composingBusy);
  const composingCanvasId = useUiStore((s) => s.composingCanvasId);
  const showToast = useUiStore((s) => s.showToast);
  /** 是否有节点在执行：驱动背景点阵炫彩涟漪提示动画 */
  const isRunning = useRunStore((s) => s.isRunning);

  /* ===== 选择模式：框选工具条（所选 ≥2 节点时浮现）===== */
  /** 当前所选节点 id（RF 经 onNodesChange 派发 select 变更，store 内 selected 已同步） */
  const selectedIds = useMemo(() => nodes.filter((n) => n.selected).map((n) => n.id), [nodes]);

  /** 批量更新所选节点位置（走 onNodesChange，进持久化管线） */
  const moveSelection = useCallback(
    (positions: Map<string, XYPosition>) => {
      if (positions.size === 0) return;
      useCanvasStore
        .getState()
        .onNodesChange(
          [...positions].map(([id, position]) => ({ id, type: 'position', position, dragging: false })),
        );
    },
    []
  );

  /** 堆叠：按 y 排序后纵向排列（左缘对齐选区最左，间隙 24px，高度用实测值回退 220） */
  const stackSelection = useCallback(() => {
    const sel = nodes.filter((n) => n.selected);
    if (sel.length === 0) return;
    const baseX = Math.min(...sel.map((n) => n.position.x));
    let y = Math.min(...sel.map((n) => n.position.y));
    const positions = new Map<string, XYPosition>();
    for (const n of [...sel].sort((a, b) => a.position.y - b.position.y)) {
      positions.set(n.id, { x: baseX, y });
      y += (n.measured?.height ?? 220) + 24;
    }
    moveSelection(positions);
  }, [nodes, moveSelection]);

  /** 布局：近似正方网格（列距 380 / 行距 300，锚定选区左上角，按 y→x 排序） */
  const gridSelection = useCallback(() => {
    const sel = nodes.filter((n) => n.selected);
    if (sel.length === 0) return;
    const cols = Math.ceil(Math.sqrt(sel.length));
    const baseX = Math.min(...sel.map((n) => n.position.x));
    const baseY = Math.min(...sel.map((n) => n.position.y));
    const positions = new Map<string, XYPosition>();
    [...sel]
      .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
      .forEach((n, i) => {
        positions.set(n.id, {
          x: baseX + (i % cols) * 380,
          y: baseY + Math.floor(i / cols) * 300,
        });
      });
    moveSelection(positions);
  }, [nodes, moveSelection]);

  /** 删除所选节点（相关连线由 applyNodeChanges 一并清除） */
  const deleteSelection = useCallback(() => {
    if (selectedIds.length === 0) return;
    useCanvasStore
      .getState()
      .onNodesChange(selectedIds.map((id) => ({ id, type: 'remove' })));
    showToast(`已删除 ${selectedIds.length} 个节点`);
  }, [selectedIds, showToast]);

  /** 下载：导出所选子图为工作流 JSON（仅保留两端都在所选内的连线） */
  const downloadSelection = useCallback(() => {
    const sel = new Set(selectedIds);
    if (sel.size === 0) return;
    const { nodes: all, edges: allEdges, name } = useCanvasStore.getState();
    const json: WorkflowJSON = {
      version: WORKFLOW_VERSION,
      name: name ? `${name}-所选` : DEFAULT_WORKFLOW_NAME,
      nodes: all
        .filter((n) => sel.has(n.id))
        .map((n) => ({
          id: n.id,
          type: n.data.type,
          position: { x: n.position.x, y: n.position.y },
          data: n.data,
        })),
      edges: allEdges
        .filter((e) => sel.has(e.source) && sel.has(e.target))
        .map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle ?? undefined,
        })),
    };
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${json.name}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    showToast('已导出所选子图 JSON');
  }, [selectedIds, showToast]);

  /* ===== /chat 路由：一键创作「生成」对话面板 ===== */
  /** /chat 即创作面板（生成模式）：?session=<id> 恢复对应历史会话，无参数=新对话。
      「画布」模式切换走 /canvas（不动面板状态），Esc 关闭由 close() 回 /canvas。 */
  const [searchParams] = useSearchParams();
  const location = useLocation();
  useEffect(() => {
    if (location.pathname !== '/chat') {
      // 浏览器后退离开 /chat（mode 仍是 generate）：关闭面板，避免画布上残留对话面板；
      // 正常切「画布」模式会先写 composerMode='compose'，不进此分支
      const ui = useUiStore.getState();
      if (location.pathname === '/canvas' && ui.composerMode === 'generate' && creationOpen) {
        ui.setCreationOpen(false);
      }
      return;
    }
    const ui = useUiStore.getState();
    ui.setComposerMode('generate');
    ui.setActiveCreationSessionId(searchParams.get('session'));
    ui.setCreationOpen(true);
  }, [location.pathname, searchParams, creationOpen]);

  /* ===== 挂载引导期：抑制节点位移过渡 ===== */
  /**
   * RF 首帧先挂载节点、随后才应用真实坐标并 fitView，这段位置变化会被
   * .react-flow__node 的 0.35s 过渡播成"节点飞入再弹回"。挂载后 700ms 内给
   * 画布容器挂 .canvas-boot（index.css 强制关闭节点过渡），超时后移除，
   * 恢复聚焦模式等场景的正常位移动画。
   */
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setBooted(true), 700);
    return () => window.clearTimeout(timer);
  }, []);

  /* ===== 聚焦编辑模式状态 ===== */
  /**
   * 聚焦节点 id：显式状态，仅由 onNodeClick（真点击）进入——RF v12 节点拖拽后
   * 不触发 click，因此拖拽选中不会误入聚焦；框选等其它选中路径同样不触发。
   * 选中态变化只做同步兜底（见下方 layout effect），不驱动进入。
   */
  const [focusId, setFocusId] = useState<string | null>(null);
  /** 位移过渡类 .focus-node-move 是否临时挂载（仅进入/退出聚焦的瞬间） */
  const [focusMove, setFocusMove] = useState(false);
  const internalFocus = useInternalNode<CanvasNode>(focusId ?? '');
  /** 进入聚焦时记录的原始 position（退出时写回），最多同时存在一条（聚焦唯一） */
  const originalPositionsRef = useRef(new Map<string, XYPosition>());
  const prevFocusIdRef = useRef<string | null>(null);
  const moveTimerRef = useRef<number | null>(null);
  /** 退出聚焦的短暂窗口：期间连线播放"从源节点生长"画线动画（.focus-exit） */
  const [focusExit, setFocusExit] = useState(false);
  /** focusExit 窗口定时器（780ms = 画线动画 0.65s + 缓冲） */
  const exitTimerRef = useRef<number | null>(null);

  /** 退出聚焦唯一入口：焦点清除与 .focus-exit 动画窗口同批提交，
   *  保证首帧即带动画类（连线从隐藏状态开始生长），不会先闪现完整连线 */
  const exitFocus = useCallback(() => {
    setFocusId(null);
    if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
    setFocusExit(true);
    exitTimerRef.current = window.setTimeout(() => setFocusExit(false), 780);
  }, []);

  /**
   * 聚焦同步兜底：聚焦节点被删除或被取消选中（面板关闭/Esc/pane click/Delete 键）
   * 时退出聚焦。只负责退出，不负责进入；用 useLayoutEffect 在 paint 前退出，
   * 避免 focus-mode 隐藏样式对中间态多绘制一帧。
   */
  useLayoutEffect(() => {
    if (!focusId) return;
    const node = useCanvasStore.getState().nodes.find((n) => n.id === focusId);
    if (!node || !node.selected) exitFocus();
  }, [nodes, focusId, exitFocus]);

  /**
   * 聚焦模式状态流转：
   * - 进入（无选中 → 选中）：记录节点原始 position → 目标位置（节点中心 ≈ 画布宽 30% /
   *   高 45%，经 screenToFlowPosition 换算）写入 store，临时挂 .focus-node-move 过渡类平滑移动
   * - 切换（选中 A → 选中 B）：A 先还原原始位置，B 再移到目标位置
   * - 退出（选中 → 无选中）：节点位置还原；过渡类短暂保留让还原动画播完
   * 位移只改 position（走 RF 节点变更管线），不改 node.hidden，不污染撤销历史与持久化
   */
  useEffect(() => {
    const prevId = prevFocusIdRef.current;
    prevFocusIdRef.current = focusId;
    if (focusId === prevId) return;

    const beginMove = () => {
      setFocusMove(true);
      if (moveTimerRef.current !== null) window.clearTimeout(moveTimerRef.current);
      moveTimerRef.current = window.setTimeout(() => setFocusMove(false), FOCUS_MOVE_MS);
    };
    const restorePosition = (id: string) => {
      const original = originalPositionsRef.current.get(id);
      if (!original) return;
      originalPositionsRef.current.delete(id);
      useCanvasStore.getState().onNodesChange([
        { id, type: 'position', position: original, dragging: false },
      ]);
    };

    if (focusId) {
      const node = useCanvasStore.getState().nodes.find((n) => n.id === focusId);
      if (!node) return;
      if (!originalPositionsRef.current.has(focusId)) {
        originalPositionsRef.current.set(focusId, { ...node.position });
      }
      if (prevId) restorePosition(prevId);
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      const flowCenter = screenToFlowPosition({
        x: rect.left + rect.width * 0.3,
        y: rect.top + rect.height * 0.45,
      });
      beginMove();
      useCanvasStore.getState().onNodesChange([
        {
          id: focusId,
          type: 'position',
          position: {
            x: flowCenter.x - (internalFocus?.measured.width ?? 0) / 2,
            y: flowCenter.y - (internalFocus?.measured.height ?? 0) / 2,
          },
          dragging: false,
        },
      ]);
    } else if (prevId) {
      beginMove();
      restorePosition(prevId);
      // 连线生长动画窗口由 exitFocus（唯一退出入口）同批触发，这里不再重复挂
    }
  }, [focusId, internalFocus, screenToFlowPosition]);

  /** 卸载（如路由切走）时还原仍处于聚焦位移的节点位置，避免位移坐标被持久化 */
  useEffect(
    () => () => {
      if (moveTimerRef.current !== null) window.clearTimeout(moveTimerRef.current);
      if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
      const pending = originalPositionsRef.current;
      if (pending.size === 0) return;
      const { nodes: current, onNodesChange } = useCanvasStore.getState();
      const changes: NodeChange<CanvasNode>[] = [];
      for (const [id, position] of pending) {
        if (!current.some((n) => n.id === id)) continue;
        changes.push({ id, type: 'position', position, dragging: false });
      }
      pending.clear();
      if (changes.length > 0) onNodesChange(changes);
    },
    []
  );

  /** 挂载时拉取一次网关模型清单（供 LLM / 图像 / Agent 配置下拉使用） */
  useEffect(() => {
    void refetchModels();
  }, [refetchModels]);

  /** 挂载时拉取一次知识库列表（供 KBPanel 与检索节点配置下拉使用） */
  useEffect(() => {
    void refetchKBs();
  }, [refetchKBs]);

  /** 从首页「查看模板」跳转（/canvas?templates=1）时重定向到模板中心页 */
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('templates') === '1') {
      window.history.replaceState(null, '', '/canvas');
      navigate('/templates', { replace: true });
    }
    // 仅首次挂载检查一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 多画布：首次进入用当前画布初始化清单；activeId 失效时修复 */
  const activeCanvasId = useWorkspaceStore((s) => s.activeId);
  const ensureWorkspace = useWorkspaceStore((s) => s.ensureInit);
  const switchCanvas = useWorkspaceStore((s) => s.switchCanvas);
  useEffect(() => {
    ensureWorkspace();
  }, [ensureWorkspace]);

  /* ===== /canvas 路由：URL ?session=<画布id> 与工作区 activeId 双向同步 ===== */
  /** 与对话参数（/chat?session=<会话id>）同参数名、按路由各自解析：侧边栏点画布 / 新建画布 →
      activeId 变化 → URL 同步（replace）；刷新或粘贴带参 URL → 按 URL 恢复对应画布；无效 id 回退当前画布。
      方向仲裁：URL 深链只在挂载首跑生效（刷新/粘贴恢复场景），此后一律以 store 为准、URL 跟随——
      否则一键创作 createCanvas 切到新画布后，URL 里残留的旧 id 会把画布又切回去，
      流式返回时画布守卫误判「已取消工作流生成」。 */
  const urlSyncBootRef = useRef(false);
  useEffect(() => {
    if (location.pathname !== '/canvas') return;
    const urlId = searchParams.get('session');
    if (!urlSyncBootRef.current) {
      urlSyncBootRef.current = true;
      // 首跑：URL 深链优先
      if (urlId && urlId !== activeCanvasId) {
        if (useWorkspaceStore.getState().canvases.some((c) => c.id === urlId)) {
          switchCanvas(urlId);
          return;
        }
      }
    }
    if (activeCanvasId && urlId !== activeCanvasId) {
      navigate(`/canvas?session=${activeCanvasId}`, { replace: true });
    }
  }, [location.pathname, searchParams, activeCanvasId, switchCanvas, navigate]);

  /** 切换画布后把视口适配到新画布内容（延迟一帧等节点测量完成）。
      用「上一帧 activeId」判断是否真的发生了切换：StrictMode 下 mount 会连跑两次
      effect，布尔首跑守卫会把第二次误判成切换，导致每次进入画布都动画重取景
      （即"节点位移再恢复"）。首次挂载与 id 未变化时交给 RF 自身 fitView。 */
  const prevActiveIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeCanvasId) return;
    const prev = prevActiveIdRef.current;
    prevActiveIdRef.current = activeCanvasId;
    if (prev === null || prev === activeCanvasId) return;
    const raf = requestAnimationFrame(() => {
      void fitView({ padding: 0.2, duration: 320 });
    });
    return () => cancelAnimationFrame(raf);
  }, [activeCanvasId, fitView]);

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      if (useUiStore.getState().composingBusy) return; // 编排期间锁定：禁止手动加节点
      const raw = event.dataTransfer.getData(DRAG_MIME);
      if (!isNodeType(raw)) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const newId = addNode(raw, position);
      // 幽灵卡片按 100% 屏幕尺寸渲染，画布缩放为 z 时落点节点视觉上更小：
      // 以 1/z 为起点播一次缩放过渡，让节点从幽灵尺寸平滑「落」到实际大小
      const zoom = getViewport().zoom;
      const from = Number.isFinite(zoom) && zoom > 0 ? Math.min(2.2, 1 / zoom) : 1;
      if (from > 1.05) useCanvasStore.getState().beginNodeSpawn(newId, from);
    },
    [addNode, screenToFlowPosition, getViewport]
  );

  /** 空画布引导：添加一个输入节点到画布中心 */
  const addInputToCenter = useCallback(() => {
    if (useUiStore.getState().composingBusy) return; // 编排期间锁定
    const rect = wrapperRef.current?.getBoundingClientRect();
    const screen = rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    addNode('input', screenToFlowPosition(screen));
  }, [addNode, screenToFlowPosition]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-base text-ink">
      {/* 左侧画布抽屉：flex 子项占位，展开时把画布整体挤向右侧（非悬浮覆盖） */}
      <ProjectSidebar />

      <div className="relative min-w-0 flex-1 overflow-hidden">
      {/* 一键创作面板：独立创作入口，覆盖画布主区与四角控件（侧边栏保持可见），Esc 返回画布 */}
      {creationOpen && <CreationPanel />}
      {/* 画布：铺满可用区域，背景与暗角由 index.css 的 .react-flow 提供；
          聚焦模式下挂 .focus-mode（隐藏聚焦节点之外的节点与全部连线），
          移动瞬间临时挂 .focus-node-move */}
      <div
        ref={wrapperRef}
        className={`absolute inset-0 bg-base ${booted ? '' : 'canvas-boot'} ${focusId ? 'focus-mode' : ''} ${
          focusMove ? 'focus-node-move' : ''
        } ${focusExit ? 'focus-exit' : ''}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
      >
        {/* 星空背景本体（全屏十字星）；运行时同批星星荡开 + 随机闪烁 */}
        <StarField running={isRunning} dark={theme === 'dark'} />
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          /** 剪刀：点击连线即剪断（悬停时剪刀光标由 index.css 提供）；编排期间锁定 */
          onEdgeClick={(_, edge: Edge) => {
            if (composingBusy) return;
            onEdgesChange([{ id: edge.id, type: 'remove' }]);
          }}
          onNodeContextMenu={(event, node) => {
            if (composingBusy) return;
            event.preventDefault();
            setNodeMenu({ x: event.clientX, y: event.clientY, nodeId: node.id });
          }}
          /** 真点击节点才进入聚焦（拖拽后 RF v12 不派发 click）；选择模式下点击仅框选不聚焦 */
          onNodeClick={(_, node) => {
            if (!composingBusy && canvasMode === 'drag') setFocusId(node.id);
          }}
          onPaneClick={() => {
            setNodeMenu(null);
            exitFocus();
          }}
          onMoveStart={() => setNodeMenu(null)}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          /** 交互模式：drag=左键拖拽平移（默认）/ select=左键拖拽框选（部分相交即选中） */
          selectionOnDrag={canvasMode === 'select'}
          panOnDrag={canvasMode !== 'select'}
          selectionMode={SelectionMode.Partial}
          /** 一键创作全程锁（流式 + 装配动画）：只保留观察，禁止拖动/连线/框选/删除节点 */
          nodesDraggable={!composingBusy}
          nodesConnectable={!composingBusy}
          elementsSelectable={!composingBusy}
          deleteKeyCode={composingBusy ? null : ['Delete', 'Backspace']}
          colorMode={theme}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        />
        {/* 编排锁定遮罩：盖住画布拦截一切指针交互（含平移缩放），只透出状态卡与提示条 */}
        {composingBusy && composingCanvasId === activeCanvasId && (
          <div className="animate-rise-in absolute inset-0 z-20 cursor-wait bg-base/25 backdrop-blur-[1.5px]" />
        )}
      </div>

      {/* 框选工具条：仅选择模式下随所选 ≥2 节点贴框选区四边智能浮现（上>下>左>右，
          横排放不下自动落左右竖排并夹紧完整显示；切到拖动模式 / 聚焦态 / 创作面板 / 编排中隐藏） */}
      {selectedIds.length >= 2 &&
        canvasMode === 'select' &&
        !focusId &&
        !creationOpen &&
        !composingBusy && (
        <SelectionToolbar
          ids={selectedIds}
          count={selectedIds.length}
          onStack={stackSelection}
          onGrid={gridSelection}
          onDelete={deleteSelection}
          onDownload={downloadSelection}
        />
      )}

      {/* 四角浮动控件（各自绝对定位，不拦截画布交互） */}
      <MemoTopLeftBar />
      <MemoTopRightBar />
      <MemoLeftDock />
      <MemoBottomLeftBar />
      <MemoBottomRightBar />

      {/* 空画布引导：轻量居中浮动卡；一键创作编排期间改为「正在编排」状态卡 */}
      {nodes.length === 0 && composing && (
        <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center">
          <div className="pointer-events-auto flex w-[340px] animate-rise-in flex-col items-center rounded-xl border border-line bg-panel px-8 py-8 text-center shadow-xl shadow-black/30 backdrop-blur">
            <svg
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              aria-hidden="true"
              className="h-8 w-8 animate-spin text-ink-muted"
            >
              <path d="M10 2.8a7.2 7.2 0 1 0 7.2 7.2" />
            </svg>
            <h2 className="mt-4 text-sm font-medium text-ink">正在编排工作流</h2>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">{composing}</p>
          </div>
        </div>
      )}
      {nodes.length === 0 && !composing && (
        <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center">
          <div className="pointer-events-auto flex w-[340px] animate-rise-in flex-col items-center rounded-xl border border-line bg-panel px-8 py-8 text-center shadow-xl shadow-black/30 backdrop-blur">
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-wash-strong text-ink">
              <IconLayers className="h-6 w-6" />
            </span>
            <h2 className="mt-4 text-sm font-medium text-ink">从空白开始编排</h2>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
              从左侧节点坞拖入或单击添加节点，
              <br />
              或打开模板中心一键生成完整工作流
            </p>
            <div className="mt-5 flex items-center gap-2.5">
              <Button variant="mono" size="sm" onClick={() => navigate('/templates')}>
                <span className="flex items-center gap-1.5">
                  <IconSparkles className="h-3.5 w-3.5" />
                  打开模板中心
                </span>
              </Button>
              <Button variant="secondary" size="sm" onClick={addInputToCenter}>
                <span className="flex items-center gap-1.5">
                  <IconPlus className="h-3.5 w-3.5" />
                  添加输入节点
                </span>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 聚焦连线标识：设置面板 ↔ 被选节点（z 低于设置面板，不拦截画布交互） */}
      {focusId && (
        <FocusLink nodeId={focusId} wrapperRef={wrapperRef} panelRef={focusPanelRef} />
      )}
      </div>

      {/* 聚焦设置面板（真点击节点后自右滑入）与既有浮层 */}
      <ConfigPanel panelRef={focusPanelRef} focusId={focusId} onClose={exitFocus} />
      <MemoKBPanel />
      <NodeContextMenu menu={nodeMenu} onClose={() => setNodeMenu(null)} />
      <MemoToast />
    </div>
  );
}

export function CanvasPage() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
