/**
 * 知识库（RAG）模块：纯 JSON 文件持久化 + 分块 / 向量化 / 相似度检索。
 * - 存储：appConfig.kbDataDir（默认 server/data/kb）下每库一个子目录，index.json 单文件
 *   保存 KBInfo + documents + chunks（含可选向量），无数据库依赖
 * - 分块：按字符数滑窗（overlap 重叠，中文安全），窗口末尾优先对齐换行 / 句读边界
 * - 向量化：EMBEDDING_PROVIDER 可指定 provider，默认按 PROVIDER_ORDER 自动选第一个
 *   embedding 可用者（zhipu 先于 mock）；embed 失败 → 该库退化为关键词（bigram）模式
 * - 检索：有向量 → query embed + 余弦相似度 topK（得分归一 0~1）；关键词模式 →
 *   字符 bigram 重合度打分
 * - 并发：同一库的读-改-写用进程内 Promise 链串行化；写盘用临时文件 + rename 原子替换
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { KBFragment, KBInfo, KBInfoEx, KBQAMessage, KBSearchResult } from '../../shared/types';
import { appConfig } from './config';
import { serverRoot } from './paths';
import { listAdapters, type ProviderAdapter } from './providers';

/* =============== 错误类型 =============== */

/** 知识库业务错误：message 面向用户可读，路由层按 status 转换为 HTTP 状态码 */
export class KBError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/* =============== 磁盘数据结构 =============== */

/** index.json 中的单个 chunk（vector 缺省表示该 chunk 未向量化） */
interface KBChunk {
  id: string;
  docId: string;
  text: string;
  vector?: number[];
  createdAt: string;
}

/** index.json 完整结构（单文件存储一个库的全部数据） */
interface KBIndex {
  info: KBInfo;
  documents: KBDocRecord[];
  chunks: KBChunk[];
  /** 问答记录（随库持久化；旧索引缺省视为空） */
  qa?: KBQAMessage[];
}

/** 文档元信息（与 shared KBDocInfo 字段一致；content 为原文，供编辑器读取） */
interface KBDocRecord {
  id: string;
  name: string;
  chunkCount: number;
  createdAt: string;
  /** 文档原文（纯文本）。旧版本索引无此字段，缺省视为空 */
  content?: string;
}

/* =============== 路径与原子写 =============== */

/** 校验 id 形态（uuid），同时阻断路径穿越 */
const ID_RE = /^[0-9a-fA-F-]{8,64}$/;

function kbDir(kbId: string): string {
  return path.resolve(serverRoot, appConfig.kbDataDir, kbId);
}

function kbIndexFile(kbId: string): string {
  return path.join(kbDir(kbId), 'index.json');
}

/** 临时文件 + rename 原子替换，避免写一半崩溃留下损坏 JSON */
async function writeJson(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/* =============== 进程内串行锁 =============== */

const locks = new Map<string, Promise<unknown>>();

/** 同一 key 的异步任务串行执行，避免并发读-改-写丢数据；前序失败不阻塞后续任务 */
function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  locks.set(
    key,
    next.catch(() => undefined)
  );
  return next;
}

/* =============== 分块与打分（纯函数，供单测） =============== */

/** 句读 / 换行边界字符（分块对齐用） */
const SENTENCE_ENDINGS = new Set(['。', '！', '？', '；', '!', '?', ';', '…', '\n']);

/**
 * 滑窗分块：chunkSize 窗口、overlap 重叠（均按字符数计，Array.from 保证不截断代理对）。
 * 窗口末尾回看 40% 寻找最近的换行 / 句读边界（边界字符归入当前块），
 * 找不到才硬切；overlap 会被夹取到 [0, chunkSize-1]，保证窗口必定前移不死循环。
 */
export function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  const size = Math.max(1, Math.floor(chunkSize));
  const ov = Math.max(0, Math.min(Math.floor(overlap), size - 1));
  const chars = Array.from(text.replace(/\r\n?/g, '\n').trim());
  if (chars.length === 0) return [];
  if (chars.length <= size) return [chars.join('')];

  const chunks: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + size, chars.length);
    if (end < chars.length) {
      const lookback = Math.max(1, Math.floor(size * 0.4));
      for (let i = end - 1; i >= Math.max(start + 1, end - lookback); i--) {
        if (SENTENCE_ENDINGS.has(chars[i])) {
          end = i + 1;
          break;
        }
      }
    }
    const piece = chars.slice(start, end).join('').trim();
    if (piece) chunks.push(piece);
    if (end >= chars.length) break;
    start = Math.max(start + 1, end - ov);
  }
  return chunks;
}

/** 余弦相似度；维度不一致或存在零向量时返回 0 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 字符 bigram 集合（小写化；单字符文本退化为单字集合） */
function bigrams(text: string): Set<string> {
  const chars = Array.from(text.toLowerCase());
  const set = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) {
    set.add(chars[i] + chars[i + 1]);
  }
  if (set.size === 0 && chars.length > 0) {
    set.add(chars[0]);
  }
  return set;
}

/** 关键词模式打分：query 与文本的 bigram 重合率（0~1） */
export function bigramScore(query: string, text: string): number {
  const q = bigrams(query);
  if (q.size === 0) return 0;
  const t = bigrams(text);
  let hits = 0;
  for (const g of q) {
    if (t.has(g)) hits += 1;
  }
  return hits / q.size;
}

/* =============== embedding provider 选择与批量向量化 =============== */

const EMBED_BATCH_SIZE = 32;

function hasEmbeddingModel(adapter: ProviderAdapter): boolean {
  return adapter.listModels().some((m) => m.kind.includes('embedding'));
}

/**
 * 选择向量化 provider：EMBEDDING_PROVIDER 指定者优先（须可用且具备 embedding 模型），
 * 否则按 PROVIDER_ORDER 自动取第一个可用者（zhipu 先于 mock，mock 始终兜底）。
 */
export function pickEmbeddingAdapter(): ProviderAdapter | null {
  const candidates = listAdapters().filter((a) => a.isAvailable() && hasEmbeddingModel(a));
  if (candidates.length === 0) return null;
  const preferred = process.env.EMBEDDING_PROVIDER?.trim();
  if (preferred) {
    const found = candidates.find((a) => a.id === preferred);
    if (found) return found;
  }
  return candidates[0];
}

/** 分批批量向量化，入参输出一一对应；任一批失败整体抛出 */
async function embedAll(adapter: ProviderAdapter, texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    vectors.push(...(await adapter.embed(texts.slice(i, i + EMBED_BATCH_SIZE))));
  }
  return vectors;
}

/* =============== 索引读写 =============== */

async function readIndex(kbId: string): Promise<KBIndex> {
  if (!ID_RE.test(kbId)) throw new KBError('知识库不存在', 404);
  let raw: string;
  try {
    raw = await fsp.readFile(kbIndexFile(kbId), 'utf8');
  } catch {
    throw new KBError('知识库不存在', 404);
  }
  try {
    return JSON.parse(raw) as KBIndex;
  } catch {
    throw new KBError('知识库数据损坏（index.json 无法解析）', 500);
  }
}

/** 由索引数据推导对外信息（含检索模式与文档列表） */
function toInfoEx(index: KBIndex): KBInfoEx {
  const mode = index.chunks.some((c) => Array.isArray(c.vector) && c.vector.length > 0)
    ? 'vector'
    : 'keyword';
  return { ...index.info, mode, documents: index.documents };
}

/* =============== API 层：库管理 =============== */

export interface CreateKBInput {
  name: string;
  chunkSize?: number;
  chunkOverlap?: number;
}

/** 列出全部知识库（目录缺失视为空；损坏的库跳过），按创建时间升序 */
export async function listKBs(): Promise<KBInfoEx[]> {
  const root = path.resolve(serverRoot, appConfig.kbDataDir);
  let entries: string[];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return [];
  }
  const kbs: KBInfoEx[] = [];
  for (const id of entries) {
    try {
      kbs.push(toInfoEx(await readIndex(id)));
    } catch {
      // 非知识库目录 / 数据损坏：跳过
    }
  }
  return kbs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 新建知识库（默认 chunkSize=500 / chunkOverlap=50，范围 100~2000 / 0~200） */
export async function createKB(input: CreateKBInput): Promise<KBInfoEx> {
  const name = input.name.trim();
  if (!name) throw new KBError('知识库名称不能为空', 400);
  const chunkSize = input.chunkSize ?? 500;
  const chunkOverlap = input.chunkOverlap ?? 50;
  if (!Number.isInteger(chunkSize) || chunkSize < 100 || chunkSize > 2000) {
    throw new KBError('chunkSize 必须是 100 ~ 2000 的整数', 400);
  }
  if (!Number.isInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap > 200) {
    throw new KBError('chunkOverlap 必须是 0 ~ 200 的整数', 400);
  }
  if (chunkOverlap >= chunkSize) {
    throw new KBError('chunkOverlap 必须小于 chunkSize', 400);
  }
  const index: KBIndex = {
    info: {
      id: crypto.randomUUID(),
      name,
      chunkSize,
      chunkOverlap,
      docCount: 0,
      chunkCount: 0,
      createdAt: new Date().toISOString(),
    },
    documents: [],
    chunks: [],
  };
  await fsp.mkdir(kbDir(index.info.id), { recursive: true });
  await writeJson(kbIndexFile(index.info.id), index);
  return toInfoEx(index);
}

/** 删除知识库（连同其全部文档与索引） */
export async function deleteKB(id: string): Promise<void> {
  const dir = kbDir(id);
  try {
    await fsp.access(dir);
  } catch {
    throw new KBError('知识库不存在', 404);
  }
  await withLock(id, () => fsp.rm(dir, { recursive: true, force: true }));
}

/* =============== API 层：文档管理 =============== */

export interface AddDocumentInput {
  name: string;
  content: string;
}

/** 上传纯文本文档：分块 → 即时向量化（失败退关键词模式）→ 落盘 */
export async function addDocument(kbId: string, input: AddDocumentInput): Promise<KBInfoEx> {
  const name = input.name.trim();
  if (!name) throw new KBError('文档名称不能为空', 400);
  if (!input.content.trim()) throw new KBError('文档内容不能为空', 400);
  return withLock(kbId, async () => {
    const index = await readIndex(kbId);
    const texts = chunkText(input.content, index.info.chunkSize, index.info.chunkOverlap);
    if (texts.length === 0) {
      throw new KBError('文档内容过短，未能切分出任何片段', 400);
    }

    const doc: KBDocRecord = {
      id: crypto.randomUUID(),
      name,
      chunkCount: texts.length,
      createdAt: new Date().toISOString(),
      content: input.content,
    };

    // 即时向量化：embed 失败不阻断入库，本批 chunk 的 vector 留空（关键词模式）
    const adapter = pickEmbeddingAdapter();
    let vectors: number[][] | null = null;
    if (adapter) {
      try {
        vectors = await embedAll(adapter, texts);
      } catch {
        vectors = null;
      }
    }

    index.documents.push(doc);
    index.chunks.push(
      ...texts.map((text, i) => ({
        id: crypto.randomUUID(),
        docId: doc.id,
        text,
        ...(vectors ? { vector: vectors[i] } : {}),
        createdAt: doc.createdAt,
      }))
    );
    index.info.docCount = index.documents.length;
    index.info.chunkCount = index.chunks.length;
    await writeJson(kbIndexFile(kbId), index);
    return toInfoEx(index);
  });
}

/** 删除库内单个文档（连同其全部 chunk） */
export async function deleteDocument(kbId: string, docId: string): Promise<KBInfoEx> {
  return withLock(kbId, async () => {
    const index = await readIndex(kbId);
    if (!index.documents.some((d) => d.id === docId)) {
      throw new KBError('文档不存在', 404);
    }
    index.documents = index.documents.filter((d) => d.id !== docId);
    index.chunks = index.chunks.filter((c) => c.docId !== docId);
    index.info.docCount = index.documents.length;
    index.info.chunkCount = index.chunks.length;
    await writeJson(kbIndexFile(kbId), index);
    return toInfoEx(index);
  });
}

/**
 * 新建空白文档：仅在 index.json 注册元信息（content 为空、chunkCount 0、
 * 不生成 chunk、不走向量化），首次编辑保存时由 updateDocument 重分块并向量化。
 */
export async function createDocument(kbId: string, name: string): Promise<KBDocDetail> {
  const trimmed = name.trim();
  if (!trimmed) throw new KBError('文档名称不能为空', 400);
  return withLock(kbId, async () => {
    const index = await readIndex(kbId);
    const doc: KBDocRecord = {
      id: crypto.randomUUID(),
      name: trimmed,
      chunkCount: 0,
      createdAt: new Date().toISOString(),
      content: '',
    };
    index.documents.push(doc);
    index.info.docCount = index.documents.length;
    index.info.chunkCount = index.chunks.length;
    await writeJson(kbIndexFile(kbId), index);
    return {
      id: doc.id,
      name: doc.name,
      content: doc.content ?? '',
      chunkCount: doc.chunkCount,
      createdAt: doc.createdAt,
    };
  });
}

/* =============== API 层：文档读取与编辑 =============== */

/** 文档详情（编辑器读取原文用） */
export interface KBDocDetail {
  id: string;
  name: string;
  content: string;
  chunkCount: number;
  createdAt: string;
}

/** 读取文档详情（含原文）；旧版本索引无 content 字段时返回空串 */
export async function getDocument(kbId: string, docId: string): Promise<KBDocDetail> {
  const index = await readIndex(kbId);
  const doc = index.documents.find((d) => d.id === docId);
  if (!doc) throw new KBError('文档不存在', 404);
  return {
    id: doc.id,
    name: doc.name,
    content: doc.content ?? '',
    chunkCount: doc.chunkCount,
    createdAt: doc.createdAt,
  };
}

export interface UpdateDocumentInput {
  /** 新名称（缺省不重命名） */
  name?: string;
  /** 新原文（缺省不改内容；变更时重分块 + 即时向量化） */
  content?: string;
}

/**
 * 更新文档：name 变更仅改元信息；content 变更时重分块并即时向量化
 * （embed 失败不阻断，新 chunk 留空向量 → 检索退化为关键词打分），整体替换旧 chunk。
 */
export async function updateDocument(
  kbId: string,
  docId: string,
  input: UpdateDocumentInput
): Promise<KBInfoEx> {
  const name = input.name?.trim();
  if (name === '') throw new KBError('文档名称不能为空', 400);
  if (input.content !== undefined && !input.content.trim()) {
    throw new KBError('文档内容不能为空', 400);
  }
  return withLock(kbId, async () => {
    const index = await readIndex(kbId);
    const doc = index.documents.find((d) => d.id === docId);
    if (!doc) throw new KBError('文档不存在', 404);

    if (input.content !== undefined) {
      const texts = chunkText(input.content, index.info.chunkSize, index.info.chunkOverlap);
      if (texts.length === 0) {
        throw new KBError('文档内容过短，未能切分出任何片段', 400);
      }
      const adapter = pickEmbeddingAdapter();
      let vectors: number[][] | null = null;
      if (adapter) {
        try {
          vectors = await embedAll(adapter, texts);
        } catch {
          vectors = null;
        }
      }
      index.chunks = index.chunks.filter((c) => c.docId !== docId);
      index.chunks.push(
        ...texts.map((text, i) => ({
          id: crypto.randomUUID(),
          docId,
          text,
          ...(vectors ? { vector: vectors[i] } : {}),
          createdAt: doc.createdAt,
        }))
      );
      doc.chunkCount = texts.length;
      doc.content = input.content;
    }
    if (name) doc.name = name;

    index.info.docCount = index.documents.length;
    index.info.chunkCount = index.chunks.length;
    await writeJson(kbIndexFile(kbId), index);
    return toInfoEx(index);
  });
}

/* =============== API 层：检索与重建 =============== */

function clampTopK(topK: number): number {
  if (!Number.isFinite(topK)) return 3;
  return Math.min(Math.max(Math.round(topK), 1), 10);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * 知识库检索：
 * - 库中存在向量且 query 向量化成功、维度一致 → 余弦相似度 topK（得分 clamp 到 0~1）
 * - 否则（关键词模式 / 向量化失败 / 维度不匹配）→ 字符 bigram 重合度打分（丢弃 0 分片段）
 */
export async function search(kbId: string, query: string, topK = 3): Promise<KBSearchResult> {
  const q = query.trim();
  const k = clampTopK(topK);
  if (!q) return { fragments: [] };
  const index = await readIndex(kbId);
  if (index.chunks.length === 0) return { fragments: [] };

  const docNames = new Map(index.documents.map((d) => [d.id, d.name]));
  const sourceOf = (c: KBChunk): string => docNames.get(c.docId) ?? '未知来源';

  const vectorChunks = index.chunks
    .map((c) => ({ text: c.text, source: sourceOf(c), vector: c.vector }))
    .filter(
      (c): c is { text: string; source: string; vector: number[] } =>
        Array.isArray(c.vector) && c.vector.length > 0
    );

  if (vectorChunks.length > 0) {
    const adapter = pickEmbeddingAdapter();
    if (adapter) {
      try {
        const [qvec] = await adapter.embed([q]);
        if (Array.isArray(qvec) && qvec.length === vectorChunks[0].vector.length) {
          const fragments: KBFragment[] = vectorChunks
            .map((c) => ({
              text: c.text,
              source: c.source,
              score: round3(clamp01(cosineSimilarity(qvec, c.vector))),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, k);
          return { fragments };
        }
      } catch {
        // query 向量化失败：退回关键词打分
      }
    }
  }

  const fragments: KBFragment[] = index.chunks
    .map((c) => ({ text: c.text, source: sourceOf(c), score: round3(bigramScore(q, c.text)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .filter((f) => f.score > 0); // bigram 零重合的片段无参考价值
  return { fragments };
}

/** 用当前可用的 embedding provider 重算库内全部 chunk 向量 */
export async function rebuildKB(kbId: string): Promise<KBInfoEx> {
  return withLock(kbId, async () => {
    const index = await readIndex(kbId);
    if (index.chunks.length === 0) {
      throw new KBError('知识库为空，无需重建向量', 400);
    }
    const adapter = pickEmbeddingAdapter();
    if (!adapter) {
      throw new KBError('没有可用的 embedding 服务商（可配置 EMBEDDING_PROVIDER，或使用演示模式 mock）', 400);
    }
    let vectors: number[][];
    try {
      vectors = await embedAll(
        adapter,
        index.chunks.map((c) => c.text)
      );
    } catch (err) {
      throw new KBError(`向量重建失败：${err instanceof Error ? err.message : String(err)}`, 502);
    }
    index.chunks = index.chunks.map((c, i) => ({ ...c, vector: vectors[i] }));
    await writeJson(kbIndexFile(kbId), index);
    return toInfoEx(index);
  });
}

/* =============== 便捷入口（tools.ts 的 searchKnowledge 工具使用） =============== */

/**
 * searchKB(query, topK)：检索"最合适"的库 —— 仅一个库时直接用；
 * 多库时取文档数最多者（并列取最近创建）。无库 / 库不存在时返回空结果，不抛错。
 */
export async function searchKB(query: string, topK: number): Promise<KBSearchResult> {
  const q = query.trim();
  if (!q) return { fragments: [] };
  const kbs = await listKBs();
  if (kbs.length === 0) return { fragments: [] };
  const target = [...kbs].sort(
    (a, b) => b.docCount - a.docCount || b.createdAt.localeCompare(a.createdAt)
  )[0];
  try {
    return await search(target.id, q, topK);
  } catch {
    return { fragments: [] };
  }
}

/* =============== API 层：问答记录持久化（随库存储） =============== */

/** 问答记录上限：200 条 / 256KB（超出从最旧开始丢弃） */
const QA_MAX_MESSAGES = 200;
const QA_MAX_BYTES = 256 * 1024;

/** 读取某库的问答记录（旧索引无此字段时为空数组） */
export async function getQA(kbId: string): Promise<KBQAMessage[]> {
  return (await readIndex(kbId)).qa ?? [];
}

/** 覆盖保存某库的问答记录（超限截断后整体写入 index.json，withLock 串行） */
export async function setQA(kbId: string, messages: KBQAMessage[]): Promise<{ ok: true }> {
  let trimmed = messages.slice(-QA_MAX_MESSAGES);
  while (trimmed.length > 0 && Buffer.byteLength(JSON.stringify(trimmed), 'utf8') > QA_MAX_BYTES) {
    trimmed = trimmed.slice(1);
  }
  await withLock(kbId, async () => {
    const index = await readIndex(kbId);
    index.qa = trimmed;
    await writeJson(kbIndexFile(kbId), index);
  });
  return { ok: true };
}
