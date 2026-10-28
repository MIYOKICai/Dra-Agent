/**
 * 上传文档的文本提取：按扩展名把原始文件转为纯文本（入库前统一走此层）。
 * - .txt / .md / .markdown：UTF-8 解码（去 BOM、统一换行）
 * - .docx：mammoth 提取正文段落
 * - .pdf：pdf-parse 提取全文（多页拼接）
 * - 其他扩展名 / 解析失败：抛 ExtractError，路由层转 400
 */
import { PDFParse } from 'pdf-parse';
import * as mammoth from 'mammoth';

/** 提取失败（不支持的格式 / 文件损坏 / 扫描件无文本层） */
export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** 纯文本类扩展名：直接解码 */
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown']);

function extname(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

/** docx → 纯文本（mammoth 提取正文段落） */
async function extractDocx(buf: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: buf });
  return result.value;
}

/** pdf → 纯文本（pdf-parse 多页拼接） */
async function extractPdf(buf: Buffer): Promise<string> {
  // 复制一份 Uint8Array，避免 pdfjs 直接接管 / 转移底层 buffer
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

/** 按文件名扩展名提取纯文本；失败抛 ExtractError（message 面向用户可读） */
export async function extractText(filename: string, buf: Buffer): Promise<string> {
  const ext = extname(filename);
  if (TEXT_EXTS.has(ext)) {
    return buf
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n');
  }
  if (ext === '.docx') {
    try {
      return await extractDocx(buf);
    } catch {
      throw new ExtractError('docx 解析失败：文件可能已损坏');
    }
  }
  if (ext === '.pdf') {
    try {
      return await extractPdf(buf);
    } catch {
      throw new ExtractError('pdf 解析失败：文件可能已损坏，或为扫描件（无文本层）');
    }
  }
  if (ext === '.doc') {
    const text = extractLegacyDoc(buf);
    if (text.trim().length < 20) {
      throw new ExtractError('doc 解析失败：未能提取到文本，请另存为 .docx 后上传');
    }
    return text;
  }
  throw new ExtractError(
    `不支持的文件格式${ext ? `「${ext}」` : ''}：支持 .txt / .md / .docx / .pdf / .doc 与图片`
  );
}

/**
 * 旧版 .doc 尽力而为提取：OLE2 复合文档的 WordDocument 流里，
 * 正文通常以 UTF-16LE 或 ANSI 连续可打印串存储。解出两种编码的
 * 「可打印连续段」（ASCII / 中文 / 常用标点，段长 ≥ 4），取总长更长者。
 * 垃圾字符不可避免，但足以给 LLM 提供上下文。
 */
function extractLegacyDoc(buf: Buffer): string {
  const printable = (ch: string): boolean =>
    /[\u0020-\u007E\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF\u2000-\u206F\n\r\t]/.test(ch);

  const runsFrom = (chars: string[]): string[] => {
    const runs: string[] = [];
    let cur = '';
    for (const ch of chars) {
      if (printable(ch)) cur += ch;
      else {
        if (cur.trim().length >= 4) runs.push(cur);
        cur = '';
      }
    }
    if (cur.trim().length >= 4) runs.push(cur);
    return runs;
  };

  // UTF-16LE 视角
  const utf16: string[] = [];
  for (let i = 0; i + 1 < buf.length; i += 2) {
    utf16.push(String.fromCharCode(buf[i] | (buf[i + 1] << 8)));
  }
  // Latin-1 视角
  const latin: string[] = [];
  for (const byte of buf) latin.push(String.fromCharCode(byte));

  const a = runsFrom(utf16).join('\n');
  const b = runsFrom(latin).join('\n');
  return a.length >= b.length ? a : b;
}
