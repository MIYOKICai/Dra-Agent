/**
 * 画布核心 store：React Flow 节点/连线 + 工作流元信息。
 * - 连线校验（自环 / 成环 / input 入边 / output 出边 / 重复连线；允许同一目标多入边汇聚）
 * - 持久化：手动订阅 + 尾沿防抖 → localStorage `agent-canvas-v1`（只存 nodes/edges/name）
 */
import { create } from 'zustand';
import { safeLocalStorage } from './safeStorage';
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type XYPosition,
} from '@xyflow/react';
import type { NodeData, NodeType, WorkflowJSON } from '@shared/types';
import { NODE_DEFS, isNodeType } from '../nodes/registry';
import { useUiStore } from './uiStore';

/** 当前工作流序列化格式版本（导入时校验） */
export const WORKFLOW_VERSION = 1;

export const DEFAULT_WORKFLOW_NAME = '未命名工作流';

/**
 * 共享 NodeData 是 interface，缺少隐式索引签名，
 * 无法直接满足 RF `Node<T extends Record<string, unknown>>` 约束，交叉补一个。
 */
export type CanvasNodeData = NodeData & Record<string, unknown>;
export type CanvasNode = Node<CanvasNodeData>;
export type CanvasEdge = Edge;

const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** addNode 未指定位置时的默认落点（画布中心附近，带少量抖动避免完全重叠） */
const defaultPosition = (): XYPosition => ({
  x: 240 + Math.random() * 80,
  y: 180 + Math.random() * 60,
});

/** 生成"输入节点 1"式自动命名：取同类节点现有编号的最大值 + 1 */
function nextLabel(type: NodeType, nodes: CanvasNode[]): string {
  const base = NODE_DEFS[type].label;
  let max = 0;
  for (const n of nodes) {
    if (n.data.type !== type) continue;
    if (n.data.label === base) {
      max = Math.max(max, 1);
      continue;
    }
    const suffix = n.data.label.startsWith(`${base} `)
      ? Number(n.data.label.slice(base.length + 1))
      : NaN;
    if (Number.isInteger(suffix) && suffix > 0) max = Math.max(max, suffix);
  }
  return `${base} ${max + 1}`;
}

interface CanvasState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  name: string;
  onNodesChange: (changes: NodeChange<CanvasNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  addNode: (type: NodeType, position?: XYPosition) => string;
  /** 模板 / AI 生成装配用：按给定 id / label / config 原样追加节点（不自动命名） */
  addRawNode: (node: CanvasNode) => void;
  /** 模板 / AI 生成装配用：原样追加连线（跳过 onConnect 校验，装配数据已受控） */
  addRawEdge: (edge: CanvasEdge) => void;
  /** 节点入场动画（瞬态不落盘）：生成工作流逐节点添加时登记 id，NodeShell 播入场 + 标题打字机 */
  enteringIds: Record<string, true>;
  beginNodeEnter: (ids: string[]) => void;
  endNodeEnter: (id: string) => void;
  /** 拖入落点缩放过渡（瞬态不落盘）：幽灵卡片按 100% 屏幕尺寸渲染，画布缩放为 z 时
      节点以 1/z 起播缩放动画过渡到实际大小。值为起始 scale，NodeShell 播完摘除 */
  spawnScales: Record<string, number>;
  beginNodeSpawn: (id: string, fromScale: number) => void;
  endNodeSpawn: (id: string) => void;
  updateNodeConfig: (id: string, patch: Record<string, unknown>) => void;
  updateNodeData: (id: string, patch: Partial<NodeData>) => void;
  removeNode: (id: string) => void;
  removeEdge: (id: string) => void;
  /** 运行引擎用：切换单条连线的流动动画 */
  setEdgeAnimated: (edgeId: string, animated: boolean) => void;
  setEdgeBranchSkipped: (edgeId: string, skipped: boolean) => void;
  clearBranchSkipped: () => void;
  /** 运行引擎收尾用：复位全部连线动画 */
  resetEdgeAnimation: () => void;
  clearAll: () => void;
  setName: (name: string) => void;
  /** 多画布切换：整体载入目标画布的节点 / 连线 / 名称（不跑运行、不回写清单） */
  hydrateCanvas: (nodes: CanvasNode[], edges: CanvasEdge[], name: string) => void;
  loadWorkflow: (json: WorkflowJSON) => void;
  exportWorkflow: () => WorkflowJSON;
}

export const useCanvasStore = create<CanvasState>()((set, get) => ({
  nodes: [],
      edges: [],
      name: DEFAULT_WORKFLOW_NAME,
      enteringIds: {},
      spawnScales: {},

      onNodesChange: (changes) => {
        set({ nodes: applyNodeChanges(changes, get().nodes) });
      },

      onEdgesChange: (changes) => {
        set({ edges: applyEdgeChanges(changes, get().edges) });
      },

      onConnect: (connection) => {
        const { source, target, sourceHandle, targetHandle } = connection;
        if (!source || !target) return;
        const { nodes, edges } = get();
        const toast = useUiStore.getState().showToast;
        const reject = (reason: string) => {
          toast(`无法连接：${reason}`);
        };

        // 1. 拒绝自环
        if (source === target) {
          reject('节点不能连接自身');
          return;
        }
        const sourceNode = nodes.find((n) => n.id === source);
        const targetNode = nodes.find((n) => n.id === target);
        if (!sourceNode || !targetNode) return;

        // 2. input 节点不允许有入边；output 节点不允许有出边
        if (targetNode.data.type === 'input') {
          reject('输入节点不允许有入边');
          return;
        }
        if (sourceNode.data.type === 'output') {
          reject('输出节点不允许有出边');
          return;
        }

        // 3. 拒绝成环：沿 source 向上遍历祖先，若 target 可达则新增连线会闭环
        const visited = new Set<string>([source]);
        const stack: string[] = [source];
        while (stack.length > 0) {
          const current = stack.pop()!;
          for (const e of edges) {
            if (e.target !== current || visited.has(e.source)) continue;
            if (e.source === target) {
              reject('连接会形成环，已阻止');
              return;
            }
            visited.add(e.source);
            stack.push(e.source);
          }
        }

        // 4. 允许同一目标句柄存在多条入边（多上游汇聚）；仅拒绝完全相同的重复连线
        const isDuplicate = edges.some(
          (e) =>
            e.source === source &&
            e.target === target &&
            (e.sourceHandle ?? null) === (sourceHandle ?? null) &&
            (e.targetHandle ?? null) === (targetHandle ?? null)
        );
        if (isDuplicate) {
          reject('该连线已存在');
          return;
        }
        const edge: CanvasEdge = {
          id: `e-${source}-${target}-${uid()}`,
          source,
          target,
          sourceHandle,
          targetHandle,
        };
        set({ edges: [...edges, edge] });
      },

      addNode: (type, position) => {
        const { nodes } = get();
        const node: CanvasNode = {
          id: uid(),
          type,
          position: position ?? defaultPosition(),
          data: {
            type,
            label: nextLabel(type, nodes),
            config: {},
            status: 'idle',
          },
        };
        set({ nodes: [...nodes, node] });
        return node.id;
      },

      addRawNode: (node) => {
        set({ nodes: [...get().nodes, node] });
      },

      addRawEdge: (edge) => {
        set({ edges: [...get().edges, edge] });
      },

      beginNodeEnter: (ids) => {
        if (ids.length === 0) return;
        set({
          enteringIds: {
            ...get().enteringIds,
            ...Object.fromEntries(ids.map((id) => [id, true as const])),
          },
        });
      },

      beginNodeSpawn: (id, fromScale) => {
        set({ spawnScales: { ...get().spawnScales, [id]: fromScale } });
      },

      endNodeSpawn: (id) => {
        if (!(id in get().spawnScales)) return;
        const next = { ...get().spawnScales };
        delete next[id];
        set({ spawnScales: next });
      },

      endNodeEnter: (id) => {
        if (!(id in get().enteringIds)) return;
        const next = { ...get().enteringIds };
        delete next[id];
        set({ enteringIds: next });
      },

      updateNodeConfig: (id, patch) => {
        set({
          nodes: get().nodes.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, config: { ...n.data.config, ...patch } } } : n
          ),
        });
      },

      updateNodeData: (id, patch) => {
        set({
          nodes: get().nodes.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, ...patch } } : n
          ),
        });
      },

      removeNode: (id) => {
        set({
          nodes: get().nodes.filter((n) => n.id !== id),
          edges: get().edges.filter((e) => e.source !== id && e.target !== id),
        });
      },

      removeEdge: (id) => {
        set({ edges: get().edges.filter((e) => e.id !== id) });
      },

      setEdgeAnimated: (edgeId, animated) => {
        set({
          edges: get().edges.map((e) => (e.id === edgeId ? { ...e, animated } : e)),
        });
      },

      /** 分支未触发标记：写/清边上的 data.branchSkipped，FlowEdge 据此渲染警戒纹与标签。
       * 标记时沿下游传播：分支边未触发 → 目标节点的全部出边同为未触发，逐级下探；
       * 遇到任一入边未被标记的节点（仍可从其他分支正常收数，如多分支汇入的结果节点）
       * 则停止传播。例：判定 ─✗→ 海报 → 成果（另一分支正常汇入）：海报出边标记，成果停止。 */
      setEdgeBranchSkipped: (edgeId, skipped) => {
        const edges = get().edges;
        if (!skipped) {
          set({
            edges: edges.map((e) => {
              if (e.id !== edgeId) return e;
              const data = { ...(e.data ?? {}) };
              delete data.branchSkipped;
              return { ...e, data };
            }),
          });
          return;
        }
        const seed = edges.find((e) => e.id === edgeId);
        if (!seed) return;
        const marked = new Set<string>([seed.id]);
        const queue: string[] = [seed.target];
        while (queue.length > 0) {
          const nodeId = queue.shift()!;
          if (edges.some((e) => e.target === nodeId && !marked.has(e.id))) continue;
          for (const e of edges) {
            if (e.source === nodeId && !marked.has(e.id)) {
              marked.add(e.id);
              queue.push(e.target);
            }
          }
        }
        set({
          edges: edges.map((e) => {
            if (!marked.has(e.id)) return e;
            const data = { ...(e.data ?? {}) };
            data.branchSkipped = true;
            return { ...e, data };
          }),
        });
      },

      /** 清除全部分支未触发标记（每次运行开始时调用） */
      clearBranchSkipped: () => {
        set({
          edges: get().edges.map((e) =>
            e.data?.branchSkipped
              ? { ...e, data: Object.fromEntries(Object.entries(e.data).filter(([k]) => k !== 'branchSkipped')) }
              : e
          ),
        });
      },

      resetEdgeAnimation: () => {
        set({
          edges: get().edges.map((e) => (e.animated ? { ...e, animated: false } : e)),
        });
      },

      clearAll: () => {
        set({ nodes: [], edges: [], name: DEFAULT_WORKFLOW_NAME });
      },

      setName: (name) => set({ name }),

      hydrateCanvas: (nodes, edges, name) => set({ nodes, edges, name }),

      loadWorkflow: (json) => {
        set({
          name: json.name || DEFAULT_WORKFLOW_NAME,
          nodes: json.nodes.map((n) => ({
            id: n.id,
            type: n.type,
            position: n.position,
            data: n.data as CanvasNodeData,
          })),
          edges: json.edges.map((e) => ({
            id: e.id,
            source: e.source,
            target: e.target,
            sourceHandle: e.sourceHandle,
            targetHandle: null,
          })),
        });
      },

      exportWorkflow: () => {
        const { nodes, edges, name } = get();
        return {
          version: WORKFLOW_VERSION,
          name,
          nodes: nodes.map((n) => ({
            id: n.id,
            type: n.data.type,
            position: { x: n.position.x, y: n.position.y },
            data: n.data,
          })),
          edges: edges.map((e) => ({
            id: e.id,
            source: e.source,
            target: e.target,
            sourceHandle: e.sourceHandle ?? undefined,
          })),
        };
      },
    })
);
/* =============== 持久化：手动订阅 + 尾沿防抖 ===============
 * 为什么不用 zustand persist：persist 在每次 set 时同步 JSON.stringify 整个
 * partialize 结果——多选拖拽逐帧派发 position 变更，含图片 dataURL 的大画布
 * 每帧序列化数十 ms，是「拖拽一卡一卡、连线跟不上节点」的主根因。
 * 改为订阅式尾沿防抖：连续 set 期间零序列化零写盘，停顿 300ms 才落盘一次；
 * beforeunload / 页面隐藏时立即 flush 防丢尾差。数据格式与旧 persist 兼容。 */
const CANVAS_STORAGE_KEY = 'agent-canvas-v1';

/** 立即序列化当前画布并写盘（剥离运行产物防配额爆炸） */
function writeCanvasSnapshot(): void {
  try {
    const s = useCanvasStore.getState();
    const payload = JSON.stringify({
      state: { nodes: stripRunState(s.nodes), edges: s.edges, name: s.name },
      version: 0,
    });
    safeLocalStorage.setItem(CANVAS_STORAGE_KEY, payload);
  } catch {
    // 配额超限 / 序列化失败：静默（下次停顿再试）
  }
}

let saveTimer: number | null = null;

/** 尾沿防抖落盘（300ms 停顿阈值） */
function scheduleCanvasSave(): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    writeCanvasSnapshot();
  }, 300);
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
      writeCanvasSnapshot();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
      writeCanvasSnapshot();
    }
  });
}

/** 启动时恢复上次画布（兼容旧 persist 数据格式 { state: {...}, version: 0 }，坏数据静默回退空画布） */
function hydrateCanvas(): void {
  try {
    const raw = safeLocalStorage.getItem(CANVAS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      state?: { nodes?: unknown; edges?: unknown; name?: unknown };
      nodes?: unknown;
      edges?: unknown;
      name?: unknown;
    };
    const snap = parsed.state ?? parsed;
    if (!Array.isArray(snap.nodes) || !Array.isArray(snap.edges)) return;
    useCanvasStore.setState({
      nodes: (snap.nodes as CanvasNode[]).filter(
        (n) => Boolean(n) && typeof n.id === 'string' && isNodeType(n.type) && Boolean(n.data)
      ),
      edges: (snap.edges as CanvasEdge[]).filter(
        (e) =>
          Boolean(e) &&
          typeof e.id === 'string' &&
          typeof e.source === 'string' &&
          typeof e.target === 'string'
      ),
      name: typeof snap.name === 'string' && snap.name ? snap.name : DEFAULT_WORKFLOW_NAME,
    });
  } catch {
    // 数据损坏：忽略，保持默认空画布
  }
}

hydrateCanvas();
useCanvasStore.subscribe(scheduleCanvasSave);

/**
 * 持久化瘦身：剥离节点运行产物（output 可能包含图片 dataURL / 长 Agent 步骤记录，
 * 会把 localStorage ~5MB 配额瞬间撑爆并触发 QuotaExceededError 崩溃）。
 * 画布结构（节点 / 配置 / 连线 / 名称）完整保留；运行状态重置为 idle，刷新后重跑即可。
 */
export function stripRunState(nodes: CanvasNode[]): CanvasNode[] {
  return nodes.map((n) => {
    const clean: CanvasNodeData = { ...n.data, status: 'idle' };
    delete clean.output;
    delete clean.error;
    return { ...n, data: clean };
  });
}

/** 导入 JSON 的结构校验；返回错误说明，合法返回 null */
export function validateWorkflowJSON(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return '内容不是合法的 JSON 对象';
  const json = value as Record<string, unknown>;
  if (typeof json.version !== 'number') return '缺少 version 字段';
  if (json.version !== WORKFLOW_VERSION) return `暂不支持 version=${json.version}（当前支持 ${WORKFLOW_VERSION}）`;
  if (typeof json.name !== 'string') return 'name 需为字符串';
  if (!Array.isArray(json.nodes) || !Array.isArray(json.edges)) return 'nodes / edges 需为数组';
  const nodeIds = new Set<string>();
  for (const item of json.nodes) {
    const n = item as Record<string, unknown>;
    if (typeof n.id !== 'string' || n.id === '') return '存在缺少 id 的节点';
    if (nodeIds.has(n.id)) return `节点 id 重复：${n.id}`;
    nodeIds.add(n.id);
    if (!isNodeType(n.type)) return `节点 ${n.id} 的 type 非法`;
    const pos = n.position as Record<string, unknown> | undefined;
    if (
      !pos ||
      typeof pos.x !== 'number' ||
      typeof pos.y !== 'number' ||
      typeof n.data !== 'object' ||
      n.data === null
    ) {
      return `节点 ${n.id} 缺少合法的 position / data`;
    }
  }
  for (const item of json.edges) {
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || typeof e.source !== 'string' || typeof e.target !== 'string') {
      return '存在缺少 id / source / target 的连线';
    }
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) {
      return `连线 ${e.id} 引用了不存在的节点`;
    }
  }
  return null;
}
