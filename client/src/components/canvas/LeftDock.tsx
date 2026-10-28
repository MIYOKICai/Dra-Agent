/**
 * 左侧节点坞：竖向图标条（52px），八类节点自上而下排列。
 * - 单击：添加到画布可视区域中心
 * - HTML5 拖拽：拖入画布落点处添加（DRAG_MIME 由画布 onDrop 消费）；
 *   拖拽幽灵用自定义节点卡片（与真实节点同款样式），而非坞按钮的浏览器默认截图
 * - 悬停：右侧浮出 tooltip（图标 + 名称 + 一句描述）
 */
import { useCallback, useRef, type DragEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { NodeType } from '@shared/types';
import { NODE_DEFS, NODE_TYPES } from '../../nodes/registry';
import { nodeTypes } from '../../nodes';
import { useCanvasStore, type CanvasNode } from '../../store/canvasStore';
import { useUiStore } from '../../store/uiStore';
import { useReactFlow, ReactFlowProvider, type NodeProps } from '@xyflow/react';

/** 拖拽负载的 MIME 类型（画布 onDrop 据此识别节点类型） */
export const DRAG_MIME = 'application/reactflow';

/** 1×1 透明 GIF：作为 setDragImage 参数把原生拖拽截图压成不可见 */
let blankDragImage: HTMLImageElement | null = null;
function getBlankDragImage(): HTMLImageElement {
  if (!blankDragImage) {
    blankDragImage = document.createElement('img');
    blankDragImage.src =
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    blankDragImage.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(blankDragImage);
  }
  return blankDragImage;
}

/**
 * 拖拽幽灵：直接渲染该类型的真实节点组件（NodeShell 头部/正文/底部提示齐全），
 * 与画布上落下的节点一模一样。节点组件仅消费 id/data/selected，
 * 其余 NodeProps 字段补默认值后断言传入；Handles 为纯展示 div，交互天然失效。
 */
function DragGhost({ type }: { type: NodeType }) {
  const def = NODE_DEFS[type];
  const NodeComp = nodeTypes[type];
  const fakeNode = {
    id: '__ghost__',
    type,
    position: { x: 0, y: 0 },
    data: { type, label: def.label, config: {} },
    selected: false,
    isConnectable: false,
    dragging: false,
    zIndex: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  } as unknown as NodeProps<CanvasNode>;
  return (
    <div className="w-[280px] rounded-xl border border-line bg-panel shadow-2xl shadow-black/60">
      {/* 幽灵宿主挂 document.body，是独立 React 根——必须自带 ReactFlowProvider，
          否则节点组件内 Handle 的 useStoreApi 找不到上下文直接抛错 */}
      <ReactFlowProvider>
        <NodeComp {...fakeNode} />
      </ReactFlowProvider>
    </div>
  );
}

export function LeftDock() {
  const { screenToFlowPosition } = useReactFlow();

  /** 节点坞单击添加：落到画布可视区域中心（编排期间锁定） */
  const addToCenter = useCallback(
    (type: NodeType) => {
      if (useUiStore.getState().composingBusy) return;
      const rect = document.querySelector('.react-flow')?.getBoundingClientRect();
      const screen = rect
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      useCanvasStore.getState().addNode(type, screenToFlowPosition(screen));
    },
    [screenToFlowPosition]
  );

  /** 拖拽幽灵宿主：pointerdown 提前渲染，dragover 逐帧跟随光标，dragend/pointerup 清理 */
  const ghostRef = useRef<{ host: HTMLDivElement; root: Root } | null>(null);
  /** 拖动期间的 document 级 dragover 监听（驱动幽灵跟随），清理时移除 */
  const moveHandlerRef = useRef<((e: globalThis.DragEvent) => void) | null>(null);

  const clearGhost = useCallback(() => {
    if (moveHandlerRef.current) {
      document.removeEventListener('dragover', moveHandlerRef.current);
      moveHandlerRef.current = null;
    }
    const ghost = ghostRef.current;
    if (!ghost) return;
    ghostRef.current = null;
    ghost.root.unmount();
    ghost.host.remove();
  }, []);

  const buildGhost = useCallback(
    (type: NodeType) => {
      // 屏幕内宿主（先藏到视口外）同步渲染真实节点组件；拖动时经 dragover 移位跟随。
      // 不用 setDragImage 截图：Chromium 对截图套一层半透明合成，怎么调样式都发虚。
      clearGhost();
      const host = document.createElement('div');
      host.style.cssText =
        'position:fixed;top:0;left:0;z-index:60;pointer-events:none;transform:translate(-9999px,-9999px);';
      document.body.appendChild(host);
      const root = createRoot(host);
      flushSync(() => root.render(<DragGhost type={type} />));
      ghostRef.current = { host, root };
    },
    [clearGhost]
  );

  const onDragStart = (event: DragEvent<HTMLButtonElement>, type: NodeType) => {
    if (useUiStore.getState().composingBusy) {
      event.preventDefault(); // 编排期间锁定：禁止拖拽添加节点
      return;
    }
    event.dataTransfer.setData(DRAG_MIME, type);
    event.dataTransfer.effectAllowed = 'move';
    // 原生幽灵压成 1px 透明图（所有浏览器稳定支持），视觉完全交给自绘跟随卡片
    try {
      event.dataTransfer.setDragImage(getBlankDragImage(), 0, 0);
    } catch {
      /* 个别环境不支持时保留默认截图，不影响自绘层 */
    }
    // dragover 在拖动全程按指针位置高频触发 → 实时把宿主卡片贴到光标右下
    const host = ghostRef.current?.host;
    if (!host) return;
    const onMove = (e: globalThis.DragEvent) => {
      host.style.transform = `translate(${e.clientX + 16}px, ${e.clientY + 16}px)`;
    };
    document.addEventListener('dragover', onMove);
    moveHandlerRef.current = onMove;
  };

  return (
    <div className="absolute left-4 top-1/2 z-10 flex -translate-y-1/2 flex-col items-center gap-1 rounded-xl border border-line bg-panel p-2 shadow-lg shadow-black/40 backdrop-blur">
      {NODE_TYPES.map((type) => {
        const def = NODE_DEFS[type];
        return (
          <div key={type} className="group relative">
            <button
              type="button"
              draggable
              onDragStart={(e) => onDragStart(e, type)}
              onDragEnd={clearGhost}
              onPointerDown={() => buildGhost(type)}
              onPointerUp={clearGhost}
              onClick={() => addToCenter(type)}
              className="flex h-10 w-10 cursor-grab items-center justify-center rounded transition-colors hover:bg-wash active:cursor-grabbing active:bg-wash-strong"
            >
              <def.icon className={`h-[18px] w-[18px] ${def.color}`} />
            </button>
            {/* 右侧浮出 tooltip：图标 + 名称 + 描述 */}
            <div className="pointer-events-none absolute left-full top-1/2 z-20 ml-3 -translate-y-1/2 translate-x-1 whitespace-nowrap rounded-lg border border-line bg-elevated px-3 py-2 opacity-0 shadow-xl shadow-black/50 transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100">
              <div className="flex items-center gap-2.5">
                <def.icon className={`h-4 w-4 shrink-0 ${def.color}`} />
                <div>
                  <p className="text-xs font-medium text-ink">{def.label}</p>
                  <p className="mt-0.5 text-[10px] leading-snug text-ink-muted">
                    {def.description}
                  </p>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
