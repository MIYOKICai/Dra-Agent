/**
 * 网关 API 客户端：封装 client ↔ server 网关的全部接口。
 * - streamChat：fetch + ReadableStream 手动解析 SSE（server 每个事件一行 `data: {json}`）
 * - 其余接口为普通 JSON 请求；HTTP / 网络错误尽量转为可读的 Error 或 error 事件
 */
import type {
  ChatRequest,
  FileMeta,
  ImageRequest,
  KBInfoEx,
  KBQAMessage,
  KBSearchResult,
  ModelInfo,
  ModelsResponse,
  SSEEvent,
  ToolExecutionResult,
  ToolSchema,
} from '@shared/types';
import { API_BASE, parseSSELine } from './client';

/* =============== 模型设置页（/api/settings） =============== */

/** 服务商配置视图（apiKey 打码，前端不接触明文密钥） */
export interface ProviderSettingsItem {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyMasked: string | null;
  chatModel: string | null;
  imageModel: string | null;
  embeddingModel: string | null;
  models: ModelInfo[];
  /** 内置服务商不可删除 */
  builtin: boolean;
}

/** 服务商可修改字段（apiKey=null 清除密钥） */
export interface ProviderPatch {
  name?: string;
  baseUrl?: string;
  apiKey?: string | null;
  chatModel?: string | null;
  imageModel?: string | null;
  embeddingModel?: string | null;
  models?: ModelInfo[];
}

export async function fetchProviderSettings(signal?: AbortSignal): Promise<ProviderSettingsItem[]> {
  const res = await fetch(`${API_BASE}/settings`, { signal });
  if (!res.ok) throw new Error(await readError(res, '读取模型设置失败'));
  const data = (await res.json()) as { providers: ProviderSettingsItem[] };
  return data.providers;
}

export async function updateProvider(id: string, patch: ProviderPatch): Promise<ProviderSettingsItem> {
  const res = await fetch(`${API_BASE}/settings/providers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await readError(res, '保存设置失败'));
  const data = (await res.json()) as { provider: ProviderSettingsItem };
  return data.provider;
}

export async function createProvider(body: {
  name: string;
  baseUrl: string;
  apiKey?: string;
  models?: ModelInfo[];
}): Promise<ProviderSettingsItem> {
  const res = await fetch(`${API_BASE}/settings/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res, '新建服务商失败'));
  const data = (await res.json()) as { provider: ProviderSettingsItem };
  return data.provider;
}

export async function deleteProvider(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/settings/providers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(await readError(res, '删除服务商失败'));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 调用方主动 abort（AbortController）视为正常取消，不算错误 */
function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** 从非 2xx 响应体中提取可读错误信息（server 约定 { error } 或 { blocked, hits }） */
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const json = (await res.json()) as { error?: unknown; blocked?: unknown; hits?: unknown };
    if (typeof json.error === 'string' && json.error) return json.error;
    if (json.blocked === true && Array.isArray(json.hits)) {
      return `内容命中敏感词：${json.hits.join('、')}`;
    }
  } catch {
    // 响应体不是 JSON，忽略
  }
  return `${fallback}（HTTP ${res.status}）`;
}

/** GET /api/models：服务商与模型清单（含可用性） */
export async function fetchModels(signal?: AbortSignal): Promise<ModelsResponse> {
  const res = await fetch(`${API_BASE}/models`, { signal });
  if (!res.ok) {
    throw new Error(`获取模型列表失败（HTTP ${res.status}）`);
  }
  const data = (await res.json()) as ModelsResponse;
  if (!data || !Array.isArray(data.providers)) {
    throw new Error('模型列表响应格式错误');
  }
  return data;
}

export interface ChatStreamHandlers {
  /** 每解析出一个完整 SSE 事件回调一次 */
  onEvent: (event: SSEEvent) => void;
}

/**
 * POST /api/chat：流式对话（SSE）。
 * 手动解析：ReadableStream → 文本 buffer 按 \n 切分 → 忽略心跳空行与非 data 行 →
 * `data: ` 前缀去掉后 JSON.parse，逐事件回调。
 * 网络 / HTTP 错误统一转 error 事件，调用方只需处理 SSEEvent；
 * signal 主动中断视为正常取消，不追加事件。
 */
export async function streamChat(
  req: ChatRequest,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  const emit = (event: SSEEvent): void => handlers.onEvent(event);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal,
    });
  } catch (err) {
    if (!isAbort(err)) {
      emit({ type: 'error', message: `连接网关失败：${errorMessage(err)}` });
    }
    return;
  }
  if (!res.ok || !res.body) {
    emit({ type: 'error', message: await readError(res, '对话请求失败') });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const dispatchLine = (line: string): void => {
    const event = parseSSELine(line);
    if (event) emit(event);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        dispatchLine(line);
      }
    }
    // 流结束后的残余内容（无换行结尾的最后一行）
    if (buffer.trim()) dispatchLine(buffer);
  } catch (err) {
    if (!isAbort(err)) {
      emit({ type: 'error', message: `流式读取中断：${errorMessage(err)}` });
    }
  }
}

/** POST /api/image：图像生成，返回（url / dataURL）列表 */
export async function generateImage(
  req: ImageRequest,
  signal?: AbortSignal
): Promise<string[]> {
  const res = await fetch(`${API_BASE}/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok) {
    throw new Error(await readError(res, '图像生成失败'));
  }
  const data = (await res.json()) as { images?: unknown };
  if (!Array.isArray(data.images)) {
    throw new Error('图像响应格式错误：缺少 images 数组');
  }
  return data.images.filter((item): item is string => typeof item === 'string');
}

export interface TestProviderResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

/** POST /api/test/:provider：连通性探测（server 返回 { ok, latencyMs, error? }） */
export async function testProvider(
  providerId: string,
  signal?: AbortSignal
): Promise<TestProviderResult> {
  try {
    const res = await fetch(`${API_BASE}/test/${encodeURIComponent(providerId)}`, {
      method: 'POST',
      signal,
    });
    const data = (await res.json().catch(() => null)) as Partial<TestProviderResult> | null;
    if (data && typeof data.ok === 'boolean') {
      return { ok: data.ok, latencyMs: data.latencyMs, error: data.error };
    }
    return { ok: false, error: `探测失败（HTTP ${res.status}）` };
  } catch (err) {
    if (isAbort(err)) return { ok: false, error: '已取消' };
    return { ok: false, error: errorMessage(err) };
  }
}

export interface EmbeddingsOptions {
  /** 向量化服务商 id（server 端必填校验） */
  provider: string;
  /** 向量化模型，缺省时 server 使用该服务商默认 embedding 模型 */
  model?: string;
  signal?: AbortSignal;
}

/** GET /api/tools：服务端内置工具注册表（ToolSchema 列表） */
export async function listTools(signal?: AbortSignal): Promise<ToolSchema[]> {
  const res = await fetch(`${API_BASE}/tools`, { signal });
  if (!res.ok) {
    throw new Error(`获取工具列表失败（HTTP ${res.status}）`);
  }
  const data = (await res.json()) as { tools?: unknown };
  if (!Array.isArray(data.tools)) {
    throw new Error('工具列表响应格式错误：缺少 tools 数组');
  }
  return data.tools.filter(
    (tool): tool is ToolSchema =>
      Boolean(tool) &&
      typeof tool === 'object' &&
      typeof (tool as ToolSchema).name === 'string' &&
      typeof (tool as ToolSchema).description === 'string'
  );
}

/** POST /api/tools/execute：执行服务端内置工具（args 为 JSON 对象字符串）。
 *  confirmed=true 表示用户已授权（写 / 高危工具未经授权会被服务端拒绝） */
export async function executeTool(
  name: string,
  args: string,
  signal?: AbortSignal,
  confirmed?: boolean
): Promise<ToolExecutionResult> {
  try {
    const res = await fetch(`${API_BASE}/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, arguments: args, ...(confirmed ? { confirmed: true } : {}) }),
      signal,
    });
    const data = (await res.json().catch(() => null)) as Partial<ToolExecutionResult> | null;
    if (data && typeof data.ok === 'boolean') {
      return { ok: data.ok, result: data.result, error: data.error };
    }
    return { ok: false, error: `工具执行请求失败（HTTP ${res.status}）` };
  } catch (err) {
    if (isAbort(err)) return { ok: false, error: '已取消' };
    return { ok: false, error: errorMessage(err) };
  }
}

/** POST /api/embeddings：批量向量化（供检索 / 知识库使用），返回与输入一一对应的向量 */
export async function fetchEmbeddings(
  inputs: string[],
  options: EmbeddingsOptions
): Promise<number[][]> {
  const res = await fetch(`${API_BASE}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: options.provider, model: options.model, input: inputs }),
    signal: options.signal,
  });
  if (!res.ok) {
    throw new Error(await readError(res, '向量生成失败'));
  }
  const data = (await res.json()) as { embeddings?: unknown };
  if (!Array.isArray(data.embeddings)) {
    throw new Error('向量响应格式错误：缺少 embeddings 数组');
  }
  return data.embeddings.filter(
    (row): row is number[] => Array.isArray(row) && row.every((n) => typeof n === 'number')
  );
}

/* =============== 知识库（/api/kb/*） =============== */

/** GET /api/kb：知识库列表（含模式徽标与文档列表） */
export async function listKBs(signal?: AbortSignal): Promise<KBInfoEx[]> {
  const res = await fetch(`${API_BASE}/kb`, { signal });
  if (!res.ok) {
    throw new Error(await readError(res, '获取知识库列表失败'));
  }
  const data = (await res.json()) as { kbs?: unknown };
  if (!Array.isArray(data.kbs)) {
    throw new Error('知识库列表响应格式错误：缺少 kbs 数组');
  }
  return data.kbs as KBInfoEx[];
}

export interface CreateKBInput {
  name: string;
  /** 100 ~ 2000，缺省 500 */
  chunkSize?: number;
  /** 0 ~ 200，缺省 50 */
  chunkOverlap?: number;
}

/** POST /api/kb：新建知识库 */
export async function createKB(input: CreateKBInput, signal?: AbortSignal): Promise<KBInfoEx> {
  const res = await fetch(`${API_BASE}/kb`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok) {
    throw new Error(await readError(res, '创建知识库失败'));
  }
  return (await res.json()) as KBInfoEx;
}

/** DELETE /api/kb/:id：删除知识库（连同全部文档与索引） */
export async function deleteKB(kbId: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${API_BASE}/kb/${encodeURIComponent(kbId)}`, {
    method: 'DELETE',
    signal,
  });
  if (!res.ok) {
    throw new Error(await readError(res, '删除知识库失败'));
  }
}

/** POST /api/kb/:id/documents：上传纯文本文档（content ≤ 2MB），返回更新后的库信息 */
export async function addDocument(
  kbId: string,
  doc: { name: string; content: string },
  signal?: AbortSignal
): Promise<KBInfoEx> {
  const res = await fetch(`${API_BASE}/kb/${encodeURIComponent(kbId)}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc),
    signal,
  });
  if (!res.ok) {
    throw new Error(await readError(res, '上传文档失败'));
  }
  return (await res.json()) as KBInfoEx;
}

/** POST /api/kb/:id/documents/file?name=<文件名>：上传原始文件（.txt/.md/.docx/.pdf），
 *  服务端提取文本后入库，返回更新后的库信息 */
export async function addDocumentFile(
  kbId: string,
  file: File,
  signal?: AbortSignal
): Promise<KBInfoEx> {
  const body = await file.arrayBuffer();
  const res = await fetch(
    `${API_BASE}/kb/${encodeURIComponent(kbId)}/documents/file?name=${encodeURIComponent(file.name)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
      signal,
    }
  );
  if (!res.ok) {
    throw new Error(await readError(res, '上传文档失败'));
  }
  return (await res.json()) as KBInfoEx;
}

/** POST /api/kb/:id/documents（仅 name）：新建空白文档（服务端不走向量化，保存时再重分块），
 *  返回新文档详情（含 id，供直接打开编辑器） */
export async function createDocument(
  kbId: string,
  name: string,
  signal?: AbortSignal
): Promise<KBDocDetail> {
  const res = await fetch(`${API_BASE}/kb/${encodeURIComponent(kbId)}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
    signal,
  });
  if (!res.ok) {
    throw new Error(await readError(res, '新建文档失败'));
  }
  return (await res.json()) as KBDocDetail;
}

/** DELETE /api/kb/:id/documents/:docId：删除文档，返回更新后的库信息 */
export async function deleteDocument(
  kbId: string,
  docId: string,
  signal?: AbortSignal
): Promise<KBInfoEx> {
  const res = await fetch(
    `${API_BASE}/kb/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}`,
    { method: 'DELETE', signal }
  );
  if (!res.ok) {
    throw new Error(await readError(res, '删除文档失败'));
  }
  return (await res.json()) as KBInfoEx;
}

/** 文档详情（编辑器读取原文用） */
export interface KBDocDetail {
  id: string;
  name: string;
  content: string;
  chunkCount: number;
  createdAt: string;
}

/** GET /api/kb/:id/documents/:docId：文档详情（含原文） */
export async function getDocument(kbId: string, docId: string, signal?: AbortSignal): Promise<KBDocDetail> {
  const res = await fetch(
    `${API_BASE}/kb/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}`,
    { signal }
  );
  if (!res.ok) {
    throw new Error(await readError(res, '读取文档失败'));
  }
  return (await res.json()) as KBDocDetail;
}

/** PUT /api/kb/:id/documents/:docId：更新文档（重命名 / 重写内容，服务端重分块重向量化） */
export async function updateDocument(
  kbId: string,
  docId: string,
  patch: { name?: string; content?: string },
  signal?: AbortSignal
): Promise<KBInfoEx> {
  const res = await fetch(
    `${API_BASE}/kb/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
      signal,
    }
  );
  if (!res.ok) {
    throw new Error(await readError(res, '保存文档失败'));
  }
  return (await res.json()) as KBInfoEx;
}

/** GET /api/kb/:id/qa：读取该库问答记录（服务端持久化，刷新 / 换浏览器不丢） */
export async function fetchKBQA(kbId: string, signal?: AbortSignal): Promise<KBQAMessage[]> {
  const res = await fetch(`${API_BASE}/kb/${encodeURIComponent(kbId)}/qa`, { signal });
  if (!res.ok) {
    throw new Error(await readError(res, '读取问答记录失败'));
  }
  const data = (await res.json()) as { messages?: unknown };
  return Array.isArray(data.messages) ? (data.messages as KBQAMessage[]) : [];
}

/** PUT /api/kb/:id/qa：覆盖保存该库问答记录 */
export async function saveKBQA(
  kbId: string,
  messages: KBQAMessage[],
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`${API_BASE}/kb/${encodeURIComponent(kbId)}/qa`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!res.ok) {
    throw new Error(await readError(res, '保存问答记录失败'));
  }
}

/** POST /api/kb/:id/search：知识库检索（query 命中敏感词时 server 返回 400 blocked） */
export async function searchKB(
  kbId: string,
  query: string,
  topK: number,
  signal?: AbortSignal
): Promise<KBSearchResult> {
  const res = await fetch(`${API_BASE}/kb/${encodeURIComponent(kbId)}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, topK }),
    signal,
  });
  if (!res.ok) {
    throw new Error(await readError(res, '知识库检索失败'));
  }
  const data = (await res.json()) as { fragments?: unknown };
  if (!Array.isArray(data.fragments)) {
    throw new Error('检索响应格式错误：缺少 fragments 数组');
  }
  return data as KBSearchResult;
}

/** POST /api/kb/:id/rebuild：用当前可用的 embedding 服务商重建向量 */
export async function rebuildKB(kbId: string, signal?: AbortSignal): Promise<KBInfoEx> {
  const res = await fetch(`${API_BASE}/kb/${encodeURIComponent(kbId)}/rebuild`, {
    method: 'POST',
    signal,
  });
  if (!res.ok) {
    throw new Error(await readError(res, '重建向量失败'));
  }
  return (await res.json()) as KBInfoEx;
}

/* =============== 文件上传节点（/api/files） =============== */

/**
 * POST /api/files?name=&id=：上传原始文件二进制，服务端提取文本（文档类）。
 * id 为客户端预生成的文件 id（节点内 pending 项直接沿用，回包后无需再映射）。
 */
export async function uploadNodeFile(
  file: File,
  id: string,
  signal?: AbortSignal
): Promise<FileMeta> {
  const body = await file.arrayBuffer();
  const res = await fetch(
    `${API_BASE}/files?name=${encodeURIComponent(file.name)}&id=${encodeURIComponent(id)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body, signal }
  );
  if (!res.ok) {
    throw new Error(await readError(res, '上传文件失败'));
  }
  const json = (await res.json()) as { file?: FileMeta };
  if (!json.file) throw new Error('上传文件失败：服务端未返回文件信息');
  return json.file;
}

/** GET /api/files/:id/text：读取文档类文件的提取文本（运行时文件节点输出） */
export async function fetchNodeFileText(id: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${API_BASE}/files/${encodeURIComponent(id)}/text`, { signal });
  if (!res.ok) {
    throw new Error(await readError(res, '读取文件文本失败'));
  }
  const json = (await res.json()) as { text?: unknown };
  return typeof json.text === 'string' ? json.text : '';
}

/** GET /api/files/:id/raw：拉取原始字节（图片运行时转 dataURL） */
export async function fetchNodeFileRaw(id: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(`${API_BASE}/files/${encodeURIComponent(id)}/raw`, { signal });
  if (!res.ok) {
    throw new Error(await readError(res, '读取文件内容失败'));
  }
  return res.blob();
}

/** DELETE /api/files/:id：删除服务端文件（节点内移除文件时调用，失败静默） */
export async function deleteNodeFile(id: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch {
    // 删除失败不阻塞 UI（孤儿文件由服务端按目录清理）
  }
}
