/**
 * 设置路由（/api/settings）：设置页的服务商可视化管理。
 * - GET  /                    全部服务商配置视图（apiKey 打码返回）
 * - PUT  /providers/:id       修改服务商（apiKey / baseUrl / 模型清单 / 默认模型）
 * - POST /providers           新建自定义服务商（OpenAI 兼容）
 * - DELETE /providers/:id     删除自定义服务商（内置不可删）
 * 每次变更即时写盘（data/settings.json）并影响网关路由（适配器持配置引用）。
 */
import { Router } from 'express';
import { providers, type ProviderConfig } from '../config';
import { registerAdapter } from '../providers';
import { BUILTIN_PROVIDER_IDS, removeExtraProvider, saveProviderSettings, type ProviderPatch } from '../settingsConfig';

export const settingsRouter = Router();

/** 服务商配置视图（apiKey 不回传明文，仅打码提示） */
function toView(id: string) {
  const p = providers[id];
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKeyMasked: p.apiKey
      ? p.apiKey.length <= 8
        ? '••••'
        : `${p.apiKey.slice(0, 4)}••••${p.apiKey.slice(-4)}`
      : null,
    chatModel: p.chatModel ?? null,
    imageModel: p.imageModel ?? null,
    embeddingModel: p.embeddingModel ?? null,
    models: p.models,
    builtin: BUILTIN_PROVIDER_IDS.has(p.id),
  };
}

settingsRouter.get('/', (_req, res) => {
  res.json({ providers: Object.keys(providers).map(toView) });
});

/** 逐字段应用修改：undefined=不修改，null=清除 */
function applyPatch(target: ProviderConfig, patch: Record<string, unknown>): void {
  if (typeof patch.name === 'string' && patch.name.trim()) target.name = patch.name.trim();
  if (patch.baseUrl !== undefined) target.baseUrl = String(patch.baseUrl ?? '').trim();
  if (patch.apiKey !== undefined) target.apiKey = patch.apiKey ? String(patch.apiKey).trim() : undefined;
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
  applyPatch(target, req.body ?? {});
  try {
    saveProviderSettings();
  } catch {
    res.status(500).json({ ok: false, error: '设置写入失败' });
    return;
  }
  res.json({ ok: true, provider: toView(id) });
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
    res.status(400).json({ ok: false, error: '名称与 Base URL 为必填项' });
    return;
  }
  let id = `custom-${Date.now().toString(36)}`;
  while (providers[id]) id = `custom-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
  const cfg: ProviderConfig = {
    id,
    name,
    baseUrl,
    apiKey: typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : undefined,
    models: Array.isArray(body.models)
      ? (body.models as ProviderConfig['models']).filter(
          (m) => m && typeof m.id === 'string' && m.id.trim()
        )
      : [],
  };
  providers[id] = cfg;
  registerAdapter(cfg);
  try {
    saveProviderSettings();
  } catch {
    delete providers[id];
    res.status(500).json({ ok: false, error: '设置写入失败' });
    return;
  }
  res.json({ ok: true, provider: toView(id) });
});

settingsRouter.delete('/providers/:id', (req, res) => {
  const { id } = req.params;
  if (BUILTIN_PROVIDER_IDS.has(id)) {
    res.status(400).json({ ok: false, error: '内置服务商不可删除' });
    return;
  }
  if (!removeExtraProvider(id)) {
    res.status(404).json({ ok: false, error: '服务商不存在' });
    return;
  }
  res.json({ ok: true });
});

export type { ProviderPatch };
