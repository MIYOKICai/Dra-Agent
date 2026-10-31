/**
 * 知识库（RAG）模块：纯 JSON 文件持久化 + 分块 / 向量化 / 相似度检索（多用户隔离）。
 * - 存储：<dataDir>/files/<userId>/<kbId>/ 下每库一个目录，index.json 单文件
 *   保存 KBInfo + documents + chunks（含可选向量），无数据库依赖；
 *   文件上传的原始实体同目录落盘为 <docId>_<name>，元数据同步记录到 SQLite kb_docs 表，
 *   kbId 归属（首次创建即登记）记录在 kb_ownership 表
 * - 隔离：所有读写以 req.user.id 圈定在 <dataDir>/files/<userId>/ 之内，
 *   跨用户的 kbId 一律 404（不泄露存在性）；旧版单用户数据（<dataDir>/kb）不迁移、不受影响
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
import { dataDir } from './paths';
import { getDb } from './db/connection';
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

/** 锁 / 通用键：用户与库维度联合，避免不同用户同名 key 串扰 */
function kbKey(userId: string, kbId: string): string {
  return `${userId}:${kbId}`;
}

/**
 * 某用户的知识库数据根目录：<dataDir>/files/<userId>/（其下每库一个 <kbId>/ 子目录）。
 * userId 来自认证中间件（users.id），仍按 uuid 形态校验以阻断路径穿越。
 */
function kbRoot(userId: string): string {
  if (!ID_RE.test(userId)) throw new KBError('知识库不存在', 404);
  return path.join(dataDir, 'files', userId);
}

function kbDir(userId: string, kbId: string): string {
  return path.join(kbRoot(userId), kbId);
}

function kbIndexFile(userId: string, kbId: string): string {
  return path.join(kbDir(userId, kbId), 'index.json');
}

/** 文档实体文件名清洗：剥路径分量与非法字符，防穿越；超长截断（保留尾部扩展名） */
function sanitizeFilename(name: string): string {
  const base = path
    .basename(name)
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .trim();
  if (!base || base === '.' || base === '..') return 'untitled';
  return base.length > 120 ? base.slice(base.length - 120) : base;
}

/** 临时文件 + rename 原子替换，避免写一半崩溃留下损坏 JSON */
async function writeJson(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/* =============== kbId 归属（kb_ownership 表） =============== */

/**
 * kbId 归属校验：归属记录存在 → 必须属于当前用户（否则 404，不泄露存在性）；
 * 无记录但库目录在该用户名下（DB 重建等历史情形）→ 首次使用即补建归属；目录也不存在 → 404。
 */
async function ensureKBAccess(userId: string, kbId: string): Promise<void> {
  if (!ID_RE.test(kbId)) throw new KBError('知识库不存在', 404);
  const row = getDb().prepare('SELECT user_id FROM kb_ownership WHERE kb_id = ?').get(kbId) as
    | { user_id: string }
    | undefined;
  if (row) {
    if (row.user_id !== userId) throw new KBError('知识库不存在', 404);
    return;
  }
  try {
    await fsp.access(kbDir(userId, kbId));
  } catch {
    throw new KBError('知识库不存在', 404);
  }
  getDb().prepare('INSERT INTO kb_ownership (kb_id, user_id) VALUES (?, ?)').run(kbId, userId);
}

/* =============== kb_docs 元数据同步 =============== */

/** 新增 kb_docs 记录（index.json 写盘成功后调用；status 固定 ready，向量化失败仅退关键词模式） */
function insertKBDocRow(
  userId: string,
  kbId: string,
  doc: { id: string; name: string; size: number; chunks: number; filePath: string | null }
): void {
  getDb()
    .prepare(
      'INSERT INTO kb_docs (id, user_id, kb_id, name, size, chunks, status, file_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(doc.id, userId, kbId, doc.name, doc.size, doc.chunks, 'ready', doc.filePath);
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

async function readIndex(userId: string, kbId: string): Promise<KBIndex> {
  if (!ID_RE.test(kbId)) throw new KBError('知识库不存在', 404);
  let raw: string;
  try {
    raw = await fsp.readFile(kbIndexFile(userId, kbId), 'utf8');
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

/** 列出当前用户的全部知识库（用户目录缺失视为空；损坏的库跳过），按创建时间升序 */
export async function listKBs(userId: string): Promise<KBInfoEx[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(kbRoot(userId));
  } catch {
    return []; // 该用户尚未创建任何知识库（目录不存在）
  }
  const kbs: KBInfoEx[] = [];
  for (const id of entries) {
    try {
      kbs.push(toInfoEx(await readIndex(userId, id)));
    } catch {
      // 非知识库目录 / 数据损坏：跳过
    }
  }
  return kbs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 新建知识库（默认 chunkSize=500 / chunkOverlap=50，范围 100~2000 / 0~200）；
 *  首次使用即登记 kbId 归属（kb_ownership 表） */
export async function createKB(userId: string, input: CreateKBInput): Promise<KBInfoEx> {
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
  await fsp.mkdir(kbDir(userId, index.info.id), { recursive: true });
  await writeJson(kbIndexFile(userId, index.info.id), index);
  getDb()
    .prepare('INSERT INTO kb_ownership (kb_id, user_id) VALUES (?, ?)')
    .run(index.info.id, userId);
  return toInfoEx(index);
}

/** 删除知识库（连同其全部文档、索引、实体文件与 kb_docs / 归属记录） */
export async function deleteKB(userId: string, id: string): Promise<void> {
  await ensureKBAccess(userId, id);
  await withLock(kbKey(userId, id), async () => {
    await fsp.rm(kbDir(userId, id), { recursive: true, force: true });
    const db = getDb();
    db.prepare('DELETE FROM kb_docs WHERE user_id = ? AND kb_id = ?').run(userId, id);
    db.prepare('DELETE FROM kb_ownership WHERE kb_id = ? AND user_id = ?').run(id, userId);
  });
}

/* =============== API 层：文档管理 =============== */

export interface AddDocumentInput {
  name: string;
  content: string;
  /** 原始上传文件实体（可选）：落盘 <kbDir>/<docId>_<文件名>，路径记入 kb_docs.file_path */
  entity?: { data: Buffer; filename: string };
}

/** 上传纯文本文档：分块 → 即时向量化（失败退关键词模式）→ 索引与实体落盘 → kb_docs 入库 */
export async function addDocument(
  userId: string,
  kbId: string,
  input: AddDocumentInput
): Promise<KBInfoEx> {
  const name = input.name.trim();
  if (!name) throw new KBError('文档名称不能为空', 400);
  if (!input.content.trim()) throw new KBError('文档内容不能为空', 400);
  return withLock(kbKey(userId, kbId), async () => {
    await ensureKBAccess(userId, kbId);
    const index = await readIndex(userId, kbId);
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

    // 原始文件实体按用户/库隔离落盘（失败不阻断入库，仅不记录 file_path）
    let filePath: string | null = null;
    if (input.entity && input.entity.data.length > 0) {
      try {
        await fsp.mkdir(kbDir(userId, kbId), { recursive: true });
        filePath = path.join(
          kbDir(userId, kbId),
          `${doc.id}_${sanitizeFilename(input.entity.filename)}`
        );
        await fsp.writeFile(filePath, input.entity.data);
      } catch {
        filePath = null;
      }
    }

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
    await writeJson(kbIndexFile(userId, kbId), index);
    insertKBDocRow(userId, kbId, {
      id: doc.id,
      name,
      size: input.entity ? input.entity.data.length : Buffer.byteLength(input.content, 'utf8'),
      chunks: texts.length,
      filePath,
    });
    return toInfoEx(index);
  });
}

/** 删除库内单个文档：级联删 kb_docs 记录、实体文件与全部 chunk */
export async function deleteDocument(
  userId: string,
  kbId: string,
  docId: string
): Promise<KBInfoEx> {
  return withLock(kbKey(userId, kbId), async () => {
    await ensureKBAccess(userId, kbId);
    const index = await readIndex(userId, kbId);
    if (!index.documents.some((d) => d.id === docId)) {
      throw new KBError('文档不存在', 404);
    }
    const row = getDb()
      .prepare('SELECT file_path FROM kb_docs WHERE id = ? AND user_id = ? AND kb_id = ?')
      .get(docId, userId, kbId) as { file_path: string | null } | undefined;
    index.documents = index.documents.filter((d) => d.id !== docId);
    index.chunks = index.chunks.filter((c) => c.docId !== docId);
    index.info.docCount = index.documents.length;
    index.info.chunkCount = index.chunks.length;
    await writeJson(kbIndexFile(userId, kbId), index);
    getDb()
      .prepare('DELETE FROM kb_docs WHERE id = ? AND user_id = ? AND kb_id = ?')
      .run(docId, userId, kbId);
    if (row?.file_path) {
      await fsp.rm(row.file_path, { force: true }).catch(() => undefined);
    }
    return toInfoEx(index);
  });
}

/**
 * 新建空白文档：仅在 index.json 注册元信息（content 为空、chunkCount 0、
 * 不生成 chunk、不走向量化），首次编辑保存时由 updateDocument 重分块并向量化。
 */
export async function createDocument(userId: string, kbId: string, name: string): Promise<KBDocDetail> {
  const trimmed = name.trim();
  if (!trimmed) throw new KBError('文档名称不能为空', 400);
  return withLock(kbKey(userId, kbId), async () => {
    await ensureKBAccess(userId, kbId);
    const index = await readIndex(userId, kbId);
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
    await writeJson(kbIndexFile(userId, kbId), index);
    insertKBDocRow(userId, kbId, { id: doc.id, name: trimmed, size: 0, chunks: 0, filePath: null });
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
export async function getDocument(userId: string, kbId: string, docId: string): Promise<KBDocDetail> {
  const index = await readIndex(userId, kbId);
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
  userId: string,
  kbId: string,
  docId: string,
  input: UpdateDocumentInput
): Promise<KBInfoEx> {
  const name = input.name?.trim();
  if (name === '') throw new KBError('文档名称不能为空', 400);
  if (input.content !== undefined && !input.content.trim()) {
    throw new KBError('文档内容不能为空', 400);
  }
  return withLock(kbKey(userId, kbId), async () => {
    await ensureKBAccess(userId, kbId);
    const index = await readIndex(userId, kbId);
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
    await writeJson(kbIndexFile(userId, kbId), index);
    syncKBDocRow(userId, kbId, doc, input.content !== undefined ? input.content : null);
    return toInfoEx(index);
  });
}

/** 同步 kb_docs（文档更新后）：名称 / 分块数 / 状态；size 仅在无原始实体且内容变更时重算 */
function syncKBDocRow(
  userId: string,
  kbId: string,
  doc: { id: string; name: string; chunkCount: number },
  newContent: string | null
): void {
  const db = getDb();
  const row = db
    .prepare('SELECT file_path FROM kb_docs WHERE id = ? AND user_id = ? AND kb_id = ?')
    .get(doc.id, userId, kbId) as { file_path: string | null } | undefined;
  if (!row) return; // 索引中存在但 DB 无记录（历史数据）：不回填
  const now = new Date().toISOString();
  if (row.file_path || newContent === null) {
    db.prepare(
      "UPDATE kb_docs SET name = ?, chunks = ?, status = 'ready', updated_at = ? WHERE id = ? AND user_id = ? AND kb_id = ?"
    ).run(doc.name, doc.chunkCount, now, doc.id, userId, kbId);
  } else {
    db.prepare(
      "UPDATE kb_docs SET name = ?, chunks = ?, status = 'ready', size = ?, updated_at = ? WHERE id = ? AND user_id = ? AND kb_id = ?"
    ).run(doc.name, doc.chunkCount, Buffer.byteLength(newContent, 'utf8'), now, doc.id, userId, kbId);
  }
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
export async function search(userId: string, kbId: string, query: string, topK = 3): Promise<KBSearchResult> {
  const q = query.trim();
  const k = clampTopK(topK);
  if (!q) return { fragments: [] };
  const index = await readIndex(userId, kbId);
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
export async function rebuildKB(userId: string, kbId: string): Promise<KBInfoEx> {
  return withLock(kbKey(userId, kbId), async () => {
    await ensureKBAccess(userId, kbId);
    const index = await readIndex(userId, kbId);
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
    await writeJson(kbIndexFile(userId, kbId), index);
    return toInfoEx(index);
  });
}

/* =============== 便捷入口（tools.ts 的 searchKnowledge 工具使用） =============== */

/**
 * searchKB(userId, query, topK)：检索当前用户"最合适"的库 —— 仅一个库时直接用；
 * 多库时取文档数最多者（并列取最近创建）。无库 / 库不存在时返回空结果，不抛错。
 */
export async function searchKB(userId: string, query: string, topK: number): Promise<KBSearchResult> {
  const q = query.trim();
  if (!q) return { fragments: [] };
  const kbs = await listKBs(userId);
  if (kbs.length === 0) return { fragments: [] };
  const target = [...kbs].sort(
    (a, b) => b.docCount - a.docCount || b.createdAt.localeCompare(a.createdAt)
  )[0];
  try {
    return await search(userId, target.id, q, topK);
  } catch {
    return { fragments: [] };
  }
}

/* =============== API 层：问答记录持久化（随库存储） =============== */

/** 问答记录上限：200 条 / 256KB（超出从最旧开始丢弃） */
const QA_MAX_MESSAGES = 200;
const QA_MAX_BYTES = 256 * 1024;

/** 读取某库的问答记录（旧索引无此字段时为空数组） */
export async function getQA(userId: string, kbId: string): Promise<KBQAMessage[]> {
  return (await readIndex(userId, kbId)).qa ?? [];
}

/** 覆盖保存某库的问答记录（超限截断后整体写入 index.json，withLock 串行） */
export async function setQA(userId: string, kbId: string, messages: KBQAMessage[]): Promise<{ ok: true }> {
  let trimmed = messages.slice(-QA_MAX_MESSAGES);
  while (trimmed.length > 0 && Buffer.byteLength(JSON.stringify(trimmed), 'utf8') > QA_MAX_BYTES) {
    trimmed = trimmed.slice(1);
  }
  await withLock(kbKey(userId, kbId), async () => {
    const index = await readIndex(userId, kbId);
    index.qa = trimmed;
    await writeJson(kbIndexFile(userId, kbId), index);
  });
  return { ok: true };
}
