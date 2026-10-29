/**
 * 渲染层持久化统一出口：localStorage 安全壳 + 桌面端加密保险库。
 *
 * 安全壳：吞掉读写可能抛出的异常，避免 zustand persist 崩溃。典型场景：
 * QuotaExceededError——持久化数据超过浏览器 ~5MB 配额时，原生 setItem 抛错
 * 会直接打断 React 渲染（白屏）；包装后降级为一次性告警，本次状态仍在内存中。
 * 若 localStorage 本身不可用（隐私模式 / 禁用存储），降级为内存 Map。
 *
 * 加密保险库（桌面端）：Electron 下页面加载自 http://127.0.0.1:<动态端口>/，
 * localStorage 按「源」分区——server 自愈换端口后源变化，之前保存的画布 /
 * 工作区会整体「消失」。因此桌面端经 preload 的 draStore 桥，把同一份数据
 * 加密落到主进程专属数据文件夹（userData/data/appstore，DPAPI / AES-256-GCM），
 * 与端口无关；启动时拉回并镜像进 localStorage，localStorage 仅作同步缓存。
 * 纯浏览器环境（npm run dev 直开 Vite）无 draStore 桥，行为与从前一致。
 */

/* ---------- 桥类型（由 electron/preload.cjs 注入，浏览器环境不存在） ---------- */

interface DraStoreBridge {
  /** 启动引导：一次拉取全部键值（已解密） */
  loadAll: () => Promise<Record<string, string>>;
  /** 写入并加密落盘 */
  set: (key: string, value: string) => Promise<boolean>;
  /** 删除 */
  remove: (key: string) => Promise<boolean>;
}

declare global {
  interface Window {
    draStore?: DraStoreBridge;
  }
}

/* ---------- 保险库状态 ---------- */

const vault = new Map<string, string>();
let vaultBridge: DraStoreBridge | null = null;
let vaultReady = false;

/** 写穿透到保险库（异步，不阻塞 UI；失败仅告警——localStorage 镜像仍在） */
function pushToVault(key: string, value: string): void {
  if (!vaultBridge) return;
  vaultBridge
    .set(key, value)
    .then((ok) => {
      if (!ok) console.warn(`[storage] 保险库写入「${key}」失败，本次仅 localStorage 缓存生效`);
    })
    .catch(() => undefined);
}

/**
 * 启动引导：必须在任何 store 模块求值前 await（zustand persist 同步水合
 * 依赖 getItem 已拿到保险库数据）。main.tsx 已用动态 import 门控。
 */
export async function initDraVault(): Promise<void> {
  if (typeof window === 'undefined') return;
  const bridge = window.draStore;
  if (!bridge) return; // 纯浏览器：维持 localStorage 单层持久化
  vaultBridge = bridge;
  try {
    const saved = await bridge.loadAll();
    for (const [key, value] of Object.entries(saved)) vault.set(key, value);
  } catch (err) {
    console.warn('[storage] 保险库读取失败，本会话回退 localStorage', err);
  }
  // 迁移：本源 localStorage 里保险库还没有的键 → 升级进保险库（老版本首次升级路径）
  if (available) {
    try {
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (!key || key === '__storage_probe__' || vault.has(key)) continue;
        const value = window.localStorage.getItem(key);
        if (value != null) {
          vault.set(key, value);
          pushToVault(key, value);
        }
      }
    } catch {
      // 迁移失败不阻断启动
    }
  }
  // 镜像回 localStorage：同步读取路径（zustand persist 水合 / 直读）拿到保险库数据
  if (available) {
    for (const [key, value] of vault) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // 配额超限：getItem 路径仍会命中 vault 内存
      }
    }
  }
  vaultReady = true;
}

/* ---------- localStorage 安全壳 ---------- */

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
    // 保险库没有清空 IPC：逐键删除
    if (vaultBridge) {
      for (const key of [...vault.keys()]) {
        vault.delete(key);
        vaultBridge.remove(key).catch(() => undefined);
      }
    }
  },
  getItem(key: string): string | null {
    // 保险库优先：跨端口 / 跨源一致（localStorage 只是本源缓存镜像）
    if (vaultReady && vault.has(key)) return vault.get(key) ?? null;
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
    if (vaultReady && vaultBridge && vault.delete(key)) {
      vaultBridge.remove(key).catch(() => undefined);
    }
  },
  setItem(key: string, value: string): void {
    if (available) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        warnOnce(key);
      }
    } else {
      memory.set(key, value);
    }
    if (vaultReady) {
      vault.set(key, value);
      pushToVault(key, value);
    }
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
