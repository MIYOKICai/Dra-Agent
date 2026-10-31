/**
 * 认证路由（/api/auth）：注册 / 登录 / 刷新 / 登出 / 当前用户。
 * - 密码 argon2id 哈希（OWASP 推荐参数：内存 19456 / 时间 2 / 并行 1）
 * - 双 token：access 15min（uid/role/tokenVersion），refresh 30 天（uid/jti），DB 只存 sha256
 * - refresh 轮换 + 复用检测：已吊销 token 再次使用即吊销该用户全部会话
 * - 限流：注册 5 次/时/IP；登录 10 次/分/IP（IP 层）+ 连续失败 5 次锁账号 15 分钟（账号层）
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Router } from 'express';
import argon2 from 'argon2';
import { SqliteError } from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { getJwtSecret } from '../crypto';
import { getDb } from '../db/connection';
import { isBanned, requireAuth, sendBanned } from '../middleware/auth';

export const authRouter = Router();

/* ============ 限流（auth 专属；全局限流由 Task 6 统一挂载） ============ */

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: '注册过于频繁，请一小时后再试' });
  },
});

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: '尝试次数过多，请15分钟后重试' });
  },
});

/* ============ 校验与常量 ============ */

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email('邮箱格式不正确'),
  password: z
    .string()
    .min(8, '密码至少 8 位')
    .regex(/[A-Za-z]/, '密码须包含字母')
    .regex(/\d/, '密码须包含数字'),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, '邮箱不能为空'),
  password: z.string().min(1, '密码不能为空'),
});

/** 密码错误锁定：连续失败次数阈值与锁定时长 */
const LOCK_THRESHOLD = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

/** refresh token 有效期（天） */
const REFRESH_TTL_DAYS = 30;

function nowIso(): string {
  return new Date().toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface TokenUser {
  id: string;
  email: string;
  role: string;
  banned?: number;
  ban_reason?: string | null;
  banned_until?: string | null;
  token_version: number;
}

interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  /** 新 refresh token 的 id（即 jti），用于轮换时回填 replaced_by */
  refreshId: string;
}

/** 为用户签发双 token，并把 refresh token 的 sha256 落库 */
function issueTokens(user: TokenUser): IssuedTokens {
  const accessToken = jwt.sign(
    { uid: user.id, role: user.role, tokenVersion: user.token_version, typ: 'access' },
    getJwtSecret(),
    { expiresIn: '15m' }
  );
  const refreshId = randomBytes(48).toString('hex');
  const refreshToken = jwt.sign({ uid: user.id, jti: refreshId }, getJwtSecret(), {
    expiresIn: '30d',
  });
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  getDb()
    .prepare('INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
    .run(refreshId, user.id, sha256(refreshToken), expiresAt);
  return { accessToken, refreshToken, refreshId };
}

interface AuthedUserRow {
  id: string;
  email: string;
  role: string;
  banned: number;
  ban_reason: string | null;
  banned_until: string | null;
  token_version: number;
}

function toPublicUser(user: { id: string; email: string; role: string }): {
  id: string;
  email: string;
  role: string;
} {
  return { id: user.id, email: user.email, role: user.role };
}

/* ============ 路由 ============ */

/** POST /api/auth/register：注册（首个用户自动成为 admin） */
authRouter.post('/register', registerLimiter, async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? '请求参数错误' });
    return;
  }
  const { email, password } = parsed.data;
  const db = getDb();
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    res.status(409).json({ error: '邮箱已被注册' });
    return;
  }
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  const id = randomUUID();
  const isFirst =
    (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n === 0;
  const role = isFirst ? 'admin' : 'user';
  try {
    db.prepare('INSERT INTO users (id, email, password_hash, role, token_version) VALUES (?, ?, ?, ?, 1)').run(
      id,
      email,
      passwordHash,
      role
    );
  } catch (err) {
    // 并发注册同一邮箱：命中 UNIQUE 约束时返回与预检查一致的 409
    if (err instanceof SqliteError && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(409).json({ error: '邮箱已被注册' });
      return;
    }
    throw err;
  }
  const { accessToken, refreshToken } = issueTokens({ id, email, role, token_version: 1 });
  res.status(201).json({ user: toPublicUser({ id, email, role }), accessToken, refreshToken });
});

/** POST /api/auth/login：登录（IP 限流 + 账号级失败锁定） */
authRouter.post('/login', loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? '请求参数错误' });
    return;
  }
  const { email, password } = parsed.data;
  const db = getDb();
  const user = db
    .prepare(
      `SELECT id, email, password_hash, role, banned, ban_reason, banned_until,
              token_version, failed_attempts, locked_until
       FROM users WHERE email = ?`
    )
    .get(email) as
    | (AuthedUserRow & { password_hash: string; failed_attempts: number; locked_until: string | null })
    | undefined;

  const now = new Date();
  if (user && user.locked_until && new Date(user.locked_until) > now) {
    res.status(429).json({ error: '尝试次数过多，请15分钟后重试' });
    return;
  }
  if (!user || !(await argon2.verify(user.password_hash, password))) {
    if (user) {
      const attempts = user.failed_attempts + 1;
      const lockedUntil =
        attempts >= LOCK_THRESHOLD ? new Date(Date.now() + LOCK_DURATION_MS).toISOString() : user.locked_until;
      db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?').run(
        attempts,
        lockedUntil,
        now.toISOString(),
        user.id
      );
    }
    // 统一错误文案：不区分「邮箱不存在」与「密码错误」，避免账号枚举
    res.status(401).json({ error: '邮箱或密码错误' });
    return;
  }
  if (isBanned(user, now)) {
    sendBanned(res, user);
    return;
  }
  // 登录成功：清零失败计数 / 解除锁定；封禁已到期的顺带自动解封
  db.prepare(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?,
       banned = 0, ban_reason = NULL, banned_until = NULL, updated_at = ? WHERE id = ?`
  ).run(now.toISOString(), now.toISOString(), user.id);
  const { accessToken, refreshToken } = issueTokens(user);
  res.json({ user: toPublicUser(user), accessToken, refreshToken });
});

/** POST /api/auth/refresh：刷新 access token（轮换 refresh token + 复用检测） */
authRouter.post('/refresh', (req, res) => {
  const body = (req.body ?? {}) as { refreshToken?: unknown };
  if (typeof body.refreshToken !== 'string' || !body.refreshToken) {
    res.status(400).json({ error: '缺少 refreshToken' });
    return;
  }
  const db = getDb();
  const row = db
    .prepare('SELECT id, user_id, expires_at, revoked FROM refresh_tokens WHERE token_hash = ?')
    .get(sha256(body.refreshToken)) as
    | { id: string; user_id: string; expires_at: string; revoked: number }
    | undefined;
  if (!row) {
    res.status(401).json({ error: '登录状态已失效，请重新登录' });
    return;
  }
  if (row.revoked) {
    // 复用检测：已吊销的 token 再次出现视为凭证泄露，吊销该用户全部会话
    db.prepare(
      'UPDATE refresh_tokens SET revoked = 1, updated_at = ? WHERE user_id = ? AND revoked = 0'
    ).run(nowIso(), row.user_id);
    res.status(401).json({ error: '登录凭证异常，已退出全部设备' });
    return;
  }
  if (new Date(row.expires_at) <= new Date()) {
    res.status(401).json({ error: '登录已过期，请重新登录' });
    return;
  }
  const user = db
    .prepare(
      'SELECT id, email, role, banned, ban_reason, banned_until, token_version FROM users WHERE id = ?'
    )
    .get(row.user_id) as AuthedUserRow | undefined;
  if (!user) {
    res.status(401).json({ error: '账号不存在或已被删除' });
    return;
  }
  if (isBanned(user, new Date())) {
    sendBanned(res, user);
    return;
  }
  const { accessToken, refreshToken, refreshId } = issueTokens(user);
  // 轮换：旧 token 置 revoked 并记录 replaced_by 指向新 token
  db.prepare(
    'UPDATE refresh_tokens SET revoked = 1, replaced_by = ?, last_used_at = ?, updated_at = ? WHERE id = ?'
  ).run(refreshId, nowIso(), nowIso(), row.id);
  res.json({ user: toPublicUser(user), accessToken, refreshToken });
});

/** POST /api/auth/logout：吊销传入的 refresh token（幂等） */
authRouter.post('/logout', (req, res) => {
  const body = (req.body ?? {}) as { refreshToken?: unknown };
  if (typeof body.refreshToken !== 'string' || !body.refreshToken) {
    res.status(400).json({ error: '缺少 refreshToken' });
    return;
  }
  getDb()
    .prepare('UPDATE refresh_tokens SET revoked = 1, updated_at = ? WHERE token_hash = ? AND revoked = 0')
    .run(nowIso(), sha256(body.refreshToken));
  res.json({ ok: true });
});

/** GET /api/auth/me：当前登录用户资料 */
authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
