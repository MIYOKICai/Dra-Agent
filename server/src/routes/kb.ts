/**
 * 知识库路由：/api/kb/*。
 * 错误约定：KBError 按 status 转 HTTP；参数非法 400；库/文档不存在 404；
 * 敏感词命中 400 + { blocked, hits }；统一 JSON { error }。
 */
import { Router } from 'express';
import express, { type Response } from 'express';
import type { KBQAMessage, KBSearchResult } from '../../../shared/types';
import { checkText } from '../safety';
import { ExtractError, extractText } from '../extract';
import {
  KBError,
  addDocument,
  createDocument,
  createKB,
  deleteDocument,
  deleteKB,
  getDocument,
  getQA,
  listKBs,
  rebuildKB,
  search,
  setQA,
  updateDocument,
} from '../kb';

export const kbRouter = Router();

/** 文档纯文本内容上限（客户端负责读文件转文本） */
const MAX_DOC_BYTES = 2 * 1024 * 1024;

/** 原始上传文件上限（提取出的文本仍受 MAX_DOC_BYTES 约束） */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** 原始文件上传中间件：application/octet-stream → req.body 为 Buffer */
const fileUpload = express.raw({ type: 'application/octet-stream', limit: MAX_UPLOAD_BYTES });

function handleError(res: Response, err: unknown): void {
  if (err instanceof KBError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
}

/** GET /api/kb：知识库列表（含模式徽标与文档列表） */
kbRouter.get('/', async (_req, res) => {
  try {
    res.json({ kbs: await listKBs() });
  } catch (err) {
    handleError(res, err);
  }
});

/** POST /api/kb：新建知识库 { name, chunkSize?, chunkOverlap? } → KBInfoEx */
kbRouter.post('/', async (req, res) => {
  try {
    const body = req.body as
      | { name?: unknown; chunkSize?: unknown; chunkOverlap?: unknown }
      | undefined;
    if (typeof body?.name !== 'string') {
      res.status(400).json({ error: '请求格式错误：需要 name（字符串）' });
      return;
    }
    const kb = await createKB({
      name: body.name,
      chunkSize: typeof body.chunkSize === 'number' ? body.chunkSize : undefined,
      chunkOverlap: typeof body.chunkOverlap === 'number' ? body.chunkOverlap : undefined,
    });
    res.json(kb);
  } catch (err) {
    handleError(res, err);
  }
});

/** DELETE /api/kb/:id：删除知识库 → { ok: true } */
kbRouter.delete('/:id', async (req, res) => {
  try {
    await deleteKB(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

/** POST /api/kb/:id/documents：上传纯文本文档 { name, content }（content ≤ 2MB）→ KBInfoEx；
 *  body 仅 { name }（无 content）时新建空白文档 → KBDocDetail（暂无 chunk，保存编辑时再重分块） */
kbRouter.post('/:id/documents', async (req, res) => {
  try {
    const body = req.body as { name?: unknown; content?: unknown } | undefined;
    if (typeof body?.name !== 'string') {
      res.status(400).json({ error: '请求格式错误：需要 name（字符串）' });
      return;
    }
    // 无 content 字段：新建空白文档（不走向量化，编辑保存时再由 PUT 重分块）
    if (typeof body.content !== 'string') {
      res.json(await createDocument(req.params.id, body.name));
      return;
    }
    if (Buffer.byteLength(body.content, 'utf8') > MAX_DOC_BYTES) {
      res.status(400).json({ error: '文档内容超过 2MB 限制' });
      return;
    }
    res.json(await addDocument(req.params.id, { name: body.name, content: body.content }));
  } catch (err) {
    handleError(res, err);
  }
});

/** POST /api/kb/:id/documents/file?name=<文件名>：上传原始文件（.txt/.md/.docx/.pdf），
 *  服务端提取文本后入库（重分块 + 向量化）→ KBInfoEx */
kbRouter.post('/:id/documents/file', fileUpload, async (req, res) => {
  try {
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    if (!name.trim()) {
      res.status(400).json({ error: '请求格式错误：需要 name 查询参数（文件名）' });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: '请求体须为文件二进制（application/octet-stream）' });
      return;
    }
    const text = await extractText(name, req.body);
    if (!text.trim()) {
      res.status(400).json({ error: '未能从文件中提取到文本内容' });
      return;
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_DOC_BYTES) {
      res.status(400).json({ error: '提取出的文本超过 2MB 限制' });
      return;
    }
    res.json(await addDocument(req.params.id, { name: name.replace(/\.[^.]+$/, '') || name, content: text }));
  } catch (err) {
    if (err instanceof ExtractError) {
      res.status(400).json({ error: err.message });
      return;
    }
    handleError(res, err);
  }
});

/** DELETE /api/kb/:id/documents/:docId：删除文档 → KBInfoEx */
kbRouter.delete('/:id/documents/:docId', async (req, res) => {
  try {
    res.json(await deleteDocument(req.params.id, req.params.docId));
  } catch (err) {
    handleError(res, err);
  }
});

/** GET /api/kb/:id/documents/:docId：文档详情（含原文，编辑器读取）→ KBDocDetail */
kbRouter.get('/:id/documents/:docId', async (req, res) => {
  try {
    res.json(await getDocument(req.params.id, req.params.docId));
  } catch (err) {
    handleError(res, err);
  }
});

/** PUT /api/kb/:id/documents/:docId：更新文档 { name?, content? }（重分块重向量化）→ KBInfoEx */
kbRouter.put('/:id/documents/:docId', async (req, res) => {
  try {
    const body = req.body as { name?: unknown; content?: unknown } | undefined;
    if (body?.name !== undefined && typeof body.name !== 'string') {
      res.status(400).json({ error: '请求格式错误：name 须为字符串' });
      return;
    }
    if (body?.content !== undefined && typeof body.content !== 'string') {
      res.status(400).json({ error: '请求格式错误：content 须为字符串' });
      return;
    }
    if (typeof body?.content === 'string' && Buffer.byteLength(body.content, 'utf8') > MAX_DOC_BYTES) {
      res.status(400).json({ error: '文档内容超过 2MB 限制' });
      return;
    }
    res.json(
      await updateDocument(req.params.id, req.params.docId, {
        name: typeof body?.name === 'string' ? body.name : undefined,
        content: typeof body?.content === 'string' ? body.content : undefined,
      })
    );
  } catch (err) {
    handleError(res, err);
  }
});

/** POST /api/kb/:id/search：检索 { query, topK? } → KBSearchResult；query 命中敏感词 400 blocked */
kbRouter.post('/:id/search', async (req, res) => {
  try {
    const body = req.body as { query?: unknown; topK?: unknown } | undefined;
    if (typeof body?.query !== 'string') {
      res.status(400).json({ error: '请求格式错误：需要 query（字符串）' });
      return;
    }
    const { blocked, hits } = await checkText(body.query);
    if (blocked) {
      res.status(400).json({
        error: `内容命中敏感词：${hits.join('、')}`,
        blocked: true,
        hits,
      });
      return;
    }
    const topK = typeof body.topK === 'number' ? body.topK : 3;
    const result: KBSearchResult = await search(req.params.id, body.query, topK);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

/** 校验问答消息结构（role / content 必填，sources 透传数组） */
function isQAMessage(m: unknown): m is KBQAMessage {
  return (
    Boolean(m) &&
    typeof m === 'object' &&
    ((m as KBQAMessage).role === 'user' || (m as KBQAMessage).role === 'assistant') &&
    typeof (m as KBQAMessage).content === 'string'
  );
}

/** GET /api/kb/:id/qa：读取该库问答记录 → { messages }（服务端持久化，刷新不丢） */
kbRouter.get('/:id/qa', async (req, res) => {
  try {
    res.json({ messages: await getQA(req.params.id) });
  } catch (err) {
    handleError(res, err);
  }
});

/** PUT /api/kb/:id/qa：覆盖保存问答记录 { messages } → { ok: true } */
kbRouter.put('/:id/qa', async (req, res) => {
  try {
    const body = req.body as { messages?: unknown } | undefined;
    if (!Array.isArray(body?.messages)) {
      res.status(400).json({ error: '请求格式错误：需要 messages 数组' });
      return;
    }
    res.json(await setQA(req.params.id, body.messages.filter(isQAMessage)));
  } catch (err) {
    handleError(res, err);
  }
});

/** POST /api/kb/:id/rebuild：重建向量 → KBInfoEx */
kbRouter.post('/:id/rebuild', async (req, res) => {
  try {
    res.json(await rebuildKB(req.params.id));
  } catch (err) {
    handleError(res, err);
  }
});
