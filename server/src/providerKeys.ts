/**
 * 服务商 API Key 的存取与解析（用户上云数据 + 平台密钥）：
 * - user_settings.data 中 apiKey 类字段统一以 AES-256-GCM 密文（encryptSecret 产物 JSON）落库
 * - GET 回传前解密并打码（与 routes/settings.ts 的 apiKeyMasked 风格一致）；
 *   PUT 收到与打码值一致的字符串时保留原密文（客户端回传打码 key 不会覆盖真实密钥）
 * - resolveProviderKey(userId, provider)：平台密钥（platform_keys 表）优先，用户自有密钥回退，
 *   供 Task 5/6 的 chat / image 网关接线使用
 */
import { decryptSecret, encryptSecret } from './crypto';
import { getDb } from './db/connection';

/** 打码规则：与 settings.ts 一致（≤8 位全打码，否则前 4 后 4 中间星号） */
export function maskSecretKey(key: string): string {
  return key.length <= 8 ? '••••' : `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

/** 判断 JSON 键是否为 apiKey 类字段（apiKey / deepseekApiKey / api_key / ark-api-key 等） */
export function isSecretKeyName(key: string): boolean {
  return key.replace(/[-_]/g, '').toLowerCase().endsWith('apikey');
}

/**
 * 递归遍历 JSON 数据，对每个 apiKey 类字段应用 fn 并就地替换（对象 / 数组均下钻）。
 * path 为点号路径（如 providers.deepseek.apiKey），供 PUT 时按路径比对旧值。
 */
function walkSecrets(
  node: unknown,
  fn: (value: unknown, path: string) => unknown,
  path = ''
): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkSecrets(item, fn, path ? `${path}[${i}]` : `[${i}]`));
    return;
  }
  if (!node || typeof node !== 'object') {
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    const p = path ? `${path}.${key}` : key;
    if (isSecretKeyName(key)) {
      obj[key] = fn(value, p);
    } else {
      walkSecrets(value, fn, p);
    }
  }
}

/** 密文树中全部 apiKey 字段：路径 → { cipher 原密文, plain 解密明文 }（解密失败项跳过） */
function collectSecretPaths(
  storedText: string | null
): Map<string, { cipher: string; plain: string }> {
  const out = new Map<string, { cipher: string; plain: string }>();
  if (!storedText) {
    return out;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(storedText);
  } catch {
    return out;
  }
  walkSecrets(parsed, (value, path) => {
    if (typeof value === 'string' && value) {
      try {
        out.set(path, { cipher: value, plain: decryptSecret(value) });
      } catch {
        // 损坏密文：视为不存在，落库时按新明文重新加密
      }
    }
    return value;
  });
  return out;
}

/** 生成 GET 回传的打码视图：apiKey 字段解密后替换为打码值（损坏密文返回全星号占位） */
export function buildMaskedDataView(dataText: string | null): Record<string, unknown> {
  if (!dataText) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataText);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  walkSecrets(parsed, (value) => {
    if (typeof value !== 'string' || !value) {
      return value;
    }
    try {
      return maskSecretKey(decryptSecret(value));
    } catch {
      return '••••';
    }
  });
  return parsed as Record<string, unknown>;
}

/**
 * 将客户端提交的 data 转为落库密文 JSON：
 * - apiKey 字段：null / 空串视为清除（存 null）；与旧值打码一致的字符串保留原密文；其余加密
 * - 非字符串值原样保留
 */
export function sealUserData(incoming: unknown, storedText: string | null): string {
  const data = (incoming && typeof incoming === 'object' && !Array.isArray(incoming)
    ? incoming
    : {}) as Record<string, unknown>;
  const olds = collectSecretPaths(storedText);
  walkSecrets(data, (value, path) => {
    if (value === null) {
      return null;
    }
    if (typeof value !== 'string') {
      return value;
    }
    if (!value) {
      return null;
    }
    const old = olds.get(path);
    if (old && maskSecretKey(old.plain) === value) {
      return old.cipher;
    }
    return encryptSecret(value);
  });
  return JSON.stringify(data);
}

/**
 * 解析某用户调用某服务商应使用的 API Key：平台密钥（platform_keys）优先，用户自有密钥回退。
 * 用户自有密钥支持三种布局：data.providers.<id>.apiKey / data.<id>.apiKey / data.<id>ApiKey。
 * 找不到或解密失败返回 undefined（调用方自行决定降级行为）。
 */
export function resolveProviderKey(userId: string, provider: string): string | undefined {
  const db = getDb();
  const platform = db
    .prepare('SELECT encrypted FROM platform_keys WHERE provider = ?')
    .get(provider) as { encrypted: string } | undefined;
  if (platform) {
    try {
      return decryptSecret(platform.encrypted);
    } catch {
      console.warn(`[dra-agent-providerKeys] 平台密钥解密失败（provider=${provider}），回退用户自有密钥`);
    }
  }
  const row = db
    .prepare('SELECT data FROM user_settings WHERE user_id = ?')
    .get(userId) as { data: string | null } | undefined;
  if (!row?.data) {
    return undefined;
  }
  let root: unknown;
  try {
    root = JSON.parse(row.data);
  } catch {
    return undefined;
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    return undefined;
  }
  const obj = root as Record<string, unknown>;
  const candidates: unknown[] = [];
  const nested = obj.providers;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const entry = (nested as Record<string, unknown>)[provider];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      candidates.push((entry as Record<string, unknown>).apiKey);
    }
  }
  const direct = obj[provider];
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    candidates.push((direct as Record<string, unknown>).apiKey);
  }
  candidates.push(obj[`${provider}ApiKey`]);
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) {
      try {
        return decryptSecret(candidate);
      } catch {
        // 该项损坏：尝试下一个候选
      }
    }
  }
  return undefined;
}
