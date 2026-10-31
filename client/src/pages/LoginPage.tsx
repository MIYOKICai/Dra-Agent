/**
 * 登录页（/login）：登录 / 注册双 Tab 表单，居中卡片布局。
 * 视觉与落地页同语言：单色系令牌、描边分层、零阴影、mono 主按钮。
 * - 错误统一展示在 error 字段（服务端 400/401/409/429 文案透传）；
 * - 403 封禁展示专属红色警示卡（封禁原因 + 解封期限，永久封禁无期限）；
 * - 成功后跳转 ?from= 指定的原视图（缺省回首页）。
 */
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthError, login, register } from '../api/auth';
import { useAuthStore } from '../store/authStore';
import { IconShield, IconSparkles } from '../components/icons';

/** 服务端封禁信息（banInfo 摘出的形状） */
interface BanInfo {
  reason: string | null;
  until: string | null;
}

type Mode = 'login' | 'register';

const FIELD =
  'h-10 w-full rounded-lg border border-line bg-base px-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-ink-muted';

const LABEL = 'mb-1.5 block text-xs font-medium text-ink-muted';

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const status = useAuthStore((s) => s.status);
  const setAuth = useAuthStore((s) => s.setAuth);

  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ban, setBan] = useState<BanInfo | null>(null);
  const [busy, setBusy] = useState(false);

  // from 仅接受站内路径（防开放重定向），缺省回首页
  const rawFrom = searchParams.get('from') ?? '/';
  const from = rawFrom.startsWith('/') && !rawFrom.startsWith('//') ? rawFrom : '/';

  // 已登录状态直接回原视图（封禁态由 App 的全屏封禁页接管）
  if (status === 'authed') return <Navigate to={from} replace />;

  const switchMode = (next: Mode): void => {
    setMode(next);
    setError(null);
    setBan(null);
  };

  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBan(null);
    if (mode === 'register' && password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    try {
      const data =
        mode === 'login' ? await login(email.trim(), password) : await register(email.trim(), password);
      setAuth(data.user, data.accessToken, data.refreshToken);
      navigate(from, { replace: true });
    } catch (err) {
      const info = err instanceof AuthError ? err.banInfo : null;
      if (info) {
        setBan(info); // 封禁走专属红色警示卡，不再重复展示通用错误行
      } else {
        setError(err instanceof Error ? err.message : '请求失败，请稍后重试');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-base px-5 py-12 text-ink [.has-titlebar_&]:pt-[72px]">
      {/* 顶部柔光（与落地页 hero 同款径向光斑） */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-24 left-1/2 h-60 w-[80%] -translate-x-1/2 rounded-full opacity-60 blur-3xl"
        style={{ backgroundImage: 'radial-gradient(closest-side, var(--wash-strong), transparent)' }}
      />

      <div className="relative w-full max-w-sm">
        {/* 品牌行 */}
        <div className="mb-6 flex items-center justify-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-mono text-mono-fg">
            <IconSparkles className="h-4 w-4" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">Dra-Agent</span>
        </div>

        <div className="rounded-[24px] border border-line bg-panel p-7">
          <h1 className="text-xl font-semibold tracking-tight">
            {mode === 'login' ? '欢迎回来' : '创建账号'}
          </h1>
          <p className="mt-1.5 text-[13px] text-ink-muted">
            {mode === 'login' ? '登录以继续使用画布工作台' : '注册即开始编排你的第一条工作流'}
          </p>

          {/* 双 Tab 分段切换（激活态 = mono 墨色药丸） */}
          <div className="mt-5 grid grid-cols-2 gap-1 rounded-full border border-line bg-base p-1" role="tablist">
            {(
              [
                ['login', '登录'],
                ['register', '注册'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                onClick={() => switchMode(value)}
                className={`flex h-8 items-center justify-center rounded-full text-[13px] transition-colors ${
                  mode === value ? 'bg-mono font-medium text-mono-fg' : 'text-ink-muted hover:text-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* 封禁警示卡：红色专属样式（原因 + 期限） */}
          {ban && (
            <div className="mt-4 flex gap-3 rounded-xl border border-red-500/40 bg-red-500/10 p-3.5" role="alert">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-red-500/40 text-red-500">
                <IconShield className="h-4 w-4" />
              </span>
              <div className="min-w-0 text-xs leading-relaxed">
                <p className="font-medium text-red-500">账号已被封禁</p>
                {ban.reason && <p className="mt-1 text-red-500/80">封禁原因：{ban.reason}</p>}
                <p className="mt-1 text-red-500/80">
                  解封时间：{ban.until ? new Date(ban.until).toLocaleString() : '永久封禁'}
                </p>
              </div>
            </div>
          )}

          <form className="mt-5 space-y-3.5" onSubmit={submit} noValidate>
            <div>
              <label htmlFor="login-email" className={LABEL}>
                邮箱
              </label>
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                autoFocus
                className={FIELD}
              />
            </div>
            <div>
              <label htmlFor="login-password" className={LABEL}>
                密码
              </label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'register' ? '至少 8 位，含字母与数字' : '输入密码'}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                className={FIELD}
              />
            </div>
            {mode === 'register' && (
              <div>
                <label htmlFor="login-confirm" className={LABEL}>
                  确认密码
                </label>
                <input
                  id="login-confirm"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="再次输入密码"
                  autoComplete="new-password"
                  className={FIELD}
                />
              </div>
            )}

            {/* 统一错误信息行（封禁场景由上方警示卡承担） */}
            {error && (
              <p className="text-xs leading-relaxed text-red-500" role="alert">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy || !email.trim() || !password}
              className="flex h-10 w-full items-center justify-center rounded-full bg-mono text-sm font-medium text-mono-fg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (mode === 'login' ? '登录中…' : '注册中…') : mode === 'login' ? '登录' : '注册并登录'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
