import type { ProviderAdapter } from './base';
import { OpenAICompatProvider } from './base';
import { ArkProvider } from './ark';
import { CustomProvider } from './custom';
import { DeepSeekProvider } from './deepseek';
import { MockProvider } from './mock';
import { ZhipuProvider } from './zhipu';
import type { ProviderConfig } from '../config';
import { resolveProviderKey } from '../providerKeys';

/** /api/models 中的内置服务商展示顺序 */
export const PROVIDER_ORDER = ['deepseek', 'ark', 'zhipu', 'custom', 'mock'] as const;

/** 内置服务商适配器（跟随 config.providers 的同名配置对象，设置页修改实时生效） */
const instances: Record<string, ProviderAdapter> = {
  deepseek: new DeepSeekProvider(),
  ark: new ArkProvider(),
  zhipu: new ZhipuProvider(),
  custom: new CustomProvider(),
  mock: new MockProvider(),
};

/** 设置页新建的自定义服务商适配器（OpenAI 兼容，与内置适配器并列参与路由） */
const dynamicAdapters: Record<string, ProviderAdapter> = {};

/** 注册设置页新建的自定义服务商 */
export function registerAdapter(cfg: ProviderConfig): void {
  dynamicAdapters[cfg.id] = new OpenAICompatProvider(cfg);
}

/** 注销自定义服务商适配器（删除服务商时调用） */
export function unregisterAdapter(id: string): void {
  delete dynamicAdapters[id];
}

/** 按 id 获取适配器（内置优先，其后设置页新建的自定义服务商） */
export function getAdapter(id: string): ProviderAdapter | undefined {
  return instances[id] ?? dynamicAdapters[id];
}

/**
 * 按用户获取适配器：resolveProviderKey 命中（平台密钥优先，用户自有密钥回退）时
 * 派生一个带该密钥的临时适配器（不影响共享实例）；未命中返回共享实例（继续走 .env 密钥）。
 * chat / image / embeddings / test 等按用户取用服务商的入口统一经此取适配器。
 */
export function getAdapterForUser(id: string, userId: string): ProviderAdapter | undefined {
  const base = getAdapter(id);
  if (!base || !(base instanceof OpenAICompatProvider)) {
    return base; // mock 等无密钥适配器直接返回
  }
  const key = resolveProviderKey(userId, id);
  return key ? base.withApiKey(key) : base;
}

/** 按展示顺序获取全部适配器：内置在前，自定义按创建顺序追加 */
export function listAdapters(): ProviderAdapter[] {
  return [...PROVIDER_ORDER.map((id) => instances[id]), ...Object.values(dynamicAdapters)];
}

export type { ProviderAdapter };
