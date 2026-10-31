/**
 * 内容治理路由（挂 requireAuth）：用户举报入口。
 * 挂载：app.use('/api', moderationRouter) → POST /api/reports
 * - 目标校验：message / canvas / kbdoc 必须真实存在，并反查归属用户填 target_owner_id
 * - 去重：UNIQUE(reporter_id, target_type, target_id)，重复举报返回 409
 * 错误约定：统一 { error: string }
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { SqliteError } from 'better-sqlite3';
import { z } from 'zod';
import { getDb } from '../db/connection';
import { requireAuth } from '../middleware/auth';

export const moderationRouter = Router();

const reportSchema = z.object({
  targetType: z.enum(['message', 'canvas', 'kbdoc']),
  targetId: z.string().trim().min(1, 'targetId 不能为空').max(128),
  reason: z.string().trim().min(1, '举报原因不能为空').max(500),
  detail: z.string().trim().max(2000).optional(),
});

/** 校验举报目标存在并反查归属用户 id；不存在返回 undefined */
function findTargetOwner(targetType: string, targetId: string): string | undefined {
  const db = getDb();
  if (targetType === 'message') {
    // message 只挂 session_id，归属经 sessions 反查
    const row = db
      .prepare(
        'SELECT s.user_id AS owner FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.id = ?'
      )
      .get(targetId) as { owner: string } | undefined;
    return row?.owner;
  }
  if (targetType === 'canvas') {
    const row = db
      .prepare('SELECT user_id AS owner FROM canvases WHERE id = ?')
      .get(targetId) as { owner: string } | undefined;
    return row?.owner;
  }
  const row = db
    .prepare('SELECT user_id AS owner FROM kb_docs WHERE id = ?')
    .get(targetId) as { owner: string } | undefined;
  return row?.owner;
}

/** POST /api/reports：提交举报（挂 requireAuth）→ 202 { id, status: 'pending' } */
moderationRouter.post('/reports', requireAuth, (req, res) => {
  const parsed = reportSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? '请求参数错误' });
    return;
  }
  const { targetType, targetId, reason, detail } = parsed.data;
  const owner = findTargetOwner(targetType, targetId);
  if (!owner) {
    res.status(404).json({ error: '举报目标不存在' });
    return;
  }
  const id = randomUUID();
  try {
    getDb()
      .prepare(
        `INSERT INTO reports (id, reporter_id, target_type, target_id, target_owner_id, reason, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, req.user!.id, targetType, targetId, owner, reason, detail ?? null);
  } catch (err) {
    // 同一用户对同一内容重复举报：命中 UNIQUE(reporter_id, target_type, target_id)
    if (err instanceof SqliteError && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(409).json({ error: '你已举报过该内容' });
      return;
    }
    throw err;
  }
  res.status(202).json({ id, status: 'pending' });
});
