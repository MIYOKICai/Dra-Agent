/**
 * 用户个性化设置路由（/api/user-settings）：user_settings.data JSON 的读写。
 * - 全部路由挂 requireAuth，仅读写 req.user.id 本人数据
 * - apiKey 类字段（键名以 apiKey 结尾，忽略大小写与 -/_ 分隔符）以 AES-256-GCM 密文落库：
 *   GET 解密后打码回传（与 /api/settings 的 apiKeyMasked 风格一致）；
 *   PUT 收到与 GET 打码值一致的字符串时保留原密文（客户端回传打码 key 不会覆盖真实密钥）
 * - 服务商密钥解析（平台密钥优先）见 providerKeys.ts 的 resolveProviderKey
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection';
import { requireAuth } from '../middleware/auth';
import { buildMaskedDataView, sealUserData } from '../providerKeys';

export const userSettingsRouter = Router();

const dataSchema = z.object({
  data: z.record(z.string(), z.unknown()),
});

interface UserSettingsRow {
  user_id: string;
  data: string | null;
  created_at: string;
  updated_at: string;
}

function loadRow(userId: string): UserSettingsRow | undefined {
  return getDb()
    .prepare('SELECT * FROM user_settings WHERE user_id = ?')
    .get(userId) as UserSettingsRow | undefined;
}

/** GET /api/user-settings：当前用户设置（apiKey 类字段打码，无数据返回空对象），响应 { data } */
userSettingsRouter.get('/', requireAuth, (req, res) => {
  const row = loadRow(req.user!.id);
  res.json({ data: buildMaskedDataView(row?.data ?? null) });
});

/** PUT /api/user-settings：整体覆盖保存（body {data}），apiKey 字段加密落库后返回打码视图 */
userSettingsRouter.put('/', requireAuth, (req, res) => {
  const parsed = dataSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: parsed.error.issues[0]?.message ?? '请求参数错误：需要 data 对象' });
    return;
  }
  const userId = req.user!.id;
  const existing = loadRow(userId);
  const sealed = sealUserData(parsed.data.data, existing?.data ?? null);
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO user_settings (user_id, data, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    )
    .run(userId, sealed, now, now);
  res.json({ data: buildMaskedDataView(sealed) });
});
