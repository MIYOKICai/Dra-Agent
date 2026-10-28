/**
 * 设置持久化（data/settings.json）：设置页对服务商的可视化修改
 * （API Key / Base URL / 模型清单 / 默认模型 / 新建自定义服务商）落盘于此，
 * .env 仅作首次默认值。启动时合并进 config.providers（适配器持有配置对象引用，
 * 修改实时生效）；保存由设置路由在每次变更后调用。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appConfig, providers, type ProviderConfig } from './config';
import { registerAdapter, unregisterAdapter } from './providers';
import type { ModelInfo } from '../../shared/types';

/** 内置服务商 id：不可删除，仅可修改配置 */
export const BUILTIN_PROVIDER_IDS = new Set(['deepseek', 'ark', 'zhipu', 'custom', 'mock']);

/** 服务商可修改字段的落盘结构（apiKey 用 null 显式表示「清除密钥」） */
export interface ProviderPatch {
  name?: string;
  baseUrl?: string;
  apiKey?: string | null;
  chatModel?: string | null;
  imageModel?: string | null;
  embeddingModel?: string | null;
  models?: ModelInfo[];
}

interface SettingsFile {
  /** 内置服务商被用户修改过的字段（与 .env 基线做差量） */
  overrides: Record<string, ProviderPatch>;
  /** 设置页新建的自定义服务商全量配置 */
  extra: ProviderConfig[];
}

const settingsPath = path.resolve(appConfig.settingsPath);

/** .env 基线快照：保存时做差量，未改动的字段继续跟随 .env */
const envBaseline: Record<string, ProviderConfig> = {};

/** 启动时调用：先拍 .env 基线，再合并落盘的用户修改 */
export function initProviderSettings(): void {
  for (const [id, cfg] of Object.entries(providers)) {
    envBaseline[id] = JSON.parse(JSON.stringify(cfg)) as ProviderConfig;
  }
  if (!existsSync(settingsPath)) return;
  try {
    const file = JSON.parse(readFileSync(settingsPath, 'utf8')) as SettingsFile;
    for (const [id, patch] of Object.entries(file.overrides ?? {})) {
      const target = providers[id];
      if (!target) continue;
      if (patch.name) target.name = patch.name;
      if (patch.baseUrl !== undefined) target.baseUrl = patch.baseUrl;
      if (patch.apiKey !== undefined) target.apiKey = patch.apiKey || undefined;
      if (patch.chatModel !== undefined) target.chatModel = patch.chatModel || undefined;
      if (patch.imageModel !== undefined) target.imageModel = patch.imageModel || undefined;
      if (patch.embeddingModel !== undefined) target.embeddingModel = patch.embeddingModel || undefined;
      if (Array.isArray(patch.models)) target.models = patch.models;
    }
    for (const cfg of file.extra ?? []) {
      if (!cfg?.id || providers[cfg.id]) continue;
      providers[cfg.id] = cfg;
      registerAdapter(cfg);
    }
  } catch (err) {
    console.error('[settings] settings.json 读取失败，使用 .env 默认配置:', err);
  }
}

/** 每次设置变更后调用：内置做差量、自定义存全量，写回 settings.json */
export function saveProviderSettings(): void {
  const overrides: Record<string, ProviderPatch> = {};
  for (const id of BUILTIN_PROVIDER_IDS) {
    const cur = providers[id];
    const base = envBaseline[id];
    if (!cur || !base) continue;
    const patch: ProviderPatch = {};
    if (cur.name !== base.name) patch.name = cur.name;
    if (cur.baseUrl !== base.baseUrl) patch.baseUrl = cur.baseUrl;
    if ((cur.apiKey ?? null) !== (base.apiKey ?? null)) patch.apiKey = cur.apiKey ?? null;
    if ((cur.chatModel ?? null) !== (base.chatModel ?? null)) patch.chatModel = cur.chatModel ?? null;
    if ((cur.imageModel ?? null) !== (base.imageModel ?? null)) patch.imageModel = cur.imageModel ?? null;
    if ((cur.embeddingModel ?? null) !== (base.embeddingModel ?? null))
      patch.embeddingModel = cur.embeddingModel ?? null;
    if (JSON.stringify(cur.models) !== JSON.stringify(base.models)) patch.models = cur.models;
    if (Object.keys(patch).length > 0) overrides[id] = patch;
  }
  const extra: ProviderConfig[] = Object.values(providers).filter(
    (p) => !BUILTIN_PROVIDER_IDS.has(p.id)
  );
  try {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ overrides, extra }, null, 2), 'utf8');
  } catch (err) {
    console.error('[settings] settings.json 写入失败:', err);
    throw err;
  }
}

/** 移除自定义服务商（设置页删除动作） */
export function removeExtraProvider(id: string): boolean {
  if (BUILTIN_PROVIDER_IDS.has(id) || !providers[id]) return false;
  delete providers[id];
  unregisterAdapter(id);
  saveProviderSettings();
  return true;
}
