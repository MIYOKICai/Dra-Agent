/**
 * 云数据访问层：用户数据（画布 / 会话 / 消息 / 画像 / 个人设置）的类型化 API。
 * - 全部经 gateway 的 authedFetch 发出（自动注入 Bearer / 401 静默刷新重放 / 403 封禁广播）
 * - 非成功响应统一抛 CloudApiError（带 status，供调用方区分重试 / 冲突 / 未同步）；
 *   画布 PUT 的 409 乐观锁冲突抛 CloudConflictError（携带服务端 currentUpdatedAt）
 */
import { API_BASE } from './client';
import { authedFetch, readError } from './gateway';

/** 云 API 错误：携带 HTTP 状态码（404=目标不存在、409=冲突等） */
export class CloudApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'CloudApiError';
    this.status = status;
  }
}

/** 画布乐观锁冲突（PUT /api/canvases/:id → 409），携带服务端当前 updatedAt */
export class CloudConflictError extends CloudApiError {
  currentUpdatedAt: string;
  constructor(message: string, currentUpdatedAt: string) {
    super(message, 409);
    this.name = 'CloudConflictError';
    this.currentUpdatedAt = currentUpdatedAt;
  }
}

async function expectJson<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) throw new CloudApiError(await readError(res, fallback), res.status);
  return (await res.json()) as T;
}

/* =============== 画布（/api/canvases） =============== */

/** 画布列表条目（不含 data 正文，缩略图概览用） */
export interface CloudCanvasListItem {
  id: string;
  name: string | null;
  thumbnail: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 画布完整形态（含 data 正文：{ name, nodes, edges } 序列化对象） */
export interface CloudCanvas extends CloudCanvasListItem {
  data: unknown;
}

export interface CreateCanvasInput {
  name: string;
  /** 画布内容（{ name, nodes, edges }），服务端兼容对象 / 字符串 */
  data?: unknown;
  thumbnail?: string | null;
}

export interface UpdateCanvasInput {
  name?: string;
  data?: unknown;
  thumbnail?: string | null;
  /** 乐观锁：必须与服务端当前 updatedAt 一致，否则 409 */
  updatedAt: string;
}

/** GET /api/canvases：当前用户画布列表（不含 data，按更新时间倒序） */
export async function listCanvases(signal?: AbortSignal): Promise<CloudCanvasListItem[]> {
  const res = await authedFetch(`${API_BASE}/canvases`, { signal });
  const data = await expectJson<{ canvases: CloudCanvasListItem[] }>(res, '获取画布列表失败');
  return Array.isArray(data.canvases) ? data.canvases : [];
}

/** POST /api/canvases：创建画布，返回完整画布（201） */
export async function createCloudCanvas(input: CreateCanvasInput, signal?: AbortSignal): Promise<CloudCanvas> {
  const res = await authedFetch(`${API_BASE}/canvases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  const data = await expectJson<{ canvas: CloudCanvas }>(res, '创建画布失败');
  return data.canvas;
}

/** GET /api/canvases/:id：画布详情（含 data） */
export async function getCloudCanvas(id: string, signal?: AbortSignal): Promise<CloudCanvas> {
  const res = await authedFetch(`${API_BASE}/canvases/${encodeURIComponent(id)}`, { signal });
  const data = await expectJson<{ canvas: CloudCanvas }>(res, '读取画布失败');
  return data.canvas;
}

/**
 * PUT /api/canvases/:id：更新画布（乐观锁）。
 * 409（已在其他设备被修改）抛 CloudConflictError（currentUpdatedAt 为服务端最新值）。
 */
export async function updateCloudCanvas(
  id: string,
  input: UpdateCanvasInput,
  signal?: AbortSignal
): Promise<CloudCanvas> {
  const res = await authedFetch(`${API_BASE}/canvases/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { currentUpdatedAt?: unknown } | null;
    throw new CloudConflictError(
      await readError(res, '画布已在其他设备被修改'),
      typeof body?.currentUpdatedAt === 'string' ? body.currentUpdatedAt : new Date().toISOString()
    );
  }
  const data = await expectJson<{ canvas: CloudCanvas }>(res, '保存画布失败');
  return data.canvas;
}

/** DELETE /api/canvases/:id：删除画布 */
export async function deleteCloudCanvas(id: string, signal?: AbortSignal): Promise<void> {
  const res = await authedFetch(`${API_BASE}/canvases/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    signal,
  });
  await expectJson<{ ok: boolean }>(res, '删除画布失败');
}

/* =============== 会话与消息（/api/sessions） =============== */

/** 会话（服务端附带 createdAtMs / updatedAtMs 兼容字段：ms 数值） */
export interface CloudSession {
  id: string;
  scope: string;
  title: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  createdAtMs: number;
  updatedAtMs: number;
  messageCount?: number;
}

/** 消息（服务端从 meta 提平 steps / usage / time，对齐 client CreationMessage） */
export interface CloudMessage {
  id: string;
  sessionId: string;
  role: string | null;
  content: string | null;
  meta: Record<string, unknown> | null;
  seq: number;
  createdAt: string;
  steps?: unknown;
  usage?: unknown;
  time?: number;
}

export interface AppendMessageInput {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** steps / usage / time 均入 meta（服务端读取时提平） */
  meta?: Record<string, unknown>;
  /** 缺省取服务端当前最大 seq + 1；冲突返回 409 */
  seq?: number;
}

export interface ListSessionsOptions {
  limit?: number;
  cursor?: string | null;
  signal?: AbortSignal;
}

/** GET /api/sessions?scope=&limit=&cursor=：会话列表（游标分页，updated_at 倒序） */
export async function listCloudSessions(
  scope: string,
  options: ListSessionsOptions = {}
): Promise<{ sessions: CloudSession[]; nextCursor: string | null; hasMore: boolean }> {
  const params = new URLSearchParams({ scope });
  if (options.limit) params.set('limit', String(options.limit));
  if (options.cursor) params.set('cursor', options.cursor);
  const res = await authedFetch(`${API_BASE}/sessions?${params.toString()}`, {
    signal: options.signal,
  });
  const data = await expectJson<{
    sessions: CloudSession[];
    nextCursor: string | null;
    hasMore: boolean;
  }>(res, '获取会话列表失败');
  return {
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    nextCursor: data.nextCursor ?? null,
    hasMore: Boolean(data.hasMore),
  };
}

/** POST /api/sessions {scope, title?}：创建会话（服务端生成 id，201） */
export async function createCloudSession(
  scope: string,
  title?: string,
  signal?: AbortSignal
): Promise<CloudSession> {
  const res = await authedFetch(`${API_BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, ...(title ? { title } : {}) }),
    signal,
  });
  const data = await expectJson<{ session: CloudSession }>(res, '创建会话失败');
  return data.session;
}

/** PUT /api/sessions/:id {title?, summary?}：更新会话标题 / 摘要 */
export async function updateCloudSession(
  id: string,
  patch: { title?: string; summary?: string },
  signal?: AbortSignal
): Promise<CloudSession> {
  const res = await authedFetch(`${API_BASE}/sessions/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    signal,
  });
  const data = await expectJson<{ session: CloudSession }>(res, '更新会话失败');
  return data.session;
}

/** DELETE /api/sessions/:id：删除会话（消息级联删除） */
export async function deleteCloudSession(id: string, signal?: AbortSignal): Promise<void> {
  const res = await authedFetch(`${API_BASE}/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    signal,
  });
  await expectJson<{ ok: boolean }>(res, '删除会话失败');
}

export interface ListMessagesOptions {
  limit?: number;
  /** 取该序号更早的一页；null / 缺省 = 取最新一页 */
  beforeSeq?: number | null;
  signal?: AbortSignal;
}

/** GET /api/sessions/:id/messages：消息分页（页内按 seq 正序） */
export async function listCloudMessages(
  sessionId: string,
  options: ListMessagesOptions = {}
): Promise<{ messages: CloudMessage[]; nextBeforeSeq: number | null; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', String(options.limit));
  if (options.beforeSeq !== null && options.beforeSeq !== undefined) {
    params.set('beforeSeq', String(options.beforeSeq));
  }
  const qs = params.toString();
  const res = await authedFetch(
    `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`,
    { signal: options.signal }
  );
  const data = await expectJson<{
    messages: CloudMessage[];
    nextBeforeSeq: number | null;
    hasMore: boolean;
  }>(res, '读取消息失败');
  return {
    messages: Array.isArray(data.messages) ? data.messages : [],
    nextBeforeSeq: data.nextBeforeSeq ?? null,
    hasMore: Boolean(data.hasMore),
  };
}

/** POST /api/sessions/:id/messages：追加消息（seq 冲突 409） */
export async function appendCloudMessage(
  sessionId: string,
  input: AppendMessageInput,
  signal?: AbortSignal
): Promise<CloudMessage> {
  const res = await authedFetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  const data = await expectJson<{ message: CloudMessage }>(res, '保存消息失败');
  return data.message;
}

/* =============== 用户画像（/api/profile） =============== */

/** GET /api/profile：当前用户长期画像（无则 {}） */
export async function fetchProfile(signal?: AbortSignal): Promise<Record<string, unknown>> {
  const res = await authedFetch(`${API_BASE}/profile`, { signal });
  const data = await expectJson<{ profile: Record<string, unknown> }>(res, '读取用户画像失败');
  return data.profile ?? {};
}

/** PUT /api/profile：覆盖式保存画像，返回写入后的画像 */
export async function saveProfile(
  profile: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const res = await authedFetch(`${API_BASE}/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile }),
    signal,
  });
  const data = await expectJson<{ profile: Record<string, unknown> }>(res, '保存用户画像失败');
  return data.profile ?? {};
}

/* =============== 用户个性化设置（/api/user-settings） =============== */

/**
 * GET /api/user-settings：当前用户设置（apiKey 类字段打码返回；无数据 = {}）。
 * 打码 apiKey 原样传回 PUT 时服务端保留原密文（不覆盖语义）。
 */
export async function fetchUserSettings(signal?: AbortSignal): Promise<Record<string, unknown>> {
  const res = await authedFetch(`${API_BASE}/user-settings`, { signal });
  const data = await expectJson<{ data: Record<string, unknown> }>(res, '读取用户设置失败');
  return data.data ?? {};
}

/** PUT /api/user-settings：整体覆盖保存（body {data}），返回打码视图 */
export async function saveUserSettings(
  data: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const res = await authedFetch(`${API_BASE}/user-settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
    signal,
  });
  const out = await expectJson<{ data: Record<string, unknown> }>(res, '保存用户设置失败');
  return out.data ?? {};
}
