/**
 * 全局设置 store：网关模型清单（providers / models）+ 用户个性化设置。
 * - 模型清单：CanvasPage 挂载时拉取一次；LLM / 图像 / Agent 节点的模型下拉从
 *   这里取数。不持久化（每次启动重新拉取，保证可用性信息新鲜）。
 * - 用户设置：GET/PUT /api/user-settings（apiKey 打码回传不覆盖语义由服务端
 *   处理，客户端原样传回）；zustand persist `agent-user-settings-v1` 仅作为
 *   离线缓存（API 读取失败时保留缓存值）。
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ProviderInfo } from '@shared/types';
import { fetchModels } from '../api/gateway';
import { fetchUserSettings, saveUserSettings } from '../api/cloud';
import { safeLocalStorage } from './safeStorage';

interface SettingsState {
  providers: ProviderInfo[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  /** 用户个性化设置（/api/user-settings 的 data；null = 尚未加载） */
  userSettings: Record<string, unknown> | null;
  userSettingsLoading: boolean;
  /** 登录后拉取用户设置（persist 缓存为兜底：API 失败保留缓存值） */
  loadUserSettings: () => Promise<void>;
  /** 覆盖保存用户设置（apiKey 打码值原样传回，服务端保留原密文） */
  updateUserSettings: (data: Record<string, unknown>) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
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

      userSettings: null,
      userSettingsLoading: false,
      loadUserSettings: async () => {
        if (get().userSettingsLoading) return;
        set({ userSettingsLoading: true });
        try {
          const data = await fetchUserSettings();
          set({ userSettings: data, userSettingsLoading: false });
        } catch (err) {
          // 失败保留缓存（persist 水合值），下次登录周期重试
          console.warn('[settings] 用户设置读取失败，使用本地缓存', err);
          set({ userSettingsLoading: false });
        }
      },
      updateUserSettings: async (data) => {
        const saved = await saveUserSettings(data);
        set({ userSettings: saved });
      },
    }),
    {
      name: 'agent-user-settings-v1',
      storage: createJSONStorage(() => safeLocalStorage),
      // 只缓存用户设置数据；模型清单每次启动重新拉取
      partialize: (s) => ({ userSettings: s.userSettings }),
    }
  )
);
