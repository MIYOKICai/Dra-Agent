/**
 * 设置路由（/api/settings）：服务商能力管理（需登录；密钥部分按用户隔离）。
 * - GET  /                    全部服务商配置视图（生效密钥打码返回，不出明文）
 * - PUT  /providers/:id       修改服务商（baseUrl / 模型清单 / 默认模型 → 平台全局）；
 *                             apiKey 一律写入当前用户的 user_settings（AES-256-GCM 加密落库）
 * - POST /providers           新建自定义服务商（OpenAI 兼容）；apiKey 同样按用户存储
 * - DELETE /providers/:id     删除自定义服务商（内置不可删）
 *
 * 密钥存储融合（商业化改造）：/api/settings 保留「平台/服务商能力探测」语义，
 * 但用户密钥不再落入全局 data/settings.json 明文文件，而是经 providerKeys.sealUserData
 * 加密写入 user_settings 表（与 /api/user-settings 同一存储）；调用链经
 * providers/index.ts 的 getAdapterForUser 解析（平台密钥 → 用户自有密钥 → .env 基线）。
 * 每次非密钥字段变更仍即时写盘 settings.json 并影响网关路由（适配器持配置引用）。
 */
import { Router, type Request } from 'express';
import { providers, type ProviderConfig } from '../config';
import { registerAdapter } from '../providers';
import {
  BUILTIN_PROVIDER_IDS,
  removeExtraProvider,
  saveProviderSettings,
  type ProviderPatch,
} from '../settingsConfig';
import { getDb } from '../db/connection';
import { buildMaskedDataView, maskSecretKey, resolveProviderKey, sealUserData } from '../providerKeys';

export const settingsRouter = Router();

/** 当前登录用户 id（requireAuth 在挂载点统一注入） */
function uid(req: Request): string {
  return req.user?.id ?? '';
}

/* ============ 用户密钥存取（user_settings 表，与 /api/user-settings 同源） ============ */

/** 读取当前用户 user_settings 的原始密文 JSON（无记录返回 null） */
function loadUserSettingsText(userId: string): string | null {
  const row = getDb()
    .prepare('SELECT data FROM user_settings WHERE user_id = ?')
    .get(userId) as { data: string | null } | undefined;
  return row?.data ?? null;
}

/** 覆盖写回当前用户 user_settings（落库前已经 sealUserData 加密） */
function saveUserSettingsText(userId: string, sealedText: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO user_settings (user_id, data, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    )
    .run(userId, sealedText, now, now);
}

/** 用户密钥在 user_settings.data 中的布局：data.providers.<providerId>.apiKey（resolveProviderKey 支持的嵌套形态） */
function storeUserProviderKey(userId: string, providerId: string, apiKey: string | null): void {
  const storedText = loadUserSettingsText(userId);
  // 以打码视图为基底改写目标键，再交 sealUserData 重新加密（其余 apiKey 字段的打码值会保留原密文）
  const masked = buildMaskedDataView(storedText) as Record<string, unknown>;
  const providersNode = (() => {
    const node = masked.providers;
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      return node as Record<string, unknown>;
    }
    const created: Record<string, unknown> = {};
    masked.providers = created;
    return created;
  })();
  const entry = (() => {
    const node = providersNode[providerId];
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      return node as Record<string, unknown>;
    }
    const created: Record<string, unknown> = {};
    providersNode[providerId] = created;
    return created;
  })();
  entry.apiKey = apiKey; // null/''=清除；明文=加密落库；与打码值一致=保留原密文（sealUserData 判定）
  saveUserSettingsText(userId, sealUserData(masked, storedText));
}

/** 当前用户在指定服务商上的生效密钥：平台密钥（DB）→ 用户自有密钥 → .env 基线 */
function effectiveProviderKey(userId: string, id: string): string | undefined {
  return resolveProviderKey(userId, id) ?? providers[id]?.apiKey;
}

/* ============ 服务商配置视图（密钥打码） ============ */

/** 服务商配置视图（生效密钥不回传明文，仅打码提示） */
function toView(id: string, userId: string) {
  const p = providers[id];
  const key = effectiveProviderKey(userId, id);
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKeyMasked: key ? maskSecretKey(key) : null,
    chatModel: p.chatModel ?? null,
    imageModel: p.imageModel ?? null,
    embeddingModel: p.embeddingModel ?? null,
    models: p.models,
    builtin: BUILTIN_PROVIDER_IDS.has(p.id),
  };
}

settingsRouter.get('/', (req, res) => {
  const userId = uid(req);
  res.json({ providers: Object.keys(providers).map((id) => toView(id, userId)) });
});

/** 逐字段应用修改（不含 apiKey）：undefined=不修改，null=清除 */
function applyPatch(target: ProviderConfig, patch: Record<string, unknown>): void {
  if (typeof patch.name === 'string' && patch.name.trim()) target.name = patch.name.trim();
  if (patch.baseUrl !== undefined) target.baseUrl = String(patch.baseUrl ?? '').trim();
  if (patch.chatModel !== undefined) target.chatModel = patch.chatModel ? String(patch.chatModel).trim() : undefined;
  if (patch.imageModel !== undefined) target.imageModel = patch.imageModel ? String(patch.imageModel).trim() : undefined;
  if (patch.embeddingModel !== undefined)
    target.embeddingModel = patch.embeddingModel ? String(patch.embeddingModel).trim() : undefined;
  if (Array.isArray(patch.models)) {
    target.models = (patch.models as ProviderConfig['models']).filter(
      (m) => m && typeof m.id === 'string' && m.id.trim()
    );
  }
}

/**
 * 处理 PUT 请求中的 apiKey 字段 → 当前用户 user_settings：
 * - null / ''：清除该用户的密钥
 * - 与当前生效密钥打码一致的字符串：视为未修改（客户端回传打码 key 不会覆盖真实密钥）
 * - 其余字符串：作为新明文加密落库
 */
function handleUserApiKey(req: Request, providerId: string, apiKey: unknown): void {
  if (apiKey === undefined) return;
  const userId = uid(req);
  if (apiKey === null || (typeof apiKey === 'string' && !apiKey.trim())) {
    storeUserProviderKey(userId, providerId, null);
    return;
  }
  if (typeof apiKey === 'string') {
    const incoming = apiKey.trim();
    const current = effectiveProviderKey(userId, providerId);
    if (current && maskSecretKey(current) === incoming) return; // 打码值回传：未修改
    storeUserProviderKey(userId, providerId, incoming);
  }
}

settingsRouter.put('/providers/:id', (req, res) => {
  const { id } = req.params;
  const target = providers[id];
  if (!target) {
    res.status(404).json({ ok: false, error: '服务商不存在' });
    return;
  }
  if (id === 'mock') {
    res.status(400).json({ ok: false, error: '演示模式无需配置' });
    return;
  }
  const patch = (req.body ?? {}) as Record<string, unknown>;
  handleUserApiKey(req, id, patch.apiKey);
  applyPatch(target, patch);
  try {
    saveProviderSettings();
  } catch {
    res.status(500).json({ ok: false, error: '设置写入失败' });
    return;
  }
  res.json({ ok: true, provider: toView(id, uid(req)) });
});

settingsRouter.post('/providers', (req, res) => {
  const body = (req.body ?? {}) as {
    name?: unknown;
    baseUrl?: unknown;
    apiKey?: unknown;
    models?: unknown;
  };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
  if (!name || !baseUrl) {
    res.status(400).json({ error: '名称与 Base URL 为必填项' });
    return;
  }
  let id = `custom-${Date.now().toString(36)}`;
  while (providers[id]) id = `custom-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
  const cfg: ProviderConfig = {
    id,
    name,
    baseUrl,
    // 密钥按用户存储于 user_settings（加密），全局配置仅保留 baseUrl / 模型清单
    models: Array.isArray(body.models)
      ? (body.models as ProviderConfig['models']).filter(
          (m) => m && typeof m.id === 'string' && m.id.trim()
        )
      : [],
  };
  providers[id] = cfg;
  registerAdapter(cfg);
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    storeUserProviderKey(uid(req), id, body.apiKey.trim());
  }
  try {
    saveProviderSettings();
  } catch {
    delete providers[id];
    res.status(500).json({ ok: false, error: '设置写入失败' });
    return;
  }
  res.json({ ok: true, provider: toView(id, uid(req)) });
});

settingsRouter.delete('/providers/:id', (req, res) => {
  const { id } = req.params;
  if (BUILTIN_PROVIDER_IDS.has(id)) {
    res.status(400).json({ ok: false, error: '内置服务商不可删除' });
    return;
  }
  if (!removeExtraProvider(id)) {
    res.status(404).json({ error: '服务商不存在' });
    return;
  }
  res.json({ ok: true });
});

export type { ProviderPatch };
