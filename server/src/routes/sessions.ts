/**
 * 用户会话路由（/api/sessions）：会话与消息上云。
 * - 全部路由挂 requireAuth，仅读写 req.user.id 本人的会话
 * - 列表游标分页：cursor = base64(`${updated_at}|${id}`)，按 updated_at 倒序
 * - 消息游标分页：beforeSeq 取更早一页（seq 倒序取页），页内按 seq 正序返回
 * - 兼容字段（对齐 client CreationSession / CreationMessage，Task 8 迁移用）：
 *   时间戳除 ISO 字符串外附 ms 数值（createdAtMs / updatedAtMs / message.time），
 *   消息的 steps / usage 从 meta 提平；长对话摘要存 sessions.summary
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection';
import { requireAuth } from '../middleware/auth';

export const sessionsRouter = Router();

interface SessionRow {
  id: string;
  user_id: string;
  scope: string;
  title: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string | null;
  content: string | null;
  meta: string | null;
  seq: number;
  created_at: string;
  updated_at: string;
}

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

/** 解析 ?limit=：非法回退默认值，钳制到 [1, MAX_PAGE_LIMIT] */
function parseLimit(raw: unknown): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_PAGE_LIMIT;
  }
  return Math.min(Math.floor(n), MAX_PAGE_LIMIT);
}

function countMessages(sessionId: string): number {
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?')
      .get(sessionId) as { n: number }
  ).n;
}

function toSession(row: SessionRow, messageCount?: number) {
  return {
    id: row.id,
    scope: row.scope,
    title: row.title,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // 兼容字段：client CreationSession 的时间戳为 ms 数值
    createdAtMs: Date.parse(row.created_at),
    updatedAtMs: Date.parse(row.updated_at),
    ...(messageCount === undefined ? {} : { messageCount }),
  };
}

function toMessage(row: MessageRow) {
  let meta: Record<string, unknown> | null = null;
  if (row.meta) {
    try {
      const parsed: unknown = JSON.parse(row.meta);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch {
      // 损坏 meta：按 null 处理
    }
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    meta,
    seq: row.seq,
    createdAt: row.created_at,
    // 兼容字段：对齐 client CreationMessage（steps / usage 存于 meta，time 缺省取消息创建时间）
    steps: (meta?.steps as unknown) ?? undefined,
    usage: (meta?.usage as unknown) ?? undefined,
    time: typeof meta?.time === 'number' ? meta.time : Date.parse(row.created_at),
  };
}

function encodeCursor(row: { updated_at: string; id: string }): string {
  return Buffer.from(`${row.updated_at}|${row.id}`, 'utf8').toString('base64');
}

function decodeCursor(raw: string): { updatedAt: string; id: string } | null {
  const decoded = Buffer.from(raw, 'base64').toString('utf8');
  const sep = decoded.indexOf('|');
  if (sep <= 0 || sep === decoded.length - 1) {
    return null;
  }
  return { updatedAt: decoded.slice(0, sep), id: decoded.slice(sep + 1) };
}

function findOwned(id: string, userId: string): SessionRow | undefined {
  return getDb()
    .prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?')
    .get(id, userId) as SessionRow | undefined;
}

/* ============ 路由 ============ */

/**
 * GET /api/sessions?scope=&limit=&cursor=：会话列表（按 updated_at 倒序，游标分页）。
 * 响应 { sessions, nextCursor, hasMore }
 */
sessionsRouter.get('/', requireAuth, (req, res) => {
  const limit = parseLimit(req.query.limit);
  const scopeRaw = req.query.scope;
  const scope = typeof scopeRaw === 'string' && scopeRaw ? scopeRaw : null;
  const cursorRaw = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : null;
  let cursor: { updatedAt: string; id: string } | null = null;
  if (cursorRaw) {
    cursor = decodeCursor(cursorRaw);
    if (!cursor) {
      res.status(400).json({ error: 'cursor 无效' });
      return;
    }
  }
  const conditions = ['user_id = ?'];
  const params: (string | number)[] = [req.user!.id];
  if (scope) {
    conditions.push('scope = ?');
    params.push(scope);
  }
  if (cursor) {
    conditions.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
    params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  }
  const rows = getDb()
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
       FROM sessions s WHERE ${conditions.join(' AND ')}
       ORDER BY updated_at DESC, id DESC LIMIT ?`
    )
    .all(...params, limit + 1) as (SessionRow & { message_count: number })[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  res.json({
    sessions: page.map((row) => toSession(row, row.message_count)),
    nextCursor: hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]) : null,
    hasMore,
  });
});

/** POST /api/sessions {scope, title?}：创建会话 */
sessionsRouter.post('/', requireAuth, (req, res) => {
  const createSchema = z.object({
    scope: z.string().trim().min(1, 'scope 不能为空').max(128, 'scope 过长'),
    title: z.string().trim().max(200, '标题过长').optional(),
  });
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? '请求参数错误' });
    return;
  }
  const { scope, title } = parsed.data;
  const now = new Date().toISOString();
  const row: SessionRow = {
    id: randomUUID(),
    user_id: req.user!.id,
    scope,
    title: title ?? null,
    summary: null,
    created_at: now,
    updated_at: now,
  };
  getDb()
    .prepare(
      'INSERT INTO sessions (id, user_id, scope, title, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(row.id, row.user_id, row.scope, row.title, row.summary, row.created_at, row.updated_at);
  res.status(201).json({ session: toSession(row, 0) });
});

/** GET /api/sessions/:id：会话详情（含消息条数，不含消息本体） */
sessionsRouter.get('/:id', requireAuth, (req, res) => {
  const session = findOwned(req.params.id, req.user!.id);
  if (!session) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  res.json({ session: toSession(session, countMessages(session.id)) });
});

/**
 * GET /api/sessions/:id/messages?limit=&beforeSeq=：消息游标分页。
 * 无 beforeSeq 时取最新一页（seq 最大者在前取页）；beforeSeq 取该序号更早的一页。
 * 响应 { messages（页内按 seq 正序）, nextBeforeSeq, hasMore }
 */
sessionsRouter.get('/:id/messages', requireAuth, (req, res) => {
  const session = findOwned(req.params.id, req.user!.id);
  if (!session) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  const limit = parseLimit(req.query.limit);
  const beforeRaw = req.query.beforeSeq;
  let beforeSeq: number | null = null;
  if (typeof beforeRaw === 'string' && beforeRaw !== '') {
    const n = Number(beforeRaw);
    if (!Number.isInteger(n) || n <= 0) {
      res.status(400).json({ error: 'beforeSeq 无效' });
      return;
    }
    beforeSeq = n;
  }
  const db = getDb();
  const rows = (
    beforeSeq === null
      ? db
          .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?')
          .all(session.id, limit + 1)
      : db
          .prepare('SELECT * FROM messages WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
          .all(session.id, beforeSeq, limit + 1)
  ) as MessageRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  res.json({
    messages: [...page].reverse().map(toMessage),
    nextBeforeSeq: page.length > 0 ? page[page.length - 1].seq : null,
    hasMore,
  });
});

/** POST /api/sessions/:id/messages {role, content, meta?, seq?}：追加消息（seq 缺省取当前最大+1） */
sessionsRouter.post('/:id/messages', requireAuth, (req, res) => {
  const session = findOwned(req.params.id, req.user!.id);
  if (!session) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  const messageSchema = z.object({
    role: z.enum(['user', 'assistant', 'system', 'tool']),
    content: z.string(),
    meta: z.record(z.string(), z.unknown()).optional(),
    seq: z.number().int().min(1).optional(),
  });
  const parsed = messageSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? '请求参数错误' });
    return;
  }
  const { role, content, meta, seq } = parsed.data;
  const db = getDb();
  if (seq !== undefined) {
    const exists = db
      .prepare('SELECT id FROM messages WHERE session_id = ? AND seq = ?')
      .get(session.id, seq);
    if (exists) {
      res.status(409).json({ error: '消息序号冲突' });
      return;
    }
  }
  const now = new Date().toISOString();
  const row: MessageRow = {
    id: randomUUID(),
    session_id: session.id,
    role,
    content,
    meta: meta ? JSON.stringify(meta) : null,
    seq: 0,
    created_at: now,
    updated_at: now,
  };
  // 追加消息 + 会话置新（列表按 updated_at 倒序）在同一事务完成
  const append = db.transaction((): number => {
    if (seq !== undefined) {
      row.seq = seq;
    } else {
      const maxRow = db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE session_id = ?')
        .get(session.id) as { max_seq: number };
      row.seq = maxRow.max_seq + 1;
    }
    db.prepare(
      'INSERT INTO messages (id, session_id, role, content, meta, seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(row.id, row.session_id, row.role, row.content, row.meta, row.seq, row.created_at, row.updated_at);
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, session.id);
    return row.seq;
  });
  append();
  res.status(201).json({ message: toMessage(row) });
});

/** PUT /api/sessions/:id {title?, summary?}：更新会话标题 / 长期摘要 */
sessionsRouter.put('/:id', requireAuth, (req, res) => {
  const session = findOwned(req.params.id, req.user!.id);
  if (!session) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  const updateSchema = z.object({
    title: z.string().trim().min(1, '标题不能为空').max(200, '标题过长').optional(),
    summary: z.string().optional(),
  });
  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? '请求参数错误' });
    return;
  }
  const { title, summary } = parsed.data;
  if (title === undefined && summary === undefined) {
    res.status(400).json({ error: '至少提供 title 或 summary' });
    return;
  }
  const now = new Date().toISOString();
  getDb()
    .prepare('UPDATE sessions SET title = ?, summary = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(
      title !== undefined ? title : session.title,
      summary !== undefined ? summary : session.summary,
      now,
      session.id,
      req.user!.id
    );
  const updated = findOwned(session.id, req.user!.id)!;
  res.json({ session: toSession(updated, countMessages(updated.id)) });
});

/** DELETE /api/sessions/:id：删除会话（消息经外键 ON DELETE CASCADE 级联删除） */
sessionsRouter.delete('/:id', requireAuth, (req, res) => {
  const session = findOwned(req.params.id, req.user!.id);
  if (!session) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  getDb()
    .prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?')
    .run(session.id, req.user!.id);
  res.json({ ok: true });
});
