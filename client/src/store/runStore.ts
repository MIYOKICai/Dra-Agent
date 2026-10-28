/**
 * 运行状态 store：全局运行标志、AbortController、运行序号与单节点重跑模式。
 * 节点状态/产物不在此存储——执行器直接写 canvasStore.updateNodeData。
 * 不持久化（会话级瞬态状态）。
 */
import { create } from 'zustand';
import { runWorkflow } from '../engine/executor';
import { useCanvasStore } from './canvasStore';

interface RunState {
  /** 是否有运行中的工作流（含单节点重跑） */
  isRunning: boolean;
  /** 运行会话序号，每次 startRun 递增 */
  runSeq: number;
  /** 当前运行的取消控制器；空闲时为 null */
  abortController: AbortController | null;
  /** 单节点重跑模式的目标节点 id；全量运行时为 null */
  rerunNodeId: string | null;
  /** 全量运行：校验/初始化由执行器负责；已在运行中则忽略 */
  startAll: () => void;
  /** 从指定节点运行/重跑：该节点及其下游执行，上游复用已有产物 */
  rerunFrom: (nodeId: string) => void;
  /** 取消当前运行（立即 abort；节点状态由执行器收尾清理） */
  cancelRun: () => void;
  /** 运行结束复位（由执行器 finally 调用） */
  finishRun: () => void;
}

export const useRunStore = create<RunState>((set, get) => {
  /** 占用运行会话；已运行时返回 null，否则返回本次的 AbortSignal */
  const beginRun = (mode: 'all' | 'from', fromNodeId?: string): AbortSignal | null => {
    if (get().isRunning) return null;
    const controller = new AbortController();
    set({
      isRunning: true,
      abortController: controller,
      runSeq: get().runSeq + 1,
      rerunNodeId: mode === 'from' ? (fromNodeId ?? null) : null,
    });
    return controller.signal;
  };

  const launch = (mode: 'all' | 'from', fromNodeId?: string): void => {
    const signal = beginRun(mode, fromNodeId);
    if (!signal) return; // 已有运行在进行
    const { nodes, edges } = useCanvasStore.getState();
    void runWorkflow(nodes, edges, { mode, fromNodeId, signal }).finally(() => get().finishRun());
  };

  return {
    isRunning: false,
    runSeq: 0,
    abortController: null,
    rerunNodeId: null,

    startAll: () => launch('all'),

    rerunFrom: (nodeId) => launch('from', nodeId),

    cancelRun: () => {
      get().abortController?.abort();
    },

    finishRun: () => set({ isRunning: false, abortController: null, rerunNodeId: null }),
  };
});
