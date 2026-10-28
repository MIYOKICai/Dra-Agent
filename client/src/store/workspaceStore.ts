/**
 * 多画布工作区：画布清单 + 当前画布 id。
 * - 当前画布内容仍由 canvasStore 持有（节点 / 连线 / 名称），切换前先把当前内容
 *   回写清单条目，再把目标条目整体载入 canvasStore，避免两份内容互相覆盖。
 * - 持久化：localStorage `agent-workspace-v1`（全部画布内容 + activeId）；
 *   canvasStore 的 `agent-canvas-v1` 始终保存"当前画布"，刷新后无需重载。
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  stripRunState,
  useCanvasStore,
  type CanvasEdge,
  type CanvasNode,
} from './canvasStore';
import { safeLocalStorage } from './safeStorage';
import { useRunStore } from './runStore';

export interface CanvasEntry {
  id: string;
  name: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** 最近一次切换离开 / 创建的时间戳（ms） */
  updatedAt: number;
}

const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 新建画布的默认名称基数（与画布页的「未命名工作流」区分） */
const NEW_CANVAS_NAME = '未命名画布';

interface WorkspaceState {
  canvases: CanvasEntry[];
  activeId: string;
  /** 首次进入（无持久化清单）时用当前画布初始化清单；activeId 失效时修复指向 */
  ensureInit: () => void;
  /** 新建空白画布并切过去，返回新画布 id */
  createCanvas: () => string;
  /** 切换画布：先回写当前内容，再载入目标内容 */
  switchCanvas: (id: string) => void;
  /** 重命名画布条目；当前画布同步 canvasStore.name（侧边栏活动行 / 顶栏实时显示） */
  renameCanvas: (id: string, name: string) => void;
  /** 删除画布条目；删除当前画布时取消运行并切换到相邻画布（无相邻则新建空白） */
  deleteCanvas: (id: string) => void;
}

/** 当前画布快照（切换前回写到清单，避免未保存的画布内容丢失） */
function snapshot() {
  const { nodes, edges, name } = useCanvasStore.getState();
  return { nodes, edges, name };
}

/** 生成不重名的「未命名画布 N」 */
function nextCanvasName(canvases: CanvasEntry[]): string {
  const used = new Set(canvases.map((c) => c.name));
  if (!used.has(NEW_CANVAS_NAME)) return NEW_CANVAS_NAME;
  let index = 2;
  while (used.has(`${NEW_CANVAS_NAME} ${index}`)) index += 1;
  return `${NEW_CANVAS_NAME} ${index}`;
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      canvases: [],
      activeId: '',

      ensureInit: () => {
        const { canvases, activeId } = get();
        if (canvases.length === 0) {
          const { nodes, edges, name } = snapshot();
          const id = uid();
          set({
            canvases: [{ id, name, nodes, edges, updatedAt: Date.now() }],
            activeId: id,
          });
          return;
        }
        if (canvases.some((c) => c.id === activeId)) return;
        // activeId 失效（清单被手工改动等）：指向第一条并载入其内容
        const first = canvases[0];
        set({ activeId: first.id });
        useCanvasStore.getState().hydrateCanvas(first.nodes, first.edges, first.name);
      },

      createCanvas: () => {
        const { canvases, activeId } = get();
        // 放弃运行中的任务，避免执行结果写入新画布
        useRunStore.getState().cancelRun();
        const now = Date.now();
        const { nodes, edges, name } = snapshot();
        const flushed = canvases.map((c) =>
          c.id === activeId ? { ...c, nodes, edges, name, updatedAt: now } : c
        );
        const entry: CanvasEntry = {
          id: uid(),
          name: nextCanvasName(flushed),
          nodes: [],
          edges: [],
          updatedAt: now,
        };
        set({ canvases: [...flushed, entry], activeId: entry.id });
        useCanvasStore.getState().hydrateCanvas([], [], entry.name);
        return entry.id;
      },

      switchCanvas: (id) => {
        const { canvases, activeId } = get();
        if (id === activeId) return;
        const target = canvases.find((c) => c.id === id);
        if (!target) return;
        useRunStore.getState().cancelRun();
        const now = Date.now();
        const { nodes, edges, name } = snapshot();
        set({
          canvases: canvases.map((c) =>
            c.id === activeId ? { ...c, nodes, edges, name, updatedAt: now } : c
          ),
          activeId: id,
        });
        useCanvasStore.getState().hydrateCanvas(target.nodes, target.edges, target.name);
      },

      renameCanvas: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const { canvases, activeId } = get();
        set({
          canvases: canvases.map((c) =>
            c.id === id ? { ...c, name: trimmed, updatedAt: Date.now() } : c
          ),
        });
        // 重命名的是当前画布：canvasStore.name 同步（顶栏 / 侧边栏活动行实时显示）
        if (id === activeId) useCanvasStore.getState().setName(trimmed);
      },

      deleteCanvas: (id) => {
        const { canvases, activeId } = get();
        const rest = canvases.filter((c) => c.id !== id);
        if (rest.length === canvases.length) return; // 条目不存在
        if (id !== activeId) {
          set({ canvases: rest });
          return;
        }
        // 删除当前画布：放弃运行中任务 → 切到相邻画布；全部删光则新建空白画布
        useRunStore.getState().cancelRun();
        if (rest.length === 0) {
          const entry: CanvasEntry = {
            id: uid(),
            name: NEW_CANVAS_NAME,
            nodes: [],
            edges: [],
            updatedAt: Date.now(),
          };
          set({ canvases: [entry], activeId: entry.id });
          useCanvasStore.getState().hydrateCanvas([], [], entry.name);
          return;
        }
        const next = rest[0];
        set({ canvases: rest, activeId: next.id });
        useCanvasStore.getState().hydrateCanvas(next.nodes, next.edges, next.name);
      },
    }),
    {
      name: 'agent-workspace-v1',
      storage: createJSONStorage(() => safeLocalStorage),
      // 清单里的画布快照同样剥离运行产物（output 含图片 dataURL 会撑爆 ~5MB 配额）
      partialize: (s) => ({
        canvases: s.canvases.map((c) => ({ ...c, nodes: stripRunState(c.nodes) })),
        activeId: s.activeId,
      }),
    }
  )
);
