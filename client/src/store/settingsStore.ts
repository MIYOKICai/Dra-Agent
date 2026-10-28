/**
 * 全局设置 store：网关模型清单（providers / models）。
 * CanvasPage 挂载时拉取一次；LLM / 图像 / Agent 节点的模型下拉从这里取数。
 * 不持久化（每次启动重新拉取，保证可用性信息新鲜）。
 */
import { create } from 'zustand';
import type { ProviderInfo } from '@shared/types';
import { fetchModels } from '../api/gateway';

interface SettingsState {
  providers: ProviderInfo[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  providers: [],
  loading: false,
  error: null,
  refetch: async () => {
    if (get().loading) return; // 防止并发重复请求
    set({ loading: true, error: null });
    try {
      const data = await fetchModels();
      set({ providers: data.providers, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
