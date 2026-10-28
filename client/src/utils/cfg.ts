/**
 * 节点 config 读取辅助：全部带默认值兜底，保证读出字段类型安全。
 * config 来自 localStorage 持久化 / 导入 JSON，可能缺字段或类型不符。
 */

/** 读取基本类型字段（string / number / boolean），类型不符或缺失时返回默认值 */
export function cfg<T extends string | number | boolean>(
  config: Record<string, unknown> | undefined,
  key: string,
  fallback: T
): T {
  const value = config?.[key];
  return typeof value === typeof fallback ? (value as T) : fallback;
}

/** 数值字段读取后夹取到 [min, max]，避免历史数据越界 */
export function cfgClamped(
  config: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  const value = cfg(config, key, fallback);
  return Math.min(max, Math.max(min, value));
}

/** 读取字符串数组字段（如 agent.tools），非字符串数组时返回默认值 */
export function cfgStringArray(
  config: Record<string, unknown> | undefined,
  key: string,
  fallback: string[]
): string[] {
  const value = config?.[key];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value as string[];
  }
  return fallback;
}
