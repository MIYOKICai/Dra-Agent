/**
 * 知识库 store：KB 列表（含模式徽标与文档列表）与管理面板开关。
 * CanvasPage 挂载时拉取一次；KBPanel 与 RetrievalConfig（检索节点下拉）共享数据源。
 * 不持久化：知识库数据持久化在 server 端 JSON 文件，每次启动重新拉取。
 */
import { create } from 'zustand';
import type { KBInfoEx } from '@shared/types';
import { listKBs } from '../api/gateway';

interface KBState {
  kbs: KBInfoEx[];
  loading: boolean;
  error: string | null;
  /** 知识库管理面板开关（Toolbar「📚 知识库」按钮与 KBPanel 共用） */
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  refetch: () => Promise<void>;
}

export const useKBStore = create<KBState>((set, get) => ({
  kbs: [],
  loading: false,
  error: null,
  panelOpen: false,
  setPanelOpen: (open) => set({ panelOpen: open }),
  refetch: async () => {
    if (get().loading) return; // 防止并发重复请求
    set({ loading: true, error: null });
    try {
      const kbs = await listKBs();
      set({ kbs, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
