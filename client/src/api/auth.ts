/**
 * 认证 API 客户端（/api/auth/*）：注册 / 登录 / 刷新 / 登出 / 当前用户。
 * 与 gateway.ts 同一基址约定（API_BASE = '/api'，vite 代理 → server :3001，
 * 桌面端由 server 静态托管同源直连）。
 * 认证接口不走 gateway 的 authedFetch（避免刷新逻辑递归），失败统一抛
 * AuthError（携带 HTTP 状态码与响应体，供登录页区分封禁 / 限流等场景）。
 */
import { API_BASE } from './client';
import type { AuthUser } from '../store/authStore';

/** 登录 / 注册 / 刷新成功返回的令牌负载 */
export interface AuthPayload {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

/** 认证接口错误：message 为服务端 { error } 文案，payload 保留完整响应体 */
export class AuthError extends Error {
  status: number;
  payload: Record<string, unknown> | null;

  constructor(status: number, payload: Record<string, unknown> | null, fallback: string) {
    super(payload && typeof payload.error === 'string' && payload.error ? payload.error : fallback);
    this.name = 'AuthError';
    this.status = status;
    this.payload = payload;
  }

  /** 服务端封禁响应（403 + banReason 字段，永久封禁时 reason 为 null） */
  get banInfo(): { reason: string | null; until: string | null } | null {
    if (this.status !== 403 || !this.payload || !('banReason' in this.payload)) return null;
    return {
      reason: typeof this.payload.banReason === 'string' ? this.payload.banReason : null,
      until: typeof this.payload.bannedUntil === 'string' ? this.payload.bannedUntil : null,
    };
  }
}

/** 统一 POST JSON：非 2xx 抛 AuthError（读取服务端 { error } 文案） */
async function postJson<T>(path: string, body: unknown, fallback: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new AuthError(0, null, `无法连接服务器：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    throw new AuthError(res.status, payload, `${fallback}（HTTP ${res.status}）`);
  }
  return (await res.json()) as T;
}

/** POST /api/auth/register：注册并直接登录（首个用户自动成为 admin） */
export function register(email: string, password: string): Promise<AuthPayload> {
  return postJson('/auth/register', { email, password }, '注册失败');
}

/** POST /api/auth/login：登录（401 凭证错误 / 429 限流 / 403 封禁 → AuthError） */
export function login(email: string, password: string): Promise<AuthPayload> {
  return postJson('/auth/login', { email, password }, '登录失败');
}

/** POST /api/auth/refresh：用 refreshToken 换新令牌对（服务端轮换 refresh token）。
 *  仅供 gateway 静默刷新与登出前清理使用，不注入 Authorization 头 */
export function refreshTokens(refreshToken: string): Promise<AuthPayload> {
  return postJson('/auth/refresh', { refreshToken }, '登录状态已失效');
}

/** POST /api/auth/logout：吊销 refreshToken（幂等）。网络失败静默——本地状态照常清空 */
export async function logout(refreshToken: string): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    // 服务端 204 无响应体 / 200 { ok: true } 均视为成功，其余状态忽略（幂等）
    if (res.ok || res.status === 204) await res.json().catch(() => undefined);
  } catch {
    // 登出请求失败不阻塞客户端清会话
  }
}

/** GET /api/auth/me：读取当前登录用户（需 Bearer access token） */
export async function fetchMe(accessToken: string): Promise<AuthUser> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    throw new AuthError(0, null, `无法连接服务器：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    throw new AuthError(res.status, payload, `读取用户信息失败（HTTP ${res.status}）`);
  }
  const data = (await res.json()) as { user?: AuthUser };
  if (!data.user) throw new AuthError(res.status, null, '用户信息响应格式错误');
  return data.user;
}
