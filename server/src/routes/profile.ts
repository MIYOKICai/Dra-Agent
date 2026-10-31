/**
 * 用户长期画像路由（/api/profile）：memories 表的 profile JSON 读写。
 * - 全部路由挂 requireAuth，仅读写 req.user.id 本人数据（memories.user_id 主键）
 * - 覆盖式 upsert；旧版单文件画像（data/profile.json）由本接口接管（Task 8 迁移）
 * - 长期对话摘要不在本接口：存于 sessions.summary（见 routes/sessions.ts 的 PUT）
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection';
import { requireAuth } from '../middleware/auth';

export const profileRouter = Router();

const profileSchema = z.object({
  profile: z.record(z.string(), z.unknown()),
});

/** 读取当前用户画像（无记录 / 数据损坏 / 非对象时降级为空对象） */
function loadProfile(userId: string): Record<string, unknown> {
  const row = getDb()
    .prepare('SELECT profile FROM memories WHERE user_id = ?')
    .get(userId) as { profile: string | null } | undefined;
  if (!row?.profile) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(row.profile);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 损坏数据：降级为空画像
  }
  return {};
}

/** GET /api/profile：当前用户画像（无则 {}），响应 { profile } */
profileRouter.get('/', requireAuth, (req, res) => {
  res.json({ profile: loadProfile(req.user!.id) });
});

/** PUT /api/profile：覆盖式 upsert（body {profile}），返回写入后的画像 */
profileRouter.put('/', requireAuth, (req, res) => {
  const parsed = profileSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: parsed.error.issues[0]?.message ?? '请求参数错误：需要 profile 对象' });
    return;
  }
  const userId = req.user!.id;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO memories (user_id, profile, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at`
    )
    .run(userId, JSON.stringify(parsed.data.profile), now, now);
  res.json({ profile: parsed.data.profile });
});
