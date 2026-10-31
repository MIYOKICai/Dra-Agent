import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { CanvasPage } from './pages/CanvasPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { Landing } from './pages/Landing';
import { LoginPage } from './pages/LoginPage';
import { SettingsPage } from './pages/SettingsPage';
import { TemplatesPage } from './pages/TemplatesPage';
import { TemplateExpandOverlay } from './components/templates/TemplateExpandOverlay';
import { TitleBar } from './components/TitleBar';
import { ConfirmHost } from './components/ui/Modal';
import { Button } from './components/ui/Button';
import { IconShield } from './components/icons';
import { ImportWizard, IMPORT_DONE_KEY } from './components/ImportWizard';
import { ReportDialogHost } from './components/ReportDialog';
import { useUiStore } from './store/uiStore';
import { AUTH_EXPIRED_EVENT, useAuthStore } from './store/authStore';
import { logout } from './api/auth';
import { bootstrapCloudData, resetCloudSync } from './lib/cloudBootstrap';
import { useWorkspaceStore } from './store/workspaceStore';
import { useCreationSessions } from './lib/creationSessions';
import { useSettingsStore } from './store/settingsStore';
import { safeLocalStorage } from './store/safeStorage';

/**
 * 全局主题同步：订阅 uiStore 的 theme，统一把昼夜状态写到 <html>（暗色无类 /
 * 亮色挂 light）。挂在路由之上，跨页面切换始终生效——各页面不再自行同步，
 * 避免页面卸载时误清主题类（如落地页 → 模板中心后主题回退）。
 */
function ThemeSync() {
  const theme = useUiStore((s) => s.theme);
  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
  }, [theme]);
  return null;
}

/** 路由守卫：未登录（无 status=authed 且无 token）重定向登录页并携带 from 原视图 */
function RequireAuth({ children }: { children: ReactElement }) {
  const status = useAuthStore((s) => s.status);
  const hasToken = useAuthStore((s) => Boolean(s.accessToken));
  const location = useLocation();
  if (status === 'banned') {
    // 封禁态：页面不渲染，由全屏封禁页（BanScreen）接管
    return null;
  }
  if (status !== 'authed' && !hasToken) {
    const from = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?from=${from}`} replace />;
  }
  return children;
}

/**
 * 全屏封禁页：status=banned 时覆盖全部路由，应用不可操作，仅提供退出登录。
 * 视觉走登录页同款居中卡片 + 红色警示（原因 + 解封期限）。
 */
function BanScreen() {
  const status = useAuthStore((s) => s.status);
  const banInfo = useAuthStore((s) => s.banInfo);
  const navigate = useNavigate();
  if (status !== 'banned') return null;
  const handleLogout = (): void => {
    const { refreshToken, clear } = useAuthStore.getState();
    if (refreshToken) void logout(refreshToken); // 尽力吊销服务端会话，失败不阻塞本地清空
    clear();
    navigate('/login', { replace: true });
  };
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center overflow-hidden bg-base px-5 text-ink">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-24 left-1/2 h-60 w-[80%] -translate-x-1/2 rounded-full opacity-60 blur-3xl"
        style={{ backgroundImage: 'radial-gradient(closest-side, var(--wash-strong), transparent)' }}
      />
      <div className="relative w-full max-w-sm rounded-[24px] border border-line bg-panel p-7">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-red-500/40 bg-red-500/10 text-red-500">
            <IconShield className="h-5 w-5" />
          </span>
          <h1 className="text-lg font-semibold tracking-tight text-red-500">账号已被封禁</h1>
        </div>
        <div className="mt-4 space-y-1.5 text-[13px] leading-relaxed text-ink-muted">
          {banInfo?.reason && (
            <p>
              <span className="text-ink">封禁原因：</span>
              {banInfo.reason}
            </p>
          )}
          <p>
            <span className="text-ink">解封时间：</span>
            {banInfo?.until ? new Date(banInfo.until).toLocaleString() : '永久封禁'}
          </p>
          <p>封禁期间应用不可操作，如有疑问请联系管理员。</p>
        </div>
        <Button variant="mono" size="lg" className="mt-6 w-full" onClick={handleLogout}>
          退出登录
        </Button>
      </div>
    </div>
  );
}

/** 全局认证事件：会话静默刷新失败（token 全失效）→ toast 提示并跳登录页 */
function AuthExpiredRedirect() {
  const navigate = useNavigate();
  const showToast = useUiStore((s) => s.showToast);
  const location = useLocation();
  useEffect(() => {
    const onExpired = (): void => {
      showToast('登录状态已失效，请重新登录');
      navigate(`/login?from=${encodeURIComponent(location.pathname + location.search)}`, {
        replace: true,
      });
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, [navigate, showToast, location.pathname, location.search]);
  return null;
}

/**
 * 云数据引导 + 首次登录导入向导（全局唯一实例，仅 authed 态动作）：
 * - 登录后：localStorage 标记 'agent-import-done' 不存在且本地有存量
 *   （画布 / 创作会话 / 服务商配置）→ 弹 ImportWizard；确认 / 跳过后写标记并
 *   启动云端同步（画布列表合并、会话拉取、用户设置加载）
 * - 无存量：直接写标记并启动同步
 * - 登出（guest）：重置各同步层启动标记，换账号可重新拉取
 */
function CloudGate() {
  const status = useAuthStore((s) => s.status);
  const [wizardOpen, setWizardOpen] = useState(false);
  const bootRef = useRef(false);

  useEffect(() => {
    if (status === 'guest') {
      bootRef.current = false;
      setWizardOpen(false);
      resetCloudSync();
      return;
    }
    if (status !== 'authed' || bootRef.current) return;
    bootRef.current = true;
    const hasLocal =
      useWorkspaceStore.getState().canvases.length > 0 ||
      useCreationSessions.getState().sessions.length > 0 ||
      useSettingsStore.getState().providers.length > 0;
    if (!safeLocalStorage.getItem(IMPORT_DONE_KEY)) {
      if (hasLocal) {
        setWizardOpen(true); // 向导完成 / 跳过后再启动同步
        return;
      }
      try {
        safeLocalStorage.setItem(IMPORT_DONE_KEY, '1');
      } catch {
        // 存储不可用：bootRef 保证本次会话不再弹
      }
    }
    void bootstrapCloudData();
  }, [status]);

  return (
    <>
      <ImportWizard
        open={wizardOpen}
        onComplete={() => {
          setWizardOpen(false);
          void bootstrapCloudData();
        }}
      />
    </>
  );
}

function App() {
  return (
    <BrowserRouter>
      <ThemeSync />
      {/* 无边框窗口自绘标题栏（仅 Electron 环境渲染，悬浮右上角） */}
      <TitleBar />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <Landing />
            </RequireAuth>
          }
        />
        <Route
          path="/canvas"
          element={
            <RequireAuth>
              <CanvasPage />
            </RequireAuth>
          }
        />
        {/* /chat = 一键创作「生成」对话面板（与 /canvas 共用画布页承载，面板 z-40 实色覆盖） */}
        <Route
          path="/chat"
          element={
            <RequireAuth>
              <CanvasPage />
            </RequireAuth>
          }
        />
        <Route
          path="/templates"
          element={
            <RequireAuth>
              <TemplatesPage />
            </RequireAuth>
          }
        />
        <Route
          path="/knowledge"
          element={
            <RequireAuth>
              <KnowledgePage />
            </RequireAuth>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireAuth>
              <SettingsPage />
            </RequireAuth>
          }
        />
      </Routes>
      {/* 模板展开过渡层：挂在路由之上跨页不卸载，导航发生在其背后（消除跳转闪帧） */}
      <TemplateExpandOverlay />
      {/* 全局确认弹窗宿主：替代原生 window.confirm（所有页面共用） */}
      <ConfirmHost />
      {/* 全局举报弹窗宿主：uiStore.reportTarget 驱动（消息 / 画布 / 文档入口共用） */}
      <ReportDialogHost />
      {/* 云数据引导 + 首次登录导入向导：仅 authed 态动作 */}
      <CloudGate />
      {/* 全屏封禁页：覆盖全部 UI，仅可退出登录 */}
      <BanScreen />
      {/* 会话失效广播：跳登录页并 toast 提示 */}
      <AuthExpiredRedirect />
    </BrowserRouter>
  );
}

export default App;
