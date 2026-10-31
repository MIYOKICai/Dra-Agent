/**
 * 认证中间件：
 * - requireAuth：解析 Bearer Token → 验签 → 查库核对用户与 token_version → 封禁检查（到期自动解封）
 * - requireAdmin：管理员守卫（挂在 requireAuth 之后使用）
 * 认证通过后 req.user = { id, email, role } 供后续路由使用。
 */
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../crypto';
import { getDb } from '../db/connection';

/** 认证通过后挂到 req.user 上的用户信息 */
export interface AuthUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** access token 的 JWT 载荷 */
interface AccessPayload {
  uid: string;
  role: string;
  tokenVersion: number;
  /** 令牌类型：access token 强制要求，防止 refresh token 被当作 access token 使用 */
  typ: 'access';
}

interface UserRow {
  id: string;
  email: string;
  role: string;
  banned: number;
  ban_reason: string | null;
  banned_until: string | null;
  token_version: number;
}

/** 封禁判定：banned=1 且（永久封禁或封禁未到期）返回 true */
export function isBanned(user: { banned: number; banned_until: string | null }, now: Date): boolean {
  if (!user.banned) {
    return false;
  }
  return !user.banned_until || new Date(user.banned_until) > now;
}

/** 403 封禁响应（含封禁原因与到期时间，永久封禁时 bannedUntil 为 null） */
export function sendBanned(
  res: Response,
  user: { ban_reason: string | null; banned_until: string | null }
): void {
  res.status(403).json({
    error: '账号已被封禁',
    banReason: user.ban_reason ?? null,
    bannedUntil: user.banned_until ?? null,
  });
}

/** Bearer 鉴权守卫：挂在需要登录的路由前 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: '未登录' });
    return;
  }
  const token = header.slice(7).trim();

  let payload: AccessPayload;
  try {
    payload = jwt.verify(token, getJwtSecret()) as AccessPayload;
  } catch (err) {
    const msg = err instanceof jwt.TokenExpiredError ? '登录已过期，请重新登录' : '无效的登录凭证';
    res.status(401).json({ error: msg });
    return;
  }
  if (payload.typ !== 'access' || typeof payload.uid !== 'string') {
    res.status(401).json({ error: '无效的登录凭证' });
    return;
  }

  const db = getDb();
  const user = db
    .prepare(
      'SELECT id, email, role, banned, ban_reason, banned_until, token_version FROM users WHERE id = ?'
    )
    .get(payload.uid) as UserRow | undefined;
  if (!user) {
    res.status(401).json({ error: '账号不存在或已被删除' });
    return;
  }
  if (payload.tokenVersion !== user.token_version) {
    // token_version 已递增（如改密后全端下线），旧 token 一律拒绝
    res.status(401).json({ error: '登录状态已失效，请重新登录' });
    return;
  }

  const now = new Date();
  if (isBanned(user, now)) {
    sendBanned(res, user);
    return;
  }
  if (user.banned) {
    // 封禁已到期：自动解封放行
    db.prepare(
      "UPDATE users SET banned = 0, ban_reason = NULL, banned_until = NULL, updated_at = ? WHERE id = ? AND banned = 1"
    ).run(now.toISOString(), user.id);
  }

  req.user = { id: user.id, email: user.email, role: user.role === 'admin' ? 'admin' : 'user' };
  next();
}

/** 管理员守卫：须挂在 requireAuth 之后（依赖 req.user） */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: '需要管理员权限' });
    return;
  }
  next();
}
