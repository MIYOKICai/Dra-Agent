/**
 * 「一键创作」对话会话存储（生成模式）：
 * - 数据主存储为云端 /api/sessions（scope='creation'）；localStorage persist
 *   `agent-creation-sessions-v1` 保留为写穿缓存（读时 API 失败回退缓存）
 * - 写路径：upsert / remove / rename 保持同步更新本地 state（调用方签名不变），
 *   内部 fire-and-forget 云同步（按会话串行队列；失败静默，待下次动作重试）
 * - 会话 id 以本地 id 为权威：本地预生成的会话经 localId→cloudId 映射上云
 *   （服务端 POST 自行生成 uuid，不支持指定 id），映射与已同步消息数持久化到
 *   localStorage；从云端拉取的会话直接以云端 id 作为本地 id
 * - 流式回答期间不写盘，仅在回答结束/中止后统一落盘（同旧版约定）
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ToolRisk } from '@shared/types';
import { safeLocalStorage } from '../store/safeStorage';
import { useAuthStore } from '../store/authStore';
import {
  CloudApiError,
  appendCloudMessage,
  createCloudSession,
  deleteCloudSession,
  listCloudMessages,
  listCloudSessions,
  updateCloudSession,
  type CloudMessage,
  type CloudSession,
} from '../api/cloud';

/** 助手消息的工具过程步骤（随消息持久化，回看时以单行 chip 呈现） */
export interface CreationStep {
  kind: 'tool_call' | 'tool_result' | 'notice';
  /** kind 为 tool_call / tool_result 时的工具名；notice 无 */
  tool?: string;
  /** 调用=参数摘要；结果=结果摘要（截断）；notice=过程说明 */
  content: string;
  /** 仅 tool_call：风险分级（write 黄点 / danger 红点徽标） */
  risk?: ToolRisk;
  /** 仅 tool_result：执行是否成功 */
  ok?: boolean;
}

/** 对话消息（创作会话内仅用户 / 助手两种角色） */
export interface CreationMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 助手消息的 ReAct 工具调用过程（可选） */
  steps?: CreationStep[];
  /** 助手消息完成时间戳（流式结束后写入；回看操作行的时间显示） */
  time?: number;
  /** 助手消息 token 用量（上游返回时才有；操作行「用量」显示） */
  usage?: { promptTokens: number; completionTokens: number };
  /** 云端消息 id（上云后回填；举报入口定位云端目标用，本地新消息在上云前为空） */
  cloudId?: string;
}

/** 一次「生成」模式的创作对话 */
export interface CreationSession {
  id: string;
  /** 标题取自首条用户消息（截断） */
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: CreationMessage[];
  /** 长对话压缩摘要（服务端 LLM 生成，覆盖到 summaryAt 条消息为止） */
  summary?: string;
  /** 摘要覆盖到的消息条数（客户端据此决定是否要求服务端整体重摘） */
  summaryAt?: number;
}

/** 会话上云的 scope（服务端为自由字符串，直接沿用业务命名空间） */
const CLOUD_SCOPE = 'creation';
/** localId → cloudId 映射持久化键 */
const IDMAP_KEY = 'agent-session-idmap-v1';
/** 已同步消息条数（差量追加依据）持久化键 */
const SYNCED_KEY = 'agent-session-synced-v1';

function loadMap(key: string): Record<string, number> | Record<string, string> {
  try {
    const raw = safeLocalStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, never>;
    }
  } catch {
    // 数据损坏：按空处理
  }
  return {};
}

/** localId → cloudId（云端会话 id） */
const idMap = loadMap(IDMAP_KEY) as Record<string, string>;
/** 每个本地会话已同步到云端的消息条数（差量追加） */
const syncedCounts = loadMap(SYNCED_KEY) as Record<string, number>;

function persistMap(key: string, value: Record<string, unknown>): void {
  try {
    safeLocalStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 配额超限：静默（映射丢失仅导致重复上传，不影响本地使用）
  }
}

const saveIdMap = (): void => persistMap(IDMAP_KEY, idMap);
const saveSynced = (): void => persistMap(SYNCED_KEY, syncedCounts);

/** CreationMessage → 云端 meta（steps / usage / time 全部入 meta，服务端读取时提平） */
function toMeta(m: CreationMessage): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (m.steps) meta.steps = m.steps;
  if (m.usage) meta.usage = m.usage;
  if (m.time) meta.time = m.time;
  return meta;
}

function isUsage(v: unknown): v is { promptTokens: number; completionTokens: number } {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.promptTokens === 'number' && typeof o.completionTokens === 'number';
}

/** 云端消息 → CreationMessage（role 收敛为 user / assistant；steps / usage / time 提平回填） */
function toCreationMessage(m: CloudMessage): CreationMessage {
  const msg: CreationMessage = {
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content ?? '',
    cloudId: m.id,
  };
  if (Array.isArray(m.steps)) msg.steps = m.steps as CreationStep[];
  if (isUsage(m.usage)) msg.usage = m.usage;
  if (typeof m.time === 'number') msg.time = m.time;
  return msg;
}

interface CreationSessionsState {
  sessions: CreationSession[];
  /** 新增或更新会话（按 updatedAt 置顶）；内部 fire-and-forget 云同步 */
  upsert: (session: CreationSession) => void;
  /** 移除会话（首字前失败/中止时清掉刚预创建的会话，避免列表残留无回答的空壳） */
  remove: (id: string) => void;
  /** 重命名会话标题（空输入忽略，保持原标题；不改变列表排序） */
  rename: (id: string, title: string) => void;
  /** 登录后从云端拉取会话列表并入列（本地已有/已映射的跳过；幂等）。
      API 失败静默回退 localStorage 缓存（persist 水合值即回退数据） */
  hydrateFromCloud: () => Promise<void>;
  /** 把本地尚未上云的会话批量上传（导入向导用；逐会话 POST + 消息逐条追加；幂等） */
  uploadAllToCloud: (onProgress?: (done: number, total: number) => void) => Promise<void>;
}

export const useCreationSessions = create<CreationSessionsState>()(
  persist(
    (set, get) => ({
      sessions: [],
      upsert: (session) => {
        set({
          sessions: [session, ...get().sessions.filter((s) => s.id !== session.id)],
        });
        void enqueueSync(session.id);
      },
      remove: (id) => {
        set({
          sessions: get().sessions.filter((s) => s.id !== id),
        });
        // 与同会话的进行中同步共用一条队列，保证「先传后删」按序执行
        void enqueueSync(id);
      },
      rename: (id, title) => {
        const t = title.trim();
        if (!t) return;
        set({
          sessions: get().sessions.map((s) => (s.id === id ? { ...s, title: t } : s)),
        });
        void enqueueSync(id);
      },

      hydrateFromCloud: async () => {
        await hydrate();
      },

      uploadAllToCloud: async (onProgress) => {
        const pending = get().sessions.filter((s) => !idMap[s.id]);
        const total = pending.length;
        let done = 0;
        for (const s of pending) {
          await enqueueSync(s.id);
          done += 1;
          onProgress?.(done, total);
        }
      },
    }),
    {
      name: 'agent-creation-sessions-v1',
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (s) => ({ sessions: s.sessions }),
    }
  )
);

/* =============== 云同步（模块级，store 动作内 fire-and-forget） =============== */

/** 每会话串行队列：同一会话的创建 / 差量追加 / 删除严格按触发顺序执行 */
const chains = new Map<string, Promise<void>>();

function enqueueSync(id: string): Promise<void> {
  const prev = chains.get(id) ?? Promise.resolve();
  const next = prev.then(() => syncSession(id), () => syncSession(id));
  chains.set(id, next.catch(() => undefined));
  return next;
}

/** 云端不存在则创建（POST）+ 差量追加末尾新消息；已存在则 PUT title/summary + 差量追加。
 *  会话已被删除时转为云端删除。任何失败静默（syncedCounts 不推进，下次动作重试） */
async function syncSession(id: string): Promise<void> {
  if (!useAuthStore.getState().accessToken) return;
  const session = useCreationSessions.getState().sessions.find((s) => s.id === id);
  const cloudId = idMap[id];
  // 会话已从本地删除：云端存在则级联删除（本地从未上云则无事可做）
  if (!session) {
    if (!cloudId) return;
    try {
      await deleteCloudSession(cloudId);
    } catch (err) {
      if (!(err instanceof CloudApiError && err.status === 404)) {
        console.warn('[creationSessions] 云端会话删除失败（本地已删，云端残留待重试）', err);
        return; // 保留映射，下次同 id 动作重试
      }
    }
    delete idMap[id];
    delete syncedCounts[id];
    saveIdMap();
    saveSynced();
    return;
  }
  try {
    let targetId = cloudId;
    if (!targetId) {
      const created = await createCloudSession(CLOUD_SCOPE, session.title || '未命名对话');
      targetId = created.id;
      idMap[id] = targetId;
      syncedCounts[id] = syncedCounts[id] ?? 0;
      saveIdMap();
    } else {
      await updateCloudSession(targetId, {
        title: session.title || '未命名对话',
        ...(session.summary ? { summary: session.summary } : {}),
      });
    }
    // 差量追加：仅上送 syncedCounts 之后的新消息（seq = 数组下标 + 1，重试幂等）
    const from = syncedCounts[id] ?? 0;
    for (let i = from; i < session.messages.length; i += 1) {
      const m = session.messages[i];
      try {
        const saved = await appendCloudMessage(targetId, {
          role: m.role,
          content: m.content,
          seq: i + 1,
          meta: toMeta(m),
        });
        // 回填云端消息 id（举报入口定位云端目标）；直接改 state 不再触发同步
        useCreationSessions.setState({
          sessions: useCreationSessions.getState().sessions.map((s) =>
            s.id === id
              ? { ...s, messages: s.messages.map((mm, idx) => (idx === i ? { ...mm, cloudId: saved.id } : mm)) }
              : s
          ),
        });
      } catch (err) {
        // 409 = 该 seq 已存在（重试场景），视为已同步
        if (!(err instanceof CloudApiError && err.status === 409)) throw err;
      }
      syncedCounts[id] = i + 1;
    }
    saveSynced();
  } catch (err) {
    console.warn('[creationSessions] 会话云同步失败（本地缓存可用，下次动作重试）', err);
  }
}

/** 拉取一个云端会话的全部消息（beforeSeq 游标翻页直到取完，页内 seq 正序） */
async function fetchAllMessages(sessionId: string): Promise<CreationMessage[]> {
  const out: CreationMessage[] = [];
  let beforeSeq: number | null = null;
  for (;;) {
    const page = await listCloudMessages(sessionId, { limit: 200, beforeSeq });
    for (const m of page.messages) out.push(toCreationMessage(m));
    if (!page.hasMore || page.nextBeforeSeq === null) break;
    beforeSeq = page.nextBeforeSeq;
  }
  return out;
}

/** 登录周期内只拉取一次（失败时允许重试） */
let hydrateStarted = false;

async function hydrate(): Promise<void> {
  if (hydrateStarted) return;
  if (!useAuthStore.getState().accessToken) return;
  hydrateStarted = true;
  try {
    let cursor: string | null = null;
    const remote: CloudSession[] = [];
    do {
      const page = await listCloudSessions(CLOUD_SCOPE, { limit: 200, cursor });
      remote.push(...page.sessions);
      cursor = page.hasMore ? page.nextCursor : null;
    } while (cursor);
    const local = useCreationSessions.getState().sessions;
    const additions: CreationSession[] = [];
    for (const cs of remote) {
      const existing = local.find((s) => s.id === cs.id || idMap[s.id] === cs.id);
      if (existing) {
        // 本地已有（持久化恢复 / 映射命中）：补齐映射与差量基线，不重复入列
        if (!idMap[existing.id]) idMap[existing.id] = cs.id;
        if (syncedCounts[existing.id] === undefined) syncedCounts[existing.id] = existing.messages.length;
        continue;
      }
      const messages = await fetchAllMessages(cs.id);
      idMap[cs.id] = cs.id;
      syncedCounts[cs.id] = messages.length;
      additions.push({
        id: cs.id,
        title: cs.title || '未命名对话',
        createdAt: Number.isFinite(cs.createdAtMs) ? cs.createdAtMs : Date.now(),
        updatedAt: Number.isFinite(cs.updatedAtMs) ? cs.updatedAtMs : Date.now(),
        messages,
        ...(cs.summary ? { summary: cs.summary } : {}),
      });
    }
    saveIdMap();
    saveSynced();
    if (additions.length > 0) {
      useCreationSessions.setState({
        sessions: [...additions, ...useCreationSessions.getState().sessions],
      });
    }
  } catch (err) {
    console.warn('[creationSessions] 云端会话加载失败，使用本地缓存', err);
    hydrateStarted = false; // 允许下次登录周期 / 手动重试
  }
}

/** 登出后重置拉取标记（换账号重新拉取；映射与差量基线幂等可复用） */
export function resetSessionsCloudSync(): void {
  hydrateStarted = false;
}

/** 由首条用户消息派生会话标题（压平空白后截断 20 字） */
export function deriveSessionTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 20 ? `${t.slice(0, 20)}…` : t;
}

/** 会话 id 生成（与画布 store 同款兜底策略） */
export function newSessionId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 粗略 token 估算（中英混合约 2.5 字符/token），仅用于历史消息缺真实 usage 时的展示回填 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

/**
 * 历史消息元数据回填：用量/时间功能上线前的助手消息没有 time / usage 落盘，
 * 载入会话时补齐展示数据（不改持久化）——用量按正文长度估算；
 * 时间从会话 updatedAt 起按固定步长向历史倒推，已有真实时间的消息保持不变。
 * 用户消息缺 time（时间戳功能前发送）：取其后第一条已具时间助手消息的时间
 * （发送必然早于回复），其后无助手消息时沿用会话 updatedAt。
 */
export function backfillMessageMeta(
  messages: CreationMessage[],
  updatedAt?: number
): CreationMessage[] {
  let cursor = updatedAt ?? Date.now();
  return messages.map((m, idx) => {
    if (m.role === 'user') {
      if (m.time) return m;
      for (let j = idx + 1; j < messages.length; j++) {
        if (messages[j].role === 'assistant' && messages[j].time) {
          return { ...m, time: messages[j].time };
        }
      }
      return { ...m, time: cursor };
    }
    if (m.role !== 'assistant') return m;
    let next = m;
    if (!next.time) {
      next = { ...next, time: cursor };
      cursor -= 45_000;
    } else {
      cursor = Math.min(cursor, next.time);
    }
    if (!next.usage) {
      next = {
        ...next,
        usage: { promptTokens: 0, completionTokens: estimateTokens(next.content) },
      };
    }
    return next;
  });
}
