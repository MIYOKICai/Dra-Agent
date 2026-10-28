/**
 * 全局 UI 状态：轻提示（toast）+ 黑白主题。
 * theme 为唯一持久化项（zustand persist → localStorage `agent-ui-v1`）；
 * toast 等 transient 状态不落盘。主题类由 CanvasPage 同步到
 * document.documentElement（暗色无类 / 亮色挂 light），落地页保持暗色不受影响。
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { safeLocalStorage } from './safeStorage';
import type { ComposerMode } from '../lib/composeWorkflow';

export type ThemeMode = 'dark' | 'light';

export interface ToastItem {
  /** 用于让 Toast 组件识别"新的一条"并重置 2s 计时 */
  id: number;
  message: string;
}

/** 确认弹窗选项（由 ConfirmHost 渲染为全局统一弹窗） */
export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 危险操作（删除 / 清空 / 放弃更改）：确认钮文案默认「删除」 */
  danger?: boolean;
}

/** 进行中的确认请求：携带 resolve 用于结算 showConfirm 的 Promise */
interface ConfirmRequest extends ConfirmOptions {
  resolve: (v: boolean) => void;
}

interface UiState {
  toast: ToastItem | null;
  showToast: (message: string) => void;
  clearToast: () => void;
  /** 全局确认弹窗：await showConfirm({...}) → Promise<boolean>（Esc / 遮罩 / 取消 = false） */
  confirm: ConfirmRequest | null;
  showConfirm: (opts: ConfirmOptions) => Promise<boolean>;
  settleConfirm: (v: boolean) => void;
  /** 左侧画布侧边栏（贴左缘抽屉）开关 */
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  /** 侧边栏折叠为图标栏（宽度保留 64px，仅显示图标）；持久化 */
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  /** 侧边栏分组展开态（'canvas' | 'session' | null，单开互斥）。
   *  放全局 store：切换页面时 ProjectSidebar 会重挂载，本地 state 无法跨页面保持 */
  expandedGroup: 'canvas' | 'session' | null;
  setExpandedGroup: (v: 'canvas' | 'session' | null) => void;
  /** 一键创作面板开关（覆盖画布主区，不持久化） */
  creationOpen: boolean;
  setCreationOpen: (open: boolean) => void;
  /** 创作面板当前打开的对话会话 id（null = 新对话）；侧边栏「创作对话」与面板间的交接句柄 */
  activeCreationSessionId: string | null;
  setActiveCreationSessionId: (id: string | null) => void;
  /** 正在流式生成中的创作会话 id：侧边栏对应行显示环形加载动画，完成后切回对勾 */
  generatingSessionId: string | null;
  setGeneratingSessionId: (id: string | null) => void;
  /** 创作面板模式：generate=生成（对话，路由 /chat）/ compose=画布（编排工作流，路由 /canvas）；与路由联动 */
  composerMode: ComposerMode;
  setComposerMode: (mode: ComposerMode) => void;
  /** 黑白主题：dark=黑底白字（默认），light=白纸黑字（html.light 反转变量） */
  theme: ThemeMode;
  toggleTheme: () => void;
  /** 画布交互模式：drag=拖动（左键拖拽平移画布，默认）/ select=选择（左键拖拽框选节点） */
  canvasMode: 'drag' | 'select';
  setCanvasMode: (mode: 'drag' | 'select') => void;
  /** 一键创作后台编排状态：null=未在生成；字符串=画布顶部指示条展示的当前阶段文本
   *  （「正在理解…」→「正在编排…」，流式返回时更新；装配开始前置回 null 隐藏） */
  composing: string | null;
  setComposing: (v: string | null) => void;
  /** 一键创作全程锁：发送起（含流式 + 装配动画）到结束为 true——画布遮罩锁定依据。
      与 composing（仅流式阶段显示文本）分离：装配期间提示条消失但锁保持 */
  composingBusy: boolean;
  /** 全程锁对应的画布 id：遮罩只盖目标画布，编排中切到其他画布不受影响 */
  composingCanvasId: string | null;
  setComposingBusy: (busy: boolean, canvasId?: string | null) => void;
}

let toastSeq = 0;

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      toast: null,
      showToast: (message) => {
        toastSeq += 1;
        set({ toast: { id: toastSeq, message } });
      },
      clearToast: () => set({ toast: null }),
      confirm: null,
      showConfirm: (opts) =>
        new Promise((resolve) => {
          // 防御：已有未结算弹窗时先按取消结算（正常流程不会并发）
          get().confirm?.resolve(false);
          set({ confirm: { ...opts, resolve } });
        }),
      settleConfirm: (v) => {
        const current = get().confirm;
        if (!current) return;
        set({ confirm: null });
        current.resolve(v);
      },
      sidebarOpen: false,
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
      sidebarCollapsed: false,
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
      expandedGroup: 'canvas',
      setExpandedGroup: (v) => set({ expandedGroup: v }),
      creationOpen: false,
      setCreationOpen: (open) => set({ creationOpen: open }),
      activeCreationSessionId: null,
      setActiveCreationSessionId: (id) => set({ activeCreationSessionId: id }),
      generatingSessionId: null,
      setGeneratingSessionId: (id) => set({ generatingSessionId: id }),
      composerMode: 'generate',
      setComposerMode: (mode) => set({ composerMode: mode }),
      theme: 'dark',
      toggleTheme: () => set({ theme: get().theme === 'dark' ? 'light' : 'dark' }),
      canvasMode: 'drag',
      setCanvasMode: (mode) => set({ canvasMode: mode }),
      composing: null,
      setComposing: (v) => set({ composing: v }),
      composingBusy: false,
      composingCanvasId: null,
      setComposingBusy: (busy, canvasId) =>
        set({ composingBusy: busy, composingCanvasId: busy ? (canvasId ?? null) : null }),
    }),
    {
      name: 'agent-ui-v1',
      storage: createJSONStorage(() => safeLocalStorage),
      // 只持久化主题，不存函数与瞬态 UI 状态
      partialize: (s) => ({
        theme: s.theme,
        sidebarOpen: s.sidebarOpen,
        sidebarCollapsed: s.sidebarCollapsed,
      }),
    }
  )
);
