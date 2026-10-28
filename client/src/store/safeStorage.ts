/**
 * localStorage 安全壳：吞掉读写可能抛出的异常，避免 zustand persist 崩溃。
 * 典型场景：QuotaExceededError——持久化数据超过浏览器 ~5MB 配额时，
 * 原生 setItem 抛错会直接打断 React 渲染（白屏）；包装后降级为一次性告警，
 * 本次状态仍在内存中，页面内功能不受影响。
 * 若 localStorage 本身不可用（隐私模式 / 禁用存储），降级为内存 Map：会话内可用，刷新即失。
 */
const memory = new Map<string, string>();
const warnedKeys = new Set<string>();

/** 探测 localStorage 是否真实可用（存在属性 ≠ 可写，隐私模式下 setItem 会抛错） */
function probeAvailable(): boolean {
  try {
    const probeKey = '__storage_probe__';
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

let available: boolean | null = null;

function warnOnce(key: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(
    `[storage] localStorage 写入「${key}」失败（可能超出浏览器存储配额），本次修改仅当前页面生效，刷新后将回退到上次成功保存的内容`
  );
}

export const safeLocalStorage: Storage = {
  get length(): number {
    return available ? window.localStorage.length : memory.size;
  },
  clear(): void {
    if (available) window.localStorage.clear();
    else memory.clear();
  },
  getItem(key: string): string | null {
    if (available) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    }
    return memory.get(key) ?? null;
  },
  key(index: number): string | null {
    if (available) {
      try {
        return window.localStorage.key(index);
      } catch {
        return null;
      }
    }
    return [...memory.keys()][index] ?? null;
  },
  removeItem(key: string): void {
    if (available) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // 忽略
      }
    }
    memory.delete(key);
  },
  setItem(key: string, value: string): void {
    if (available) {
      try {
        window.localStorage.setItem(key, value);
        return;
      } catch {
        warnOnce(key);
        return;
      }
    }
    memory.set(key, value);
  },
};

/** 在模块加载时探测一次（SSR / 测试环境下 window 可能不存在，一律走内存兜底） */
export function initSafeStorage(): void {
  try {
    available = typeof window !== 'undefined' ? probeAvailable() : false;
  } catch {
    available = false;
  }
}

initSafeStorage();
