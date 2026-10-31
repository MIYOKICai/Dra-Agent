/**
 * 管理后台路由（requireAuth + requireAdmin + 独立限流 100 次/分）。
 * 挂载：app.use('/api/admin', adminRouter)
 * 能力：用户管理（搜索 / 封禁 / 解封 / 重置密码）、举报处置队列、运营统计、
 *       平台密钥管理（AES-256-GCM 加密落库）、审计日志查询。
 * 错误约定：统一 { error: string }
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import argon2 from 'argon2';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { writeAudit } from '../audit';
import { banUser, unbanUser } from '../banService';
import { decryptSecret, encryptSecret } from '../crypto';
import { getDb } from '../db/connection';
import { deleteDocument } from '../kb';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { dataDir } from '../paths';

export const adminRouter = Router();

/* ============ 限流（admin 专属，独立于全局） ============ */

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  },
});

adminRouter.use(requireAuth, requireAdmin, adminLimiter);

/* ============ 通用辅助 ============ */

/** 解析分页参数：page 从 1 起；pageSize 1..100（默认 20） */
function parsePagination(query: Record<string, unknown>): {
  page: number;
  pageSize: number;
  offset: number;
} {
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(query.pageSize) || 20)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function nowIso(): string {
  return new Date().toISOString();
}

/* ============ 用户管理 ============ */

interface AdminUserRow {
  id: string;
  email: string;
  role: string;
  banned: number;
  ban_reason: string | null;
  banned_until: string | null;
  token_version: number;
  last_login_at: string | null;
  created_at: string;
}

/** 用户行 → 对外结构（绝不含 password_hash） */
function mapUser(r: AdminUserRow): Record<string, unknown> {
  return {
    id: r.id,
    email: r.email,
    role: r.role,
    banned: r.banned === 1,
    banReason: r.ban_reason,
    bannedUntil: r.banned_until,
    tokenVersion: r.token_version,
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
  };
}

/** GET /api/admin/users?query=&page=&pageSize=：用户列表（email 模糊搜索） */
adminRouter.get('/users', (req, res) => {
  const { page, pageSize, offset } = parsePagination(req.query);
  const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
  const db = getDb();
  const where = query ? 'WHERE email LIKE ?' : '';
  const params: string[] = query ? [`%${query}%`] : [];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM users ${where}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT id, email, role, banned, ban_reason, banned_until, token_version, last_login_at, created_at
       FROM users ${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset) as AdminUserRow[];
  res.json({ items: rows.map(mapUser), total, page, pageSize });
});

const banSchema = z.object({
  reason: z.string().trim().min(1, '封禁原因不能为空').max(500),
  days: z.number().int().positive('days 须为正整数').optional(),
});

/** POST /api/admin/users/:id/ban { reason, days? }：封禁并即时吊销全部 token */
adminRouter.post('/users/:id/ban', (req, res) => {
  const parsed = banSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? '请求参数错误' });
    return;
  }
  const { reason, days } = parsed.data;
  const outcome = banUser(req.params.id, reason, days ?? null);
  if (!outcome.ok) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }
  writeAudit(
    req.user!.id,
    req.params.id,
    'admin.ban_user',
    JSON.stringify({ reason, days: days ?? null, bannedUntil: outcome.bannedUntil }),
    req
  );
  res.json({ ok: true, bannedUntil: outcome.bannedUntil });
});

/** POST /api/admin/users/:id/unban：解除封禁（token_version 不动，重新登录即可） */
adminRouter.post('/users/:id/unban', (req, res) => {
  if (!unbanUser(req.params.id)) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }
  writeAudit(req.user!.id, req.params.id, 'admin.unban_user', null, req);
  res.json({ ok: true });
});

const resetPasswordSchema = z.object({
  newPassword: z
    .string()
    .min(8, '密码至少 8 位')
    .regex(/[A-Za-z]/, '密码须包含字母')
    .regex(/\d/, '密码须包含数字'),
});

/** POST /api/admin/users/:id/reset-password { newPassword }：重置密码并全端下线 */
adminRouter.post('/users/:id/reset-password', async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? '请求参数错误' });
    return;
  }
  const db = getDb();
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id)) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }
  // argon2id 参数与注册保持一致（OWASP 推荐：内存 19456 / 时间 2 / 并行 1）
  const passwordHash = await argon2.hash(parsed.data.newPassword, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  const now = nowIso();
  // token_version+1 即时吊销全部 access token；refresh token 一并吊销
  db.prepare(
    'UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?'
  ).run(passwordHash, now, req.params.id);
  db.prepare(
    'UPDATE refresh_tokens SET revoked = 1, updated_at = ? WHERE user_id = ? AND revoked = 0'
  ).run(now, req.params.id);
  writeAudit(req.user!.id, req.params.id, 'admin.reset_password', null, req);
  res.json({ ok: true });
});

/* ============ 举报处置 ============ */

interface ReportRow {
  id: string;
  reporter_id: string;
  target_type: string | null;
  target_id: string | null;
  target_owner_id: string | null;
  reason: string | null;
  detail: string | null;
  status: string;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  reporter_email: string | null;
  owner_email: string | null;
}

function mapReport(r: ReportRow): Record<string, unknown> {
  return {
    id: r.id,
    targetType: r.target_type,
    targetId: r.target_id,
    reason: r.reason,
    detail: r.detail,
    status: r.status,
    resolution: r.resolution,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
    reporter: { id: r.reporter_id, email: r.reporter_email },
    owner: { id: r.target_owner_id, email: r.owner_email },
  };
}

const REPORT_STATUSES = ['pending', 'resolved', 'dismissed'];

/** GET /api/admin/reports?status=&page=：举报队列（含目标摘要） */
adminRouter.get('/reports', (req, res) => {
  const { page, pageSize, offset } = parsePagination(req.query);
  const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  if (status && !REPORT_STATUSES.includes(status)) {
    res.status(400).json({ error: 'status 参数非法（pending/resolved/dismissed）' });
    return;
  }
  const db = getDb();
  const where = status ? 'WHERE r.status = ?' : '';
  const params: string[] = status ? [status] : [];
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM reports r ${where}`).get(...params) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT r.*, ru.email AS reporter_email, ou.email AS owner_email
       FROM reports r
       LEFT JOIN users ru ON ru.id = r.reporter_id
       LEFT JOIN users ou ON ou.id = r.target_owner_id
       ${where} ORDER BY r.created_at DESC, r.id LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset) as ReportRow[];
  res.json({ items: rows.map(mapReport), total, page, pageSize });
});

/** 将举报标记为 resolved（status / resolution / resolved_by / resolved_at 一次写入） */
function resolveReport(reportId: string, resolution: string | null, adminId: string): void {
  getDb()
    .prepare(
      `UPDATE reports SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(resolution, adminId, nowIso(), nowIso(), reportId);
}

/**
 * 按类型删除被举报内容；目标不存在返回 false。
 * - message / canvas：直接删 SQLite 记录
 * - kbdoc：kb.ts 的 deleteDocument 为统一级联删除入口（文件索引切片 + 实体文件 + kb_docs 记录），
 *   按文档归属用户调用；索引文件缺失等失败仅告警，再兜底删 kb_docs 记录。
 */
async function removeReportedContent(targetType: string | null, targetId: string | null): Promise<boolean> {
  if (!targetId) {
    return false;
  }
  const db = getDb();
  if (targetType === 'message') {
    return db.prepare('DELETE FROM messages WHERE id = ?').run(targetId).changes > 0;
  }
  if (targetType === 'canvas') {
    return db.prepare('DELETE FROM canvases WHERE id = ?').run(targetId).changes > 0;
  }
  if (targetType === 'kbdoc') {
    const doc = db
      .prepare('SELECT user_id, kb_id FROM kb_docs WHERE id = ?')
      .get(targetId) as { user_id: string; kb_id: string } | undefined;
    if (!doc) {
      return false;
    }
    try {
      await deleteDocument(doc.user_id, doc.kb_id, targetId);
    } catch (err) {
      console.warn(
        `[dra-agent-admin] 删除知识库文档（文件索引）失败，仅删除治理记录: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    db.prepare('DELETE FROM kb_docs WHERE id = ?').run(targetId);
    return true;
  }
  return false;
}

const resolveSchema = z.object({
  action: z.enum(['ban_user', 'remove_content', 'dismiss']),
  note: z.string().trim().max(2000).optional(),
});

/** POST /api/admin/reports/:id/resolve { action, note? }：处置举报 */
adminRouter.post('/reports/:id/resolve', async (req, res) => {
  const parsed = resolveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? '请求参数错误' });
    return;
  }
  const { action, note } = parsed.data;
  const adminId = req.user!.id;
  const report = getDb()
    .prepare(
      `SELECT id, reporter_id, target_type, target_id, target_owner_id, reason, detail, status
       FROM reports WHERE id = ?`
    )
    .get(req.params.id) as
    | Pick<ReportRow, 'id' | 'reporter_id' | 'target_type' | 'target_id' | 'target_owner_id' | 'reason' | 'detail' | 'status'>
    | undefined;
  if (!report) {
    res.status(404).json({ error: '举报不存在' });
    return;
  }

  if (action === 'dismiss') {
    getDb()
      .prepare(
        "UPDATE reports SET status = 'dismissed', resolution = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?"
      )
      .run(note ?? null, adminId, nowIso(), nowIso(), report.id);
    writeAudit(adminId, report.id, 'admin.report_dismiss', JSON.stringify({ note: note ?? null }), req);
    res.json({ ok: true, status: 'dismissed' });
    return;
  }

  if (action === 'ban_user') {
    if (!report.target_owner_id) {
      res.status(400).json({ error: '该举报没有归属用户，无法执行封禁' });
      return;
    }
    // 封禁原因 = 举报原因 + 处置备注；举报处置默认永久封禁
    const reason = [report.reason, note].filter(Boolean).join('；');
    const outcome = banUser(report.target_owner_id, reason, null);
    if (!outcome.ok) {
      res.status(404).json({ error: '被举报用户不存在' });
      return;
    }
    resolveReport(report.id, 'ban_user', adminId);
    writeAudit(
      adminId,
      report.target_owner_id,
      'admin.report_ban_user',
      JSON.stringify({ reportId: report.id, reason, bannedUntil: outcome.bannedUntil }),
      req
    );
    res.json({ ok: true, status: 'resolved' });
    return;
  }

  // action === 'remove_content'
  const removed = await removeReportedContent(report.target_type, report.target_id);
  if (!removed) {
    res.status(404).json({ error: '举报目标不存在或已删除' });
    return;
  }
  resolveReport(report.id, 'remove_content', adminId);
  writeAudit(
    adminId,
    report.target_id,
    'admin.report_remove_content',
    JSON.stringify({ reportId: report.id, targetType: report.target_type }),
    req
  );
  res.json({ ok: true, status: 'resolved' });
});

/* ============ 运营统计 ============ */

/** 递归统计目录字节数（目录不存在返回 0；仅统计常规文件） */
function dirSize(dir: string): number {
  if (!existsSync(dir)) {
    return 0;
  }
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
      } else if (entry.isFile()) {
        try {
          total += statSync(p).size;
        } catch {
          // 文件被并发删除等场景：忽略单个文件的统计失败
        }
      }
    }
  }
  return total;
}

/** GET /api/admin/stats：运营统计 { users, activeToday, llmCallsToday, storageBytes } */
adminRouter.get('/stats', (_req, res) => {
  const db = getDb();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0); // 本地时区的今日零点
  const dayStartIso = dayStart.toISOString();
  const users = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  const activeToday = (
    db.prepare('SELECT COUNT(*) AS n FROM users WHERE last_login_at >= ?').get(dayStartIso) as { n: number }
  ).n;
  // llmCallsToday 近似：暂无 LLM 调用埋点/用量 meta，先以当日新增 messages 条数近似调用次数
  const llmCallsToday = (
    db.prepare('SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?').get(dayStartIso) as { n: number }
  ).n;
  res.json({ users, activeToday, llmCallsToday, storageBytes: dirSize(path.join(dataDir, 'files')) });
});

/* ============ 平台密钥管理 ============ */

/** 密钥打码：保留前后 4 字符，中间以 * 代替；≤8 字符的短密钥全打码 */
function maskKey(plain: string): string {
  if (plain.length <= 8) {
    return '*'.repeat(Math.max(plain.length, 4));
  }
  return `${plain.slice(0, 4)}${'*'.repeat(Math.max(plain.length - 8, 4))}${plain.slice(-4)}`;
}

/** GET /api/admin/platform-keys：平台密钥列表（打码回传，不出明文） */
adminRouter.get('/platform-keys', (_req, res) => {
  const rows = getDb()
    .prepare('SELECT provider, encrypted, updated_at FROM platform_keys ORDER BY provider')
    .all() as { provider: string; encrypted: string; updated_at: string }[];
  const keys = rows.map((row) => {
    let masked = '****';
    try {
      masked = maskKey(decryptSecret(row.encrypted));
    } catch {
      // 主密钥轮换等导致解密失败：保留占位打码，不让接口 500
    }
    return { provider: row.provider, key: masked, updatedAt: row.updated_at };
  });
  res.json({ keys });
});

const platformKeySchema = z.object({
  provider: z.string().trim().min(1, 'provider 不能为空').max(64),
  key: z.string().max(4096),
});

/** PUT /api/admin/platform-keys { provider, key }：加密落库；key 为空字符串 = 删除该 provider 密钥 */
adminRouter.put('/platform-keys', (req, res) => {
  const parsed = platformKeySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? '请求参数错误' });
    return;
  }
  const { provider, key } = parsed.data;
  const db = getDb();
  if (key === '') {
    db.prepare('DELETE FROM platform_keys WHERE provider = ?').run(provider);
    writeAudit(req.user!.id, provider, 'admin.platform_key_delete', null, req);
    res.json({ ok: true, deleted: true });
    return;
  }
  db.prepare(
    `INSERT INTO platform_keys (provider, encrypted, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET encrypted = excluded.encrypted, updated_at = excluded.updated_at`
  ).run(provider, encryptSecret(key), nowIso());
  writeAudit(req.user!.id, provider, 'admin.platform_key_set', null, req);
  res.json({ ok: true });
});

/* ============ 审计日志 ============ */

interface AuditRow {
  id: string;
  actor_id: string | null;
  target_id: string | null;
  action: string | null;
  detail: string | null;
  ip: string | null;
  ua: string | null;
  created_at: string;
}

/** GET /api/admin/audit-logs?page=&action=：审计日志分页倒序 */
adminRouter.get('/audit-logs', (req, res) => {
  const { page, pageSize, offset } = parsePagination(req.query);
  const action = typeof req.query.action === 'string' ? req.query.action.trim() : '';
  const db = getDb();
  const where = action ? 'WHERE action = ?' : '';
  const params: string[] = action ? [action] : [];
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM audit_logs ${where}`).get(...params) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT id, actor_id, target_id, action, detail, ip, ua, created_at
       FROM audit_logs ${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset) as AuditRow[];
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      targetId: r.target_id,
      action: r.action,
      detail: r.detail,
      ip: r.ip,
      ua: r.ua,
      createdAt: r.created_at,
    })),
    total,
    page,
    pageSize,
  });
});
