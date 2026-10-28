/**
 * 画布文件上传节点路由：/api/files/*。
 * - POST /?name=&id=：二进制上传（application/octet-stream），落盘原始字节；
 *   文档类立即提取纯文本落盘，图片类原样保存 → FileMeta
 * - GET /:id/text：读取提取文本 { text }（运行时文件节点输出）
 * - GET /:id/raw：原始字节流（运行时图片节点转 dataURL 预览 / 聚合）
 * - DELETE /:id：删除（字节 + 文本 + 元信息）
 * 元信息与内容各自独立文件存储：<id>.json / <id>.bin / <id>.txt
 */
import { Router } from 'express';
import express, { type Response } from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fsp from 'node:fs/promises';
import type { FileMeta } from '../../../shared/types';
import { appConfig } from '../config';
import { ExtractError, extractText } from '../extract';

export const filesRouter = Router();

/** 原始上传上限 20MB（与知识库上传一致） */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** 上传中间件：application/octet-stream → req.body 为 Buffer */
const rawUpload = express.raw({ type: 'application/octet-stream', limit: MAX_UPLOAD_BYTES });

/** 文档类扩展名 → kind */
const DOC_EXTS: Record<string, FileMeta['kind']> = {
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.docx': 'docx',
  '.txt': 'txt',
  '.md': 'txt',
  '.markdown': 'txt',
};

/** 图片类扩展名 → kind=image */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico']);

function extname(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

/** 按文件名判定 kind；不支持返回 null */
function detectKind(name: string): FileMeta['kind'] | null {
  const ext = extname(name);
  if (DOC_EXTS[ext]) return DOC_EXTS[ext];
  if (IMAGE_EXTS.has(ext)) return 'image';
  return null;
}

function filesDir(): string {
  return path.resolve(appConfig.filesDataDir);
}

function metaFile(id: string): string {
  return path.join(filesDir(), `${id}.json`);
}

function binFile(id: string): string {
  return path.join(filesDir(), `${id}.bin`);
}

function txtFile(id: string): string {
  return path.join(filesDir(), `${id}.txt`);
}

function handleError(res: Response, err: unknown): void {
  if (err instanceof ExtractError) {
    res.status(400).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
}

/** 读单个文件元信息；不存在返回 null */
async function readMeta(id: string): Promise<FileMeta | null> {
  try {
    const raw = await fsp.readFile(metaFile(id), 'utf8');
    return JSON.parse(raw) as FileMeta;
  } catch {
    return null;
  }
}

/** POST /api/files?name=<文件名>&id=<可选客户端生成id> */
filesRouter.post('/', rawUpload, async (req, res) => {
  try {
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    if (!name.trim()) {
      res.status(400).json({ error: '请求格式错误：需要 name 查询参数（文件名）' });
      return;
    }
    const kind = detectKind(name);
    if (!kind) {
      res.status(400).json({
        error: '不支持的文件类型：支持 PDF / Word（doc、docx）/ TXT / MD 与常见图片',
      });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: '请求体须为文件二进制（application/octet-stream）' });
      return;
    }
    // id 允许客户端预生成（上传前先在节点里渲染 pending 项，回包后按同一 id 落定）
    const id =
      typeof req.query.id === 'string' && /^[0-9a-f-]{8,64}$/i.test(req.query.id)
        ? req.query.id
        : randomUUID();

    await fsp.mkdir(filesDir(), { recursive: true });
    await fsp.writeFile(binFile(id), req.body);

    const meta: FileMeta = { id, name: name.trim(), size: req.body.length, kind, extract: 'done' };
    if (kind !== 'image') {
      try {
        const text = await extractText(name, req.body);
        if (!text.trim()) {
          throw new ExtractError('未能从文件中提取到文本内容');
        }
        await fsp.writeFile(txtFile(id), text, 'utf8');
      } catch (err) {
        // 文档解析失败：保留原文件，元信息记 failed（运行时给出提示行）
        meta.extract = 'failed';
        meta.extractError = err instanceof ExtractError ? err.message : '文本提取失败';
      }
    }
    await fsp.writeFile(metaFile(id), JSON.stringify(meta, null, 2), 'utf8');
    res.json({ file: meta });
  } catch (err) {
    handleError(res, err);
  }
});

/** GET /api/files/:id：文件元信息 */
filesRouter.get('/:id', async (req, res) => {
  const meta = await readMeta(req.params.id);
  if (!meta) {
    res.status(404).json({ error: '文件不存在（可能已被删除）' });
    return;
  }
  res.json({ file: meta });
});

/** GET /api/files/:id/text：提取文本（文档类） */
filesRouter.get('/:id/text', async (req, res) => {
  const meta = await readMeta(req.params.id);
  if (!meta) {
    res.status(404).json({ error: '文件不存在（可能已被删除）' });
    return;
  }
  if (meta.kind === 'image') {
    res.status(400).json({ error: '图片文件没有文本内容' });
    return;
  }
  try {
    const text = await fsp.readFile(txtFile(req.params.id), 'utf8');
    res.json({ text });
  } catch {
    res.status(404).json({ error: meta.extractError ?? '文本提取结果不存在' });
  }
});

/** 图片扩展名 → MIME（raw 接口返回正确类型，客户端 FileReader 才能生成 data:image/ 前缀的 dataURL） */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
};

/** GET /api/files/:id/raw：原始字节流（图片预览 / dataURL 化） */
filesRouter.get('/:id/raw', async (req, res) => {
  const meta = await readMeta(req.params.id);
  if (!meta) {
    res.status(404).json({ error: '文件不存在（可能已被删除）' });
    return;
  }
  try {
    const buf = await fsp.readFile(binFile(req.params.id));
    // 图片必须按真实 MIME 返回：此前固定 application/octet-stream 会使客户端
    // 生成 data:application/octet-stream 前缀的 dataURL，被视觉链路按
    // data:image/ 前缀过滤掉，导致画布 LLM 永远收不到图片
    let contentType = 'application/octet-stream';
    if (meta.kind === 'image') {
      contentType = IMAGE_MIME_BY_EXT[extname(meta.name)] ?? 'image/png';
    } else if (meta.kind === 'pdf') {
      contentType = 'application/pdf';
    }
    res.setHeader('Content-Type', contentType);
    res.send(buf);
  } catch {
    res.status(404).json({ error: '文件内容不存在' });
  }
});

/** DELETE /api/files/:id：删除文件（元信息 + 字节 + 文本，尽力而为） */
filesRouter.delete('/:id', async (req, res) => {
  const meta = await readMeta(req.params.id);
  if (!meta) {
    res.status(404).json({ error: '文件不存在（可能已被删除）' });
    return;
  }
  await Promise.allSettled([fsp.rm(metaFile(meta.id)), fsp.rm(binFile(meta.id)), fsp.rm(txtFile(meta.id))]);
  res.json({ ok: true });
});
