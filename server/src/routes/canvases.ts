/**
 * 用户画布路由（/api/canvases）：画布上云的 CRUD。
 * - 全部路由挂 requireAuth，仅读写 req.user.id 本人的画布
 * - PUT 乐观锁：body.updatedAt 与库中 updated_at 不一致 → 409（多设备并发修改保护）
 * - 列表不含 data 正文；data 兼容对象 / 字符串两种形态（对象序列化落库，读取时还原为对象）
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection';
import { requireAuth } from '../middleware/auth';

export const canvasesRouter = Router();

interface CanvasRow {
  id: string;
  user_id: string;
  name: string | null;
  data: string | null;
  thumbnail: string | null;
  created_at: string;
  updated_at: string;
}

/** data 入参兼容对象与字符串：对象统一序列化后落库 */
function normalizeData(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/** 读取时还原：可解析为对象的 data 返回对象，否则原样返回字符串 */
function reviveData(raw: string | null): unknown {
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // 非 JSON 文本：原样返回
  }
  return raw;
}

function toFullCanvas(row: CanvasRow) {
  return {
    id: row.id,
    name: row.name,
    data: reviveData(row.data),
    thumbnail: row.thumbnail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 列表条目：不含 data 正文（缩略图概览用） */
function toListItem(row: CanvasRow) {
  return {
    id: row.id,
    name: row.name,
    thumbnail: row.thumbnail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const createSchema = z.object({
  name: z.string().trim().min(1, '画布名称不能为空').max(200, '画布名称过长'),
  data: z.unknown().optional(),
  thumbnail: z.string().max(2_000_000, '缩略图过大').optional().nullable(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1, '画布名称不能为空').max(200, '画布名称过长').optional(),
  data: z.unknown().optional(),
  thumbnail: z.string().max(2_000_000, '缩略图过大').optional().nullable(),
  updatedAt: z.string().min(1, '缺少 updatedAt（乐观锁校验必需）'),
});

function findOwned(id: string, userId: string): CanvasRow | undefined {
  return getDb()
    .prepare('SELECT * FROM canvases WHERE id = ? AND user_id = ?')
    .get(id, userId) as CanvasRow | undefined;
}

/* ============ 路由 ============ */

/** GET /api/canvases：当前用户画布列表（不含 data，按更新时间倒序） */
canvasesRouter.get('/', requireAuth, (req, res) => {
  const rows = getDb()
    .prepare('SELECT * FROM canvases WHERE user_id = ? ORDER BY updated_at DESC, id DESC')
    .all(req.user!.id) as CanvasRow[];
  res.json({ canvases: rows.map(toListItem) });
});

/** POST /api/canvases：创建画布（uuid 主键），返回完整画布 */
canvasesRouter.post('/', requireAuth, (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? '请求参数错误' });
    return;
  }
  const { name, data, thumbnail } = parsed.data;
  const now = new Date().toISOString();
  const row: CanvasRow = {
    id: randomUUID(),
    user_id: req.user!.id,
    name,
    data: normalizeData(data),
    thumbnail: thumbnail ?? null,
    created_at: now,
    updated_at: now,
  };
  getDb()
    .prepare(
      'INSERT INTO canvases (id, user_id, name, data, thumbnail, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(row.id, row.user_id, row.name, row.data, row.thumbnail, row.created_at, row.updated_at);
  res.status(201).json({ canvas: toFullCanvas(row) });
});

/** GET /api/canvases/:id：画布详情（含 data），仅本人可见 */
canvasesRouter.get('/:id', requireAuth, (req, res) => {
  const row = findOwned(req.params.id, req.user!.id);
  if (!row) {
    res.status(404).json({ error: '画布不存在' });
    return;
  }
  res.json({ canvas: toFullCanvas(row) });
});

/** PUT /api/canvases/:id：更新画布（乐观锁：updatedAt 不一致返回 409 + currentUpdatedAt） */
canvasesRouter.put('/:id', requireAuth, (req, res) => {
  const row = findOwned(req.params.id, req.user!.id);
  if (!row) {
    res.status(404).json({ error: '画布不存在' });
    return;
  }
  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? '请求参数错误' });
    return;
  }
  const { name, data, thumbnail, updatedAt } = parsed.data;
  if (updatedAt !== row.updated_at) {
    res.status(409).json({ error: '画布已在其他设备被修改', currentUpdatedAt: row.updated_at });
    return;
  }
  getDb()
    .prepare(
      'UPDATE canvases SET name = ?, data = ?, thumbnail = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    )
    .run(
      name !== undefined ? name : row.name,
      data !== undefined ? normalizeData(data) : row.data,
      thumbnail !== undefined ? thumbnail : row.thumbnail,
      new Date().toISOString(),
      row.id,
      req.user!.id
    );
  const updated = findOwned(row.id, req.user!.id)!;
  res.json({ canvas: toFullCanvas(updated) });
});

/** DELETE /api/canvases/:id：删除画布（sessions.scope 仅字符串引用画布 id，无外键级联） */
canvasesRouter.delete('/:id', requireAuth, (req, res) => {
  const row = findOwned(req.params.id, req.user!.id);
  if (!row) {
    res.status(404).json({ error: '画布不存在' });
    return;
  }
  getDb()
    .prepare('DELETE FROM canvases WHERE id = ? AND user_id = ?')
    .run(row.id, req.user!.id);
  res.json({ ok: true });
});
