/**
 * 配置面板：聚焦编辑模式下自右滑入的节点设置面板。
 * - 容器：画布右侧 420px 圆角卡（展开 560px），挂载后类翻转触发 opacity/translate
 *   过渡滑入（不用 CSS animation：渲染被节流的标签页动画 currentTime 冻结在 0%，
 *   无论 fill both/backwards 都钉在 from 帧，终值不可靠；transition 只负责过程，
 *   终值永远是类对应的计算样式）；关闭时类翻回隐藏态，保留最后一个选中节点
 *   快照约 220ms 播完出场过渡再卸载
 * - 头部：类型徽标 + 节点名内联编辑 + 展开/收起（420 ↔ 560px）+ 关闭
 * - 参数条：该节点常用参数 chip（CONFIG_FOOTERS）横排 + 右端 v 形折叠按钮
 * - 主体：主文本自由书写区（自动增高 + 字符计数 + 上游变量插入）→ 其余参数分区
 * - 底部：左侧剩余参数 chip（CONFIG_TAIL_CHIPS），右端圆形运行按钮（复用 runStore.startAll）
 * 显示由画布传入的 focusId（真点击驱动的显式聚焦状态）驱动，关闭 = 清选中 + 退出聚焦
 * （按钮 / Esc）；画布点空白由画布侧 onPaneClick 直接退出。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { NodeChange } from '@xyflow/react';
import { useCanvasStore, type CanvasEdge, type CanvasNode } from '../store/canvasStore';
import { useRunStore } from '../store/runStore';
import { NODE_DEFS } from '../nodes/registry';
import { CONFIG_FORMS, CONFIG_FOOTERS, CONFIG_TAIL_CHIPS } from './configs';
import {
  IconArrowUp,
  IconChevronDown,
  IconCollapse,
  IconExpand,
  IconX,
} from '../components/icons';

/** 关闭时面板滑出过渡时长（transition duration-200，稍留余量再卸载） */
const EXIT_ANIMATION_MS = 220;

/** 收集节点全部上游（祖先）的 label（去重、就近优先），供主文本区的 + 变量插入 */
function ancestorLabels(id: string, nodes: CanvasNode[], edges: CanvasEdge[]): string[] {
  const parents = new Map<string, string[]>();
  for (const e of edges) {
    parents.set(e.target, [...(parents.get(e.target) ?? []), e.source]);
  }
  const seen = new Set([id]);
  const queue = [...(parents.get(id) ?? [])];
  const labels: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(parents.get(current) ?? []));
    const node = nodes.find((n) => n.id === current);
    if (node && !labels.includes(node.data.label)) labels.push(node.data.label);
  }
  return labels;
}

export function ConfigPanel({
  panelRef,
  focusId,
  onClose,
}: {
  panelRef: RefObject<HTMLElement>;
  /** 当前聚焦节点 id（画布 onNodeClick 真点击驱动的显式状态；null = 非聚焦/出场中） */
  focusId: string | null;
  /** 请求退出聚焦：画布侧清 focusId；本组件同时清节点选中（同一事件批次，无闪隐） */
  onClose: () => void;
}) {
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const isRunning = useRunStore((s) => s.isRunning);
  const [expanded, setExpanded] = useState(false);
  const [chipsOpen, setChipsOpen] = useState(true);

  /** 关闭聚焦面板：清除全部节点选中态 + 通知画布退出聚焦（关闭按钮与 Esc 共用） */
  const close = useCallback(() => {
    const { nodes: current, onNodesChange } = useCanvasStore.getState();
    onNodesChange(
      current.map((n): NodeChange<CanvasNode> => ({ id: n.id, type: 'select', selected: false }))
    );
    onClose();
  }, [onClose]);

  /**
   * 面板显示状态：跟随选中节点；关闭时保留最后一个节点快照 ~220ms 播完滑出过渡再卸载，
   * 避免面板随选中态消失而瞬间蒸发。
   */
  const [panel, setPanel] = useState<{ id: string; leaving: boolean } | null>(null);
  const lastIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (focusId) {
      lastIdRef.current = focusId;
      setPanel({ id: focusId, leaving: false });
      return;
    }
    const last = lastIdRef.current;
    if (!last) return;
    setPanel({ id: last, leaving: true });
    const timer = window.setTimeout(() => setPanel(null), EXIT_ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, [focusId]);

  /**
   * 入场/出场过渡翻转：挂载后下一拍（16ms，跨过首帧提交）把 shown 置 true 触发
   * opacity/translate 过渡；关闭时立即翻回 false 播出场过渡。不依赖 CSS animation——
   * 节流标签页动画 currentTime 冻结在 0% 时终值不可靠，transition 终值恒为类对应样式。
   */
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!panel || panel.leaving) {
      setShown(false);
      return;
    }
    const t = window.setTimeout(() => setShown(true), 16);
    return () => window.clearTimeout(t);
  }, [panel]);

  /** Esc 关闭聚焦面板（滑出期间不重复挂监听） */
  useEffect(() => {
    if (!panel || panel.leaving) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [panel, close]);

  const panelNode = panel ? nodes.find((n) => n.id === panel.id) : undefined;
  if (!panel || !panelNode) return null;

  const def = NODE_DEFS[panelNode.data.type];
  const Form = CONFIG_FORMS[panelNode.data.type];
  const Footer = CONFIG_FOOTERS[panelNode.data.type];
  const TailChips = CONFIG_TAIL_CHIPS[panelNode.data.type];
  const variables = ancestorLabels(panelNode.id, nodes, edges);

  return (
    /* 定位：画布右侧全高卡（top-16/bottom-16 避开顶部/底部浮动控件）；
       opacity/translate/width 统一走 transition 翻转（shown=false 时整体隐藏并
       放行点击穿透），终值不依赖动画完成态，节流标签页下必然可见 */
    <aside
      ref={panelRef}
      id="focus-config-panel"
      className={`absolute right-4 top-16 bottom-16 z-20 flex flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl shadow-black/50 backdrop-blur transition-[opacity,transform,width] duration-200 ease-out ${
        expanded ? 'w-[560px]' : 'w-[420px]'
      } ${shown ? 'opacity-100 translate-x-0' : 'pointer-events-none opacity-0 translate-x-5'}`}
    >
      {/* 头部：类型徽标 + 名称内联编辑 + 展开/收起 + 关闭 */}
      <header className="flex shrink-0 items-center gap-2 px-3 pb-1.5 pt-3">
        <def.icon className={`h-4 w-4 shrink-0 ${def.color}`} />
        <span
          className={`shrink-0 rounded-full bg-wash-strong px-2 py-0.5 text-[10px] font-medium ${def.color}`}
        >
          {def.label}
        </span>
        <input
          aria-label="节点名称"
          className="min-w-0 flex-1 rounded-base bg-transparent px-2 py-1 text-sm font-medium text-ink outline-none transition-colors placeholder:text-ink-muted hover:bg-wash-faint focus:bg-wash-faint"
          value={panelNode.data.label}
          placeholder="节点名称"
          onChange={(e) => updateNodeData(panelNode.id, { label: e.target.value })}
        />
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded text-ink-muted transition-colors hover:bg-wash hover:text-ink"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? '收起面板' : '展开面板'}
          >
            {expanded ? <IconCollapse className="h-4 w-4" /> : <IconExpand className="h-4 w-4" />}
          </button>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded text-ink-muted transition-colors hover:bg-wash hover:text-ink"
            onClick={close}
            title="关闭"
          >
            <IconX className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* 参数条：常用参数 chip 横排 + 右端 v 形折叠按钮（收起后仅保留按钮可再展开） */}
      {Footer && (
        <div className="flex shrink-0 items-center gap-1 px-3 pb-1">
          {chipsOpen && (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              <Footer id={panelNode.id} data={panelNode.data} />
            </div>
          )}
          <button
            type="button"
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-wash hover:text-ink ${
              chipsOpen ? '' : 'ml-auto'
            }`}
            onClick={() => setChipsOpen((v) => !v)}
            title={chipsOpen ? '收起参数条' : '展开参数条'}
            aria-expanded={chipsOpen}
          >
            <IconChevronDown
              className={`h-3.5 w-3.5 transition-transform duration-200 ${
                chipsOpen ? '' : '-rotate-90'
              }`}
            />
          </button>
        </div>
      )}

      {/* 主体：变量行 + 主文本创作区 + 其余参数分区（configs 内部用发丝线分隔） */}
      <div className="composer-scope no-scrollbar min-h-0 flex-1 overflow-y-auto px-4">
        <Form id={panelNode.id} data={panelNode.data} expanded={expanded} variables={variables} />
        <p className="mb-2 mt-4 break-all text-[10px] text-ink-muted">ID: {panelNode.id}</p>
      </div>

      {/* 底部操作行：左侧剩余参数 chip，右端圆形运行按钮（与 BottomLeftBar 同一运行状态） */}
      <footer className="flex shrink-0 items-center gap-2 border-t border-line p-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {TailChips && <TailChips id={panelNode.id} data={panelNode.data} />}
        </div>
        <button
          type="button"
          disabled={isRunning}
          onClick={() => useRunStore.getState().startAll()}
          title={isRunning ? '运行中…' : '运行'}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-8 bg-mono text-mono-fg shadow-lg shadow-black/30 transition-colors hover:bg-mono-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isRunning ? (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border border-ink-muted border-t-mono-fg" />
          ) : (
            <IconArrowUp className="h-4 w-4" />
          )}
        </button>
      </footer>
    </aside>
  );
}
