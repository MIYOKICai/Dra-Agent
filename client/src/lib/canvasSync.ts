/**
 * 画布云同步层：workspaceStore / canvasStore ↔ /api/canvases 之间的桥。
 * - 本地 persist（agent-workspace-v1 / agent-canvas-v1）保持现状，作为写穿缓存；
 *   云端为主存储
 * - 画布 id 以本地 id 为权威（不改 workspaceStore 调用方），localId→cloudId 映射
 *   持久化到 localStorage；从云端拉取的画布直接以云端 id 作为本地 id
 * - 内容保存：订阅 canvasStore（节点 / 连线 / 名称）+ workspaceStore（清单）变化 →
 *   800ms 尾沿防抖 → create-or-update（PUT 带乐观锁 updatedAt）；409 冲突时拉取
 *   服务端版本覆盖本地并 toast「已在其他设备修改，已加载最新」
 * - 新建 / 删除 / 重命名：订阅 workspaceStore 清单 diff 驱动（store 本身零改动）：
 *   新建条目不立即 POST（空画布不上云），首次内容防抖保存时 create-or-update；
 *   删除 / 重命名直接走 API
 */
import { useAuthStore } from '../store/authStore';
import { safeLocalStorage } from '../store/safeStorage';
import {
  DEFAULT_WORKFLOW_NAME,
  stripRunState,
  useCanvasStore,
  type CanvasEdge,
  type CanvasNode,
} from '../store/canvasStore';
import { useUiStore } from '../store/uiStore';
import { useWorkspaceStore, type CanvasEntry } from '../store/workspaceStore';
import {
  CloudApiError,
  CloudConflictError,
  createCloudCanvas,
  deleteCloudCanvas,
  getCloudCanvas,
  listCanvases,
  updateCloudCanvas,
  type CloudCanvas,
} from '../api/cloud';

const MAP_KEY = 'agent-canvas-idmap-v1';

interface CanvasMapEntry {
  cloudId: string;
  /** 最近一次已知的云端 updated_at（乐观锁基线） */
  serverUpdatedAt: string;
}

function loadIdMap(): Record<string, CanvasMapEntry> {
  try {
    const raw = safeLocalStorage.getItem(MAP_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, CanvasMapEntry>;
    }
  } catch {
    // 数据损坏：按空处理（重复上传幂等）
  }
  return {};
}

const idMap = loadIdMap();
const saveIdMap = (): void => {
  try {
    safeLocalStorage.setItem(MAP_KEY, JSON.stringify(idMap));
  } catch {
    // 配额超限：静默（映射丢失仅导致重复上传，不影响本地使用）
  }
};

/** 画布内容在 API data 字段中的形状 */
interface CanvasPayload {
  name: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

function packContent(name: string, nodes: CanvasNode[], edges: CanvasEdge[]): CanvasPayload {
  return { name, nodes: stripRunState(nodes), edges };
}

/** 解析云端 data：对象形态 { name?, nodes?, edges? }；损坏 / 缺失回退空画布 */
function parseContent(data: unknown, fallbackName: string): CanvasPayload {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const o = data as Record<string, unknown>;
    return {
      name: typeof o.name === 'string' && o.name ? o.name : fallbackName,
      nodes: Array.isArray(o.nodes) ? (o.nodes as CanvasNode[]) : [],
      edges: Array.isArray(o.edges) ? (o.edges as CanvasEdge[]) : [],
    };
  }
  return { name: fallbackName, nodes: [], edges: [] };
}

/** 未动过的默认空画布不上云（ensureInit 兜底产物；编辑后由内容防抖保存正常上云） */
function isBlankDefault(entry: CanvasEntry): boolean {
  return entry.nodes.length === 0 && entry.edges.length === 0 && entry.name === DEFAULT_WORKFLOW_NAME;
}

const authed = (): boolean => Boolean(useAuthStore.getState().accessToken);

/* =============== 启动同步（登录后调用一次） =============== */

let started = false;

/**
 * 登录后首次同步：云端列表为主合并入列（本地没有的拉详情插入），
 * 再把本地独有（无映射、非空默认）画布幂等上传。失败保持本地模式，
 * 后续内容保存动作会自然重试（create-or-update）。
 */
export async function startCanvasSync(): Promise<void> {
  console.log('[SYNC-DBG] startCanvasSync enter, started=', started);
  if (started) return;
  if (!authed()) {
    console.log('[SYNC-DBG] not authed, bail');
    return;
  }
  started = true;
  try {
    const remote = await listCanvases();
    console.log('[SYNC-DBG] listCanvases ok, remote=', remote.length);
    const ws = useWorkspaceStore.getState();
    const additions: CanvasEntry[] = [];
    for (const item of remote) {
      const localHit = ws.canvases.find((c) => c.id === item.id || idMap[c.id]?.cloudId === item.id);
      console.log('[SYNC-DBG] item', item.id.slice(0, 8), 'localHit=', Boolean(localHit));
      if (localHit) {
        if (!idMap[localHit.id]) idMap[localHit.id] = { cloudId: item.id, serverUpdatedAt: item.updatedAt };
        continue;
      }
      const full: CloudCanvas = await getCloudCanvas(item.id);
      console.log('[SYNC-DBG] detail ok', item.id.slice(0, 8));
      const content = parseContent(full.data, full.name ?? '未命名画布');
      idMap[item.id] = { cloudId: item.id, serverUpdatedAt: full.updatedAt };
      additions.push({
        id: item.id,
        name: content.name,
        nodes: content.nodes,
        edges: content.edges,
        updatedAt: Date.parse(full.updatedAt) || Date.now(),
      });
    }
    saveIdMap();
    if (additions.length > 0) {
      useWorkspaceStore.setState({
        canvases: [...additions, ...useWorkspaceStore.getState().canvases],
      });
    }
    await importLocalCanvases();
    console.log('[SYNC-DBG] importLocalCanvases done, calling startAutoSave');
  } catch (err) {
    console.warn('[canvasSync] 云端画布加载失败，保持本地模式', err);
    started = false; // 允许下次登录周期重试
  }
  startAutoSave();
  console.log('[SYNC-DBG] startAutoSave returned');
}

/** 登出后重置（换账号重新拉取；映射 / 差量基线幂等） */
export function resetCanvasSync(): void {
  started = false;
}

/**
 * 本地独有（无映射）画布幂等上传：导入向导与启动同步共用。
 * 已同步条目跳过；空默认画布跳过（不产生云端垃圾）。
 */
export async function importLocalCanvases(
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  if (!authed()) return;
  const pending = useWorkspaceStore
    .getState()
    .canvases.filter((c) => !idMap[c.id] && !isBlankDefault(c));
  const total = pending.length;
  let done = 0;
  for (const entry of pending) {
    try {
      const created = await createCloudCanvas({
        name: entry.name,
        data: packContent(entry.name, entry.nodes, entry.edges),
      });
      idMap[entry.id] = { cloudId: created.id, serverUpdatedAt: created.updatedAt };
      saveIdMap();
    } catch (err) {
      console.warn('[canvasSync] 画布上传失败（保留本地，下次重试）', entry.name, err);
    }
    done += 1;
    onProgress?.(done, total);
  }
}

/** 举报入口用：本地画布对应的云端 id（未上云返回 null） */
export function getCloudCanvasId(localId: string): string | null {
  return idMap[localId]?.cloudId ?? null;
}

/* =============== 内容防抖保存（800ms 尾沿） =============== */

const SAVE_DEBOUNCE_MS = 800;
let saveTimer: number | null = null;

function scheduleSave(): void {
  console.log('[SYNC-DBG] scheduleSave fired, authed=', authed());
  if (!authed()) return;
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    console.log('[SYNC-DBG] debounce fired, calling saveActiveCanvas');
    void saveActiveCanvas();
  }, SAVE_DEBOUNCE_MS);
}

/**
 * 保存当前画布（activeId 条目 ↔ canvasStore 内容）。
 * 引用比较判定内容归属：切换画布时 hydrate 用条目自身引用载入，此时相等 → 跳过，
 * 避免把 A 画布内容 PUT 到 B 画布；用户编辑产生新数组引用后才真正保存。
 */
async function saveActiveCanvas(): Promise<void> {
  const ws = useWorkspaceStore.getState();
  const entry = ws.canvases.find((c) => c.id === ws.activeId);
  console.log('[SYNC-DBG] saveActiveCanvas entry=', Boolean(entry));
  if (!entry) return;
  const cs = useCanvasStore.getState();
  if (entry.nodes === cs.nodes && entry.edges === cs.edges && entry.name === cs.name) {
    console.log('[SYNC-DBG] saveActiveCanvas skip (refs equal)');
    return;
  }
  const payload = packContent(cs.name, cs.nodes, cs.edges);
  const mapped = idMap[entry.id];
  try {
    if (!mapped) {
      // 未上云（含空默认画布刚被编辑过）：创建
      const created = await createCloudCanvas({ name: cs.name, data: payload });
      idMap[entry.id] = { cloudId: created.id, serverUpdatedAt: created.updatedAt };
      saveIdMap();
    } else {
      const updated = await updateCloudCanvas(mapped.cloudId, {
        data: payload,
        updatedAt: mapped.serverUpdatedAt,
      });
      idMap[entry.id] = { cloudId: mapped.cloudId, serverUpdatedAt: updated.updatedAt };
      saveIdMap();
    }
    // 快照回写清单条目（引用对齐 → 无后续编辑不再重复保存；与 switchCanvas 回写同语义）
    useWorkspaceStore.setState({
      canvases: useWorkspaceStore.getState().canvases.map((c) =>
        c.id === entry.id ? { ...c, nodes: cs.nodes, edges: cs.edges, name: cs.name, updatedAt: Date.now() } : c
      ),
    });
  } catch (err) {
    if (err instanceof CloudConflictError && mapped) {
      await overwriteFromCloud(entry.id, mapped.cloudId);
      return;
    }
    console.warn('[canvasSync] 画布保存失败（本地缓存可用，停顿后重试）', err);
  }
}

/** 409 冲突：采信服务端版本，覆盖本地条目与当前画布（若冲突画布正打开） */
async function overwriteFromCloud(localId: string, cloudId: string): Promise<void> {
  try {
    const full = await getCloudCanvas(cloudId);
    const content = parseContent(full.data, full.name ?? '未命名画布');
    idMap[localId] = { cloudId, serverUpdatedAt: full.updatedAt };
    saveIdMap();
    const ws = useWorkspaceStore.getState();
    useWorkspaceStore.setState({
      canvases: ws.canvases.map((c) =>
        c.id === localId
          ? {
              ...c,
              name: content.name,
              nodes: content.nodes,
              edges: content.edges,
              updatedAt: Date.parse(full.updatedAt) || Date.now(),
            }
          : c
      ),
    });
    if (ws.activeId === localId) {
      useCanvasStore.getState().hydrateCanvas(content.nodes, content.edges, content.name);
    }
    useUiStore.getState().showToast('已在其他设备修改，已加载最新');
  } catch (err) {
    console.warn('[canvasSync] 冲突后拉取服务端版本失败，保留本地', err);
  }
}

/* =============== 清单 diff（新建 / 删除 / 重命名） =============== */

let autoSaveStarted = false;
let prevSnapshot: { id: string; name: string }[] = [];

function snapshotCanvases(): { id: string; name: string }[] {
  return useWorkspaceStore.getState().canvases.map((c) => ({ id: c.id, name: c.name }));
}

function diffWorkspace(): void {
  const next = snapshotCanvases();
  const prev = prevSnapshot;
  prevSnapshot = next;
  if (!authed()) return;
  // 删除：云端级联（本地未上云则无事可做）
  for (const p of prev) {
    if (next.some((n) => n.id === p.id)) continue;
    const mapped = idMap[p.id];
    delete idMap[p.id];
    saveIdMap();
    if (!mapped) continue;
    void deleteCloudCanvas(mapped.cloudId).catch((err: unknown) => {
      if (err instanceof CloudApiError && err.status === 404) return;
      console.warn('[canvasSync] 云端画布删除失败（本地已删，云端残留待重试）', err);
    });
  }
  // 重命名：名称变化且条目仍存在 → PUT name（乐观锁；409 采信服务端不覆盖本地名称，
  // 仅刷新基线，避免「重命名被静默回滚」的困惑——下次内容保存会再带名称）
  for (const n of next) {
    const old = prev.find((p) => p.id === n.id);
    if (!old || old.name === n.name) continue;
    const mapped = idMap[n.id];
    if (!mapped) continue;
    void updateCloudCanvas(mapped.cloudId, { name: n.name, updatedAt: mapped.serverUpdatedAt })
      .then((updated) => {
        idMap[n.id] = { cloudId: mapped.cloudId, serverUpdatedAt: updated.updatedAt };
        saveIdMap();
      })
      .catch((err: unknown) => {
        if (err instanceof CloudConflictError) {
          idMap[n.id] = { cloudId: mapped.cloudId, serverUpdatedAt: err.currentUpdatedAt };
          saveIdMap();
          return;
        }
        console.warn('[canvasSync] 画布重命名同步失败（下次内容保存重试）', err);
      });
  }
}

function startAutoSave(): void {
  if (autoSaveStarted || typeof window === 'undefined') return;
  autoSaveStarted = true;
  prevSnapshot = snapshotCanvases();
  useCanvasStore.subscribe(scheduleSave);
  useWorkspaceStore.subscribe(diffWorkspace);
}
