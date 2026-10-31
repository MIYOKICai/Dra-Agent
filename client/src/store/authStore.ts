/**
 * 认证状态 store：当前用户 + 双 token（access / refresh）+ 封禁信息。
 * 持久化（zustand persist → localStorage `agent-auth-v1`，桌面端经 safeStorage
 * 镜像进加密保险库）只存 user 与 tokens；status / banInfo 为会话内瞬态——
 * 刷新后由 onRehydrateStorage 依据「tokens 是否还在」恢复 authed 态，
 * 封禁态一律以服务端响应为准，不落盘。
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { safeLocalStorage } from './safeStorage';

/** 公开用户信息（服务端 /api/auth/* 返回的 user 形状） */
export interface AuthUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
}

/** 封禁信息（reason 为服务端给出的原因；until 为 ISO 时间，null = 永久） */
export interface BanInfo {
  reason: string | null;
  until: string | null;
}

export type AuthStatus = 'guest' | 'authed' | 'banned';

/** 登录失效广播事件：gateway 刷新失败清空会话时派发，App 监听后跳登录页 */
export const AUTH_EXPIRED_EVENT = 'dra:auth-expired';
/** 封禁广播事件：gateway 收到 403 banReason 响应时派发 */
export const AUTH_BANNED_EVENT = 'dra:banned';

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  status: AuthStatus;
  banInfo: BanInfo | null;
  /** 登录 / 注册成功 / 静默刷新成功：写入新会话并清掉封禁痕迹 */
  setAuth: (user: AuthUser, accessToken: string, refreshToken: string) => void;
  /** 服务端判定封禁：记录原因与期限，进入 banned 态（tokens 保留供退出登录调用） */
  setBanned: (info: BanInfo) => void;
  /** 退出登录 / 会话失效：清空全部认证数据 */
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      status: 'guest',
      banInfo: null,
      setAuth: (user, accessToken, refreshToken) =>
        set({ user, accessToken, refreshToken, status: 'authed', banInfo: null }),
      setBanned: (info) => set({ status: 'banned', banInfo: info }),
      clear: () =>
        set({
          user: null,
          accessToken: null,
          refreshToken: null,
          status: 'guest',
          banInfo: null,
        }),
    }),
    {
      name: 'agent-auth-v1',
      storage: createJSONStorage(() => safeLocalStorage),
      // 只持久化用户与 token；status / banInfo 是瞬态（封禁以服务端为准，不落盘）
      partialize: (s) => ({
        user: s.user,
        accessToken: s.accessToken,
        refreshToken: s.refreshToken,
      }),
      // 水合后恢复会话态：tokens 还在即视为已登录（封禁态从不持久化）。
      // 注意：persist 的同步水合发生在 create() 内部，此刻 useAuthStore 尚在 TDZ，
      // 直接 setState 会 ReferenceError 且被 zustand 的 catch 静默吞掉——
      // 后果是 hasHydrated 永久 false、status 停留 guest，云同步引导（CloudGate）
      // 全链路不启动。推迟到微任务（模块初始化完成）后再执行。
      onRehydrateStorage: () => (state) => {
        if (state && state.accessToken && state.status === 'guest') {
          queueMicrotask(() => useAuthStore.setState({ status: 'authed' }));
        }
      },
    }
  )
);
