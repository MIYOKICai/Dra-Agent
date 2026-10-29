/**
 * 服务端内置工具注册表：供 Agent 节点（function calling）与 /api/tools/* 端点使用。
 * - listToolSchemas()：导出 ToolSchema 列表（随 /api/chat 的 tools 参数透传给上游模型）
 * - executeTool(name, argsJson)：统一执行入口；参数解析失败 / 未知工具 / 缺必填参数 /
 *   工具内部异常一律转换为结果对象返回，绝不向路由层抛出异常。
 * - 工具分三类：基础信息类（1~4）、知识库类（5~6）、桌面系统类（7~19，
 *   文件 / 文件夹 / 命令行 / 系统信息 / 剪贴板，写与高危操作走对话流用户确认）。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KBSearchResult, ToolExecutionResult, ToolRisk, ToolSchema } from '../../shared/types';
import { addDocument, createKB, deleteDocument, listKBs, searchKB } from './kb';

/** 单个工具的完整定义（execute 抛出的异常由 executeTool 统一兜底为错误对象） */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema 形式的参数描述（含 required，用于缺参校验） */
  parameters: Record<string, unknown>;
  /** 风险分级：read=只读直执行（缺省）；write=写操作需授权；danger=高危需确认 */
  risk?: ToolRisk;
  execute(args: Record<string, unknown>): Promise<string>;
}

/* =============== 工具 1：getCurrentTime =============== */

function formatCurrentTime(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
    hour12: false,
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const unixSeconds = Math.floor(now.getTime() / 1000);
  return `当前时间：${get('year')}年${get('month')}月${get('day')}日 ${get('hour')}:${get('minute')}:${get(
    'second'
  )}（${get('weekday')}），Unix 时间戳：${unixSeconds} 秒`;
}

const getCurrentTimeTool: ToolDefinition = {
  name: 'getCurrentTime',
  description: '获取当前日期与时间（Asia/Shanghai 时区，含年月日、星期与 Unix 时间戳）',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute() {
    return formatCurrentTime();
  },
};

/* =============== 工具 2：calculator（递归下降解析器，禁止 eval） =============== */

/** 表达式语法错误（消息面向最终用户可读） */
class ExpressionError extends Error {}

/**
 * 求值算术表达式：递归下降解析，支持 + - * / % ^、括号、一元正负号、
 * 小数与科学计数法字面量。文法（^ 最高且右结合，一元负号低于 ^）：
 *   expr   := term (('+' | '-') term)*
 *   term   := unary (('*' | '/' | '%') unary)*
 *   unary  := ('-' | '+') unary | power
 *   power  := primary ('^' unary)?
 *   primary:= NUMBER | '(' expr ')'
 */
export function evaluateExpression(input: string): number {
  const src = input.trim();
  if (!src) throw new ExpressionError('表达式为空');
  let pos = 0;

  const peek = (): string => (pos < src.length ? src[pos] : '');
  const skipWs = (): void => {
    while (pos < src.length && /\s/.test(src[pos])) pos += 1;
  };
  const checkFinite = (value: number): void => {
    if (!Number.isFinite(value)) throw new ExpressionError('计算结果超出数值范围（溢出）');
  };

  const parsePrimary = (): number => {
    skipWs();
    const ch = peek();
    if (ch === '(') {
      pos += 1;
      const value = parseExpr();
      skipWs();
      if (peek() !== ')') throw new ExpressionError('括号不匹配');
      pos += 1;
      return value;
    }
    const match = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(pos));
    if (!match) {
      if (ch === ')') throw new ExpressionError('表达式不完整（括号内容为空）');
      throw new ExpressionError(ch ? `存在非法字符「${ch}」` : '表达式不完整');
    }
    pos += match[0].length;
    return Number(match[0]);
  };

  const parsePower = (): number => {
    const base = parsePrimary();
    skipWs();
    if (peek() === '^') {
      pos += 1;
      // 指数走 unary：支持 2^-3，且 2^3^2 依右结合求值为 2^(3^2)
      const value = base ** parseUnary();
      checkFinite(value);
      return value;
    }
    return base;
  };

  const parseUnary = (): number => {
    skipWs();
    if (peek() === '-') {
      pos += 1;
      return -parseUnary();
    }
    if (peek() === '+') {
      pos += 1;
      return parseUnary();
    }
    return parsePower();
  };

  const parseTerm = (): number => {
    let value = parseUnary();
    for (;;) {
      skipWs();
      const op = peek();
      if (op === '*') {
        pos += 1;
        value *= parseUnary();
      } else if (op === '/') {
        pos += 1;
        const divisor = parseUnary();
        if (divisor === 0) throw new ExpressionError('除数不能为零');
        value /= divisor;
      } else if (op === '%') {
        pos += 1;
        const divisor = parseUnary();
        if (divisor === 0) throw new ExpressionError('取模除数不能为零');
        value %= divisor;
      } else {
        return value;
      }
      checkFinite(value);
    }
  };

  const parseExpr = (): number => {
    let value = parseTerm();
    for (;;) {
      skipWs();
      const op = peek();
      if (op === '+') {
        pos += 1;
        value += parseTerm();
      } else if (op === '-') {
        pos += 1;
        value -= parseTerm();
      } else {
        return value;
      }
      checkFinite(value);
    }
  };

  const value = parseExpr();
  skipWs();
  if (pos < src.length) {
    throw new ExpressionError(`存在无法解析的内容「${src.slice(pos, pos + 8)}」`);
  }
  checkFinite(value);
  return value;
}

/** 数值输出格式化：中间噪音精度收敛，超大/极小值用科学计数法 */
function formatNumber(value: number): string {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e16 || abs < 1e-6) {
    return value.toExponential(6).replace(/\.?0+e/, 'e');
  }
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(12)));
}

const calculatorTool: ToolDefinition = {
  name: 'calculator',
  description: '计算数学表达式，支持 + - * / % ^ 运算、括号与一元正负号',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '算术表达式字符串，例如 3*(7+2)^2' },
    },
    required: ['expression'],
  },
  async execute(args) {
    const expression = typeof args.expression === 'string' ? args.expression : '';
    if (!expression.trim()) {
      throw new Error('缺少算术表达式：expression 必须为字符串');
    }
    let value: number;
    try {
      value = evaluateExpression(expression);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`表达式「${expression.slice(0, 50)}」无法计算：${reason}`);
    }
    return formatNumber(value);
  },
};

/* =============== 工具 3：webSummary =============== */

const FETCH_TIMEOUT_MS = 10_000;
const SUMMARY_MAX_CHARS = 2000;
const FETCH_UA =
  'Mozilla/5.0 (compatible; DraAgent/0.1; web-summary-tool) AppleWebKit/537.36 Chrome/120 Safari/537.36';

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return text.replace(/&(?:#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (entity) => {
    const body = entity.slice(1, -1);
    let code: number | undefined;
    if (body.startsWith('#x') || body.startsWith('#X')) code = Number.parseInt(body.slice(2), 16);
    else if (body.startsWith('#')) code = Number.parseInt(body.slice(1), 10);
    if (code !== undefined) {
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return entity;
        }
      }
      return entity;
    }
    return named[body.toLowerCase()] ?? entity;
  });
}

/** 剥除 script/style 与注释、按块级标签折行、去标签、解码实体、压缩空白 */
function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(
      /<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre|header|footer|nav|ul|ol|table)>/gi,
      '\n'
    )
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(withBreaks)
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function extractTitle(html: string, url: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title) {
    const cleaned = decodeEntities(title[1]).replace(/\s+/g, ' ').trim();
    if (cleaned) return cleaned;
  }
  const og =
    /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html) ??
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i.exec(html);
  if (og) return decodeEntities(og[1]).trim();
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const webSummaryTool: ToolDefinition = {
  name: 'webSummary',
  description: '抓取网页内容并返回标题与正文摘要（仅支持 http/https，自动剥除 HTML 标签）',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的网页完整 URL，例如 https://example.com' },
    },
    required: ['url'],
  },
  async execute(args) {
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    if (!url) {
      throw new Error('缺少网页地址：url 必须为字符串');
    }
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new Error(`URL 格式不合法：${url}`);
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error(`仅支持 http/https 协议，收到：${target.protocol}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(target.toString(), {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': FETCH_UA, Accept: 'text/html,*/*' },
      });
      if (!res.ok) {
        throw new Error(`抓取网页失败（HTTP ${res.status}）：${url}`);
      }
      const html = await res.text();
      const title = extractTitle(html, url);
      const body = htmlToText(html);
      if (!body) {
        throw new Error(`未能从页面提取到正文内容：${url}`);
      }
      const chars = Array.from(body);
      const clipped = chars.slice(0, SUMMARY_MAX_CHARS).join('');
      const truncated = chars.length > SUMMARY_MAX_CHARS ? `…（正文过长，仅保留前 ${SUMMARY_MAX_CHARS} 字）` : '';
      return `标题：${title}\n\n${clipped}${truncated}`;
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`抓取网页超时（${FETCH_TIMEOUT_MS / 1000} 秒）：${url}`);
      }
      if (err instanceof Error) throw err;
      throw new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  },
};

/* =============== 工具 4：searchKnowledge =============== */

const searchKnowledgeTool: ToolDefinition = {
  name: 'searchKnowledge',
  description: '在知识库中检索与查询词相关的文档片段（含来源与相似度得分）',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索关键词或问题' },
      topK: { type: 'number', description: '返回片段数量上限（1~10，默认 3）' },
    },
    required: ['query'],
  },
  async execute(args) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      throw new Error('缺少检索词：query 必须为字符串');
    }
    let topK = 3;
    if (typeof args.topK === 'number' && Number.isFinite(args.topK)) {
      topK = Math.min(Math.max(Math.round(args.topK), 1), 10);
    }
    const { fragments }: KBSearchResult = await searchKB(query, topK);
    if (fragments.length === 0) {
      return '知识库中未检索到相关内容';
    }
    return fragments
      .map((f, i) => `${i + 1}. [score=${f.score.toFixed(3)}] ${f.text}（来源：${f.source}）`)
      .join('\n');
  },
};

/* =============== 工具 5：saveKnowledge（写操作） =============== */

const saveKnowledgeTool: ToolDefinition = {
  name: 'saveKnowledge',
  description: '把一段内容保存为知识库文档（写操作：在文档最多的知识库中新增一篇文档，保存后可被检索）',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '文档标题（同时作为文档名）' },
      content: { type: 'string', description: '要保存的正文内容（纯文本，不能为空）' },
    },
    required: ['title', 'content'],
  },
  async execute(args) {
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const content = typeof args.content === 'string' ? args.content.trim() : '';
    if (!title) throw new Error('缺少文档标题：title 必须为非空字符串');
    if (!content) throw new Error('缺少文档内容：content 必须为非空字符串');
    const kbs = await listKBs();
    // 目标库：文档数最多者（与 searchKB 的选库规则一致）；无库时自动创建「对话笔记」
    let kb = [...kbs].sort(
      (a, b) => b.docCount - a.docCount || b.createdAt.localeCompare(a.createdAt)
    )[0];
    if (!kb) {
      kb = await createKB({ name: '对话笔记' });
    }
    await addDocument(kb.id, { name: title, content });
    return `已保存到知识库「${kb.name}」：文档「${title}」（${Array.from(content).length} 字）`;
  },
};

/* =============== 工具 6：deleteKnowledgeDoc（高危） =============== */

const deleteKnowledgeDocTool: ToolDefinition = {
  name: 'deleteKnowledgeDoc',
  description: '按文档名从知识库中删除一篇文档（高危操作：不可恢复，必须经用户确认后执行）',
  risk: 'danger',
  parameters: {
    type: 'object',
    properties: {
      docName: { type: 'string', description: '要删除的文档名称（需与知识库中的文档名完全一致）' },
    },
    required: ['docName'],
  },
  async execute(args) {
    const docName = typeof args.docName === 'string' ? args.docName.trim() : '';
    if (!docName) throw new Error('缺少文档名称：docName 必须为非空字符串');
    for (const kb of await listKBs()) {
      const doc = kb.documents.find((d) => d.name === docName);
      if (doc) {
        await deleteDocument(kb.id, doc.id);
        return `已从知识库「${kb.name}」删除文档「${docName}」`;
      }
    }
    throw new Error(`知识库中未找到名为「${docName}」的文档`);
  },
};

/* ==================================================================
 * 桌面系统工具集（7~19）：文件 / 文件夹 / 命令行 / 系统信息 / 剪贴板
 * 约定：
 * - 相对路径一律以用户主目录（os.homedir()）为基准解析，工具描述中向模型说明
 * - 删除类操作拒绝盘根、用户主目录及其上级目录、Windows 系统目录等受保护路径
 * - 命令执行带超时强制终止与输出截断，防止挂死或刷爆上下文
 * - 风险分级：read=直执行；write/danger 走对话流中的用户确认卡
 * ================================================================ */

const isWin = process.platform === 'win32';

/** 清理 LLM 传参常见的首尾引号与空白（如 "C:\Users\x" 带引号传入） */
function cleanPathArg(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.trim().replace(/^["']+|["']+$/g, '').trim();
}

/** 相对路径以用户主目录为基准解析为绝对路径；兼容 file:// URL 形式 */
function resolveUserPath(input: string): string {
  let candidate = input;
  if (/^file:\/\//i.test(candidate)) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      // 非法 file:// URL：保留原样，后续按普通路径处理并自然报错
    }
  }
  const abs = path.isAbsolute(candidate) ? candidate : path.join(os.homedir(), candidate);
  return path.normalize(abs);
}

/** Windows 下路径比较统一小写（文件系统不区分大小写） */
function normKey(p: string): string {
  return isWin ? p.toLowerCase() : p;
}

/** 受保护路径：盘根 / 用户主目录及其上级目录 / Windows 系统与程序目录（禁止删除） */
function isProtectedPath(p: string): boolean {
  const norm = path.normalize(p);
  if (path.parse(norm).root === norm) return true;
  const key = normKey(norm);
  const home = path.normalize(os.homedir());
  if (key === normKey(home)) return true;
  if (home.startsWith(norm + path.sep)) return true;
  const systemDirs = [
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData,
  ].filter((dir): dir is string => Boolean(dir));
  return systemDirs.some((dir) => normKey(path.normalize(dir)) === key);
}

/** 字节数人类可读格式化 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

/** 按字符截断（不拆代理对），超长补省略说明 */
function clipChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…（截断，共 ${chars.length} 字）` : chars.join('');
}

/* ---- 工具 7：readTextFile ---- */

const READ_MAX_BYTES = 512 * 1024;
const READ_MAX_CHARS = 8000;

const readTextFileTool: ToolDefinition = {
  name: 'readTextFile',
  description:
    '读取本地文本文件内容（自动识别二进制文件并拒绝；超长内容截断。相对路径以用户主目录为基准）',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，如 Desktop/notes.txt 或绝对路径 C:/Users/x/a.txt' },
    },
    required: ['path'],
  },
  async execute(args) {
    const raw = cleanPathArg(args.path);
    if (!raw) throw new Error('缺少文件路径：path 必须为非空字符串');
    const p = resolveUserPath(raw);
    const stat = await fs.stat(p).catch(() => null);
    if (!stat) throw new Error(`路径不存在：${p}`);
    if (stat.isDirectory()) throw new Error(`目标是文件夹，请用 listDirectory 列出：${p}`);
    const buf = await fs.readFile(p);
    const sliced = buf.length > READ_MAX_BYTES ? buf.subarray(0, READ_MAX_BYTES) : buf;
    if (sliced.subarray(0, 4096).includes(0)) {
      throw new Error(`疑似二进制文件，不支持按文本读取：${p}`);
    }
    const text = sliced.toString('utf8');
    const sizeNote =
      buf.length > READ_MAX_BYTES
        ? `（文件 ${formatBytes(buf.length)}，仅读取前 ${formatBytes(READ_MAX_BYTES)}）`
        : '';
    const notes = [`文件：${p}`, `大小：${formatBytes(buf.length)}${sizeNote}`, '', '--- 内容 ---'];
    return [...notes, clipChars(text, READ_MAX_CHARS)].join('\n');
  },
};

/* ---- 工具 8：writeTextFile ---- */

const WRITE_MAX_CHARS = 2_000_000;

const writeTextFileTool: ToolDefinition = {
  name: 'writeTextFile',
  description:
    '把文本内容写入本地文件，支持覆盖（overwrite）与追加（append）两种模式；父目录不存在时自动创建（写操作：需用户确认后执行）',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件路径（相对路径以用户主目录为基准）' },
      content: { type: 'string', description: '要写入的文本内容' },
      mode: {
        type: 'string',
        enum: ['overwrite', 'append'],
        description: '写入模式：overwrite 覆盖原文件（默认）/ append 追加到文件末尾',
      },
    },
    required: ['path', 'content'],
  },
  async execute(args) {
    const raw = cleanPathArg(args.path);
    if (!raw) throw new Error('缺少文件路径：path 必须为非空字符串');
    const content = typeof args.content === 'string' ? args.content : '';
    if (Array.from(content).length > WRITE_MAX_CHARS) {
      throw new Error(`写入内容过长（上限 ${WRITE_MAX_CHARS} 字），请分批写入`);
    }
    const append = args.mode === 'append';
    const p = resolveUserPath(raw);
    await fs.mkdir(path.dirname(p), { recursive: true });
    if (append) await fs.appendFile(p, content, 'utf8');
    else await fs.writeFile(p, content, 'utf8');
    const stat = await fs.stat(p);
    return `${append ? '已追加写入' : '已写入'}文件：${p}（本次 ${Array.from(content).length} 字，文件现大小 ${formatBytes(stat.size)}）`;
  },
};

/* ---- 工具 9：listDirectory ---- */

const LIST_MAX_ENTRIES = 200;

const listDirectoryTool: ToolDefinition = {
  name: 'listDirectory',
  description:
    '列出文件夹内容，返回名称、类型、大小与修改时间（不传 path 时默认列出用户主目录）',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径（可省略，默认用户主目录；相对路径以主目录为基准）' },
    },
    required: [],
  },
  async execute(args) {
    const raw = cleanPathArg(args.path);
    const p = raw ? resolveUserPath(raw) : os.homedir();
    const stat = await fs.stat(p).catch(() => null);
    if (!stat) throw new Error(`路径不存在：${p}`);
    if (!stat.isDirectory()) throw new Error(`目标不是文件夹：${p}`);
    const dirents = await fs.readdir(p, { withFileTypes: true });
    const sorted = [...dirents].sort((a, b) =>
      a.isDirectory() !== b.isDirectory() ? (a.isDirectory() ? -1 : 1) : a.name.localeCompare(b.name)
    );
    const shown = sorted.slice(0, LIST_MAX_ENTRIES);
    const lines = await Promise.all(
      shown.map(async (entry) => {
        const full = path.join(p, entry.name);
        if (entry.isDirectory()) return `[目录] ${entry.name}/`;
        if (entry.isSymbolicLink()) return `[链接] ${entry.name}`;
        const s = await fs.stat(full).catch(() => null);
        const meta = s ? `${formatBytes(s.size)} · ${s.mtime.toLocaleString('zh-CN', { hour12: false })}` : '元数据不可读';
        return `[文件] ${entry.name}（${meta}）`;
      })
    );
    const omitted = sorted.length - shown.length;
    const header = `目录：${p}\n共 ${sorted.length} 项${omitted > 0 ? `（仅显示前 ${LIST_MAX_ENTRIES} 项，建议用 searchFiles 缩小范围）` : ''}`;
    return [header, ...lines].join('\n');
  },
};

/* ---- 工具 10：createDirectory ---- */

const createDirectoryTool: ToolDefinition = {
  name: 'createDirectory',
  description: '递归创建文件夹（父目录不存在时一并创建；已存在视为成功）（写操作：需用户确认后执行）',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要创建的文件夹路径（相对路径以用户主目录为基准）' },
    },
    required: ['path'],
  },
  async execute(args) {
    const raw = cleanPathArg(args.path);
    if (!raw) throw new Error('缺少目录路径：path 必须为非空字符串');
    const p = resolveUserPath(raw);
    if (isProtectedPath(p)) throw new Error(`拒绝在受保护路径下操作：${p}`);
    await fs.mkdir(p, { recursive: true });
    return `文件夹已就绪：${p}`;
  },
};

/* ---- 工具 11：deletePath ---- */

const deletePathTool: ToolDefinition = {
  name: 'deletePath',
  description:
    '删除本地文件或整个文件夹（文件夹连同全部内容递归删除，不可恢复）。盘根、用户主目录及其上级目录、Windows 系统目录受保护不可删除（高危操作：必须经用户确认后执行）',
  risk: 'danger',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要删除的文件或文件夹路径（相对路径以用户主目录为基准）' },
    },
    required: ['path'],
  },
  async execute(args) {
    const raw = cleanPathArg(args.path);
    if (!raw) throw new Error('缺少路径：path 必须为非空字符串');
    const p = resolveUserPath(raw);
    if (isProtectedPath(p)) {
      throw new Error(`拒绝删除受保护路径：${p}（盘根、用户主目录及其上级目录、系统目录不可删除）`);
    }
    const stat = await fs.stat(p).catch(() => null);
    if (!stat) throw new Error(`路径不存在：${p}`);
    await fs.rm(p, { recursive: true, force: true });
    return `已删除${stat.isDirectory() ? '文件夹（含全部内容）' : '文件'}：${p}`;
  },
};

/* ---- 工具 12：movePath ---- */

const movePathTool: ToolDefinition = {
  name: 'movePath',
  description:
    '移动或重命名文件/文件夹（目标已存在时拒绝覆盖；跨盘移动自动降级为复制后删除）（写操作：需用户确认后执行）',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '源文件/文件夹路径' },
      destination: { type: 'string', description: '目标路径（不可与现有路径重名）' },
    },
    required: ['source', 'destination'],
  },
  async execute(args) {
    const srcRaw = cleanPathArg(args.source);
    const dstRaw = cleanPathArg(args.destination);
    if (!srcRaw || !dstRaw) throw new Error('缺少参数：source 与 destination 必须为非空字符串');
    const src = resolveUserPath(srcRaw);
    const dst = resolveUserPath(dstRaw);
    const srcStat = await fs.stat(src).catch(() => null);
    if (!srcStat) throw new Error(`源路径不存在：${src}`);
    if (await fs.stat(dst).catch(() => null)) throw new Error(`目标已存在，拒绝覆盖：${dst}`);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    try {
      await fs.rename(src, dst);
    } catch {
      // 跨盘 rename 失败（EXDEV 等）：降级为复制后删除
      await fs.cp(src, dst, { recursive: true });
      await fs.rm(src, { recursive: true, force: true });
    }
    return `已${srcStat.isDirectory() ? '移动文件夹' : '移动文件'}：${src} → ${dst}`;
  },
};

/* ---- 工具 13：copyPath ---- */

const copyPathTool: ToolDefinition = {
  name: 'copyPath',
  description: '复制文件或整个文件夹（含全部子内容；目标已存在时拒绝覆盖）（写操作：需用户确认后执行）',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '源文件/文件夹路径' },
      destination: { type: 'string', description: '目标路径（不可与现有路径重名）' },
    },
    required: ['source', 'destination'],
  },
  async execute(args) {
    const srcRaw = cleanPathArg(args.source);
    const dstRaw = cleanPathArg(args.destination);
    if (!srcRaw || !dstRaw) throw new Error('缺少参数：source 与 destination 必须为非空字符串');
    const src = resolveUserPath(srcRaw);
    const dst = resolveUserPath(dstRaw);
    const srcStat = await fs.stat(src).catch(() => null);
    if (!srcStat) throw new Error(`源路径不存在：${src}`);
    if (await fs.stat(dst).catch(() => null)) throw new Error(`目标已存在，拒绝覆盖：${dst}`);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.cp(src, dst, { recursive: true, errorOnExist: true, force: false });
    return `已复制${srcStat.isDirectory() ? '文件夹（含全部内容）' : '文件'}：${src} → ${dst}`;
  },
};

/* ---- 工具 14：searchFiles ---- */

const SEARCH_MAX_RESULTS_CAP = 200;
const SEARCH_SKIP_DIRS = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information']);

/** 通配符（* ?）转大小写不敏感正则，其余字符按字面匹配 */
function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

const searchFilesTool: ToolDefinition = {
  name: 'searchFiles',
  description:
    '在指定目录中按文件名通配符递归搜索文件（支持 * 与 ?；自动跳过 node_modules 与 .git 等目录）',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '搜索起始目录（可省略，默认用户主目录）' },
      pattern: { type: 'string', description: '文件名匹配模式，如 *.pdf、report??.docx、*日程*' },
      maxDepth: { type: 'number', description: '递归深度上限（1~8，默认 4）' },
      maxResults: { type: 'number', description: '返回结果数量上限（1~200，默认 50）' },
    },
    required: ['pattern'],
  },
  async execute(args) {
    const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
    if (!pattern) throw new Error('缺少匹配模式：pattern 必须为非空字符串');
    const rawDir = cleanPathArg(args.dir);
    const root = rawDir ? resolveUserPath(rawDir) : os.homedir();
    const rootStat = await fs.stat(root).catch(() => null);
    if (!rootStat || !rootStat.isDirectory()) throw new Error(`起始目录不存在或不是文件夹：${root}`);
    let maxDepth = 4;
    if (typeof args.maxDepth === 'number' && Number.isFinite(args.maxDepth)) {
      maxDepth = Math.min(Math.max(Math.round(args.maxDepth), 1), 8);
    }
    let maxResults = 50;
    if (typeof args.maxResults === 'number' && Number.isFinite(args.maxResults)) {
      maxResults = Math.min(Math.max(Math.round(args.maxResults), 1), SEARCH_MAX_RESULTS_CAP);
    }
    const regex = wildcardToRegex(pattern);
    const results: string[] = [];
    const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
    while (queue.length > 0 && results.length < maxResults) {
      const { dir, depth } = queue.shift()!;
      let dirents;
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // 无权限 / 已被删除的子目录：跳过
      }
      for (const entry of dirents) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < maxDepth && !SEARCH_SKIP_DIRS.has(entry.name)) {
            queue.push({ dir: full, depth: depth + 1 });
          }
        } else if (regex.test(entry.name)) {
          results.push(full);
          if (results.length >= maxResults) break;
        }
      }
    }
    if (results.length === 0) return `在「${root}」中未找到匹配「${pattern}」的文件`;
    return [
      `在「${root}」中找到 ${results.length} 个匹配「${pattern}」的文件：`,
      ...results.map((r, i) => `${i + 1}. ${r}`),
    ].join('\n');
  },
};

/* ---- 工具 15：runCommand ---- */

const COMMAND_MAX_TIMEOUT_SEC = 300;
const COMMAND_OUTPUT_MAX_CHARS = 6000;
/** 子进程输出缓冲上限（超出后停止拼接，继续排空防止管道阻塞） */
const SHELL_OUTPUT_CAP = 200_000;

interface ShellOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * 执行 shell 命令：Windows 支持 cmd / PowerShell，macOS/Linux 走 /bin/sh。
 * 超时强制终止；stdout/stderr 各自封顶缓冲；可选通过 stdin 注入文本（剪贴板写入用）。
 */
function runShell(
  command: string,
  shell: 'auto' | 'cmd' | 'powershell',
  cwd: string | undefined,
  timeoutMs: number,
  stdinText?: string
): Promise<ShellOutcome> {
  return new Promise((resolve) => {
    let exe: string;
    let args: string[];
    let spawnOpts: { windowsVerbatimArguments?: boolean } = {};
    // 中文 Windows 下 PowerShell/cmd 重定向输出默认走 OEM 代码页（GBK），
    // 统一强制 UTF-8 输出，避免 Node 侧按 UTF-8 解码出现乱码
    if (shell === 'cmd') {
      if (!isWin) {
        resolve({ code: null, stdout: '', stderr: 'cmd 仅在 Windows 上可用', timedOut: false });
        return;
      }
      exe = 'cmd.exe';
      // cmd.exe 不认 MSVCRT 的 \" 转义，必须原样传参（否则命令里的引号被破坏成反斜杠）
      args = ['/d', '/s', '/c', `chcp 65001>nul & ${command}`];
      spawnOpts = { windowsVerbatimArguments: true };
    } else if (shell === 'powershell') {
      exe = isWin ? 'powershell.exe' : 'pwsh';
      args = ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`];
    } else {
      exe = isWin ? 'powershell.exe' : '/bin/sh';
      args = isWin
        ? ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`]
        : ['-c', command];
    }
    let child;
    try {
      child = spawn(exe, args, { cwd: cwd || undefined, windowsHide: true, ...spawnOpts });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: `命令启动失败：${err instanceof Error ? err.message : String(err)}`, timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < SHELL_OUTPUT_CAP) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < SHELL_OUTPUT_CAP) stderr += chunk.toString();
    });
    if (typeof stdinText === 'string') {
      child.stdin?.write(stdinText);
      child.stdin?.end();
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // 进程可能已退出：忽略
      }
    }, timeoutMs);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}`.trim(), timedOut });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** 把 ShellOutcome 格式化为面向模型的观察文本 */
function formatShellOutcome(out: ShellOutcome): string {
  const lines = [`退出码：${out.code ?? '无（启动失败或被终止）'}`];
  if (out.timedOut) lines.push('状态：执行超时，已被强制终止');
  const stdout = clipChars(out.stdout.replace(/\r\n/g, '\n'), COMMAND_OUTPUT_MAX_CHARS);
  if (stdout.trim()) lines.push('--- 标准输出 ---', stdout);
  const stderr = clipChars(out.stderr.replace(/\r\n/g, '\n'), 2000);
  if (stderr.trim()) lines.push('--- 错误输出 ---', stderr);
  return lines.join('\n');
}

/**
 * 以「可见窗口」方式启动目标程序（Windows）。
 *
 * 为什么不用 start / Start-Process / WScript.Shell 直接跑（均为实测结论，非理论）：
 * - 服务端进程树运行在无控制台环境中，start 开出的新控制台继承隐藏显示状态；
 * - Node 默认参数转义（" → \"）与 cmd 引号规则冲突，start "标题" 程序 被解析成找文件 \标题\；
 * - detached 投递的 PowerShell 在应用进程树中不执行命令（已用 Start-Process 副作用验证）；
 * - WScript.Shell.Run 在该上下文中返回成功但子进程凭空消失；
 * - PS Start-Process（UseShellExecute=false 路径）+ -WindowStyle Normal 依旧不可见；
 * - 唯一稳定可见：.NET ProcessStartInfo{ UseShellExecute=true, WindowStyle=Normal }
 *   （ShellExecute 语义，支持应用名 / PATH / App Paths / URL / 文档），
 *   且须由「非 detached + windowsHide 隐藏」的 PowerShell 执行（与捕获模式同环境，已实测开窗可见，
 *   窗口在 PS 退出后继续存活）。
 */
function shellExecutePs(target: string, argsRaw: string, workDir: string): string {
  const escaped = (s: string): string => s.replace(/'/g, "''");
  // 未指定目录时落在用户主目录（而非继承服务进程的安装目录）
  const dir = workDir || os.homedir();
  let props = `FileName='${escaped(target)}'; UseShellExecute=$true; WindowStyle='Normal'; WorkingDirectory='${escaped(dir)}'`;
  if (argsRaw) props += `; Arguments='${escaped(argsRaw)}'`;
  return `$psi = New-Object System.Diagnostics.ProcessStartInfo -Property @{ ${props} }; [void][System.Diagnostics.Process]::Start($psi)`;
}

/** 拆分「程序 + 参数」目标：首段（支持引号包裹）为程序，其余原样作为 Arguments */
function splitTarget(target: string): { program: string; argsRaw: string } {
  if (target.startsWith('"')) {
    const end = target.indexOf('"', 1);
    if (end > 0) return { program: target.slice(1, end), argsRaw: target.slice(end + 1).trim() };
  }
  const sp = target.indexOf(' ');
  if (sp < 0) return { program: target, argsRaw: '' };
  return { program: target.slice(0, sp), argsRaw: target.slice(sp + 1).trim() };
}

function launchViaShell(target: string, cwd: string | undefined): void {
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', shellExecutePs(target, '', '')], {
    cwd: cwd || undefined,
    windowsHide: true,
    stdio: 'ignore',
  }).unref();
}

/** 剥离 start 的窗口开关（/MIN /MAX /D path 等），返回要启动的程序与参数 */
function stripStartFlags(rest: string): string {
  let s = rest;
  for (;;) {
    const flag = s.match(/^\/(min|max|b|i|low|normal|realtime|abovenormal|belownormal|separate|shared|wait|elevate|node|affinity)\b\s*/i);
    if (flag) {
      s = s.slice(flag[0].length);
      continue;
    }
    const dPath = s.match(/^\/d\s+"[^"]*"\s*/i) ?? s.match(/^\/d\s+\S+\s*/i);
    if (dPath) {
      s = s.slice(dPath[0].length);
      continue;
    }
    return s.trim();
  }
}

/**
 * 从 start 命令提取启动目标：`start "标题" 程序 参数` / `start 程序 参数` /
 * `start "" 程序`。引号内首 token 按语义判断——存在同路径则视为程序（连同后续参数），
 * 否则视为窗口标题丢弃（标题仅影响窗口命名，不影响启动目标本身）。
 */
function extractLaunchTarget(command: string): string {
  let rest = command
    .replace(/^\s*cmd(?:\.exe)?\s+\/c\s+/i, '')
    .replace(/^\s*start\s+/i, '')
    .trim();
  rest = stripStartFlags(rest);
  const quoted = rest.match(/^"([^"]*)"\s*(.*)$/);
  if (quoted) {
    const [, inner, tail] = quoted;
    if (inner === '') rest = tail; // start "" 程序：空标题
    else if (existsSync(resolveUserPath(inner))) rest = `${inner} ${tail}`.trim(); // 引号内是程序路径
    else rest = tail || inner; // 引号内是窗口标题
  }
  return rest.trim();
}

/**
 * 将 Start-Process 命令翻译为 .NET ShellExecute 启动脚本。
 * Start-Process 底层走 UseShellExecute=false，在无控制台父进程中开不出可见窗口，
 * 故解析 FilePath / -ArgumentList / -WorkingDirectory 后改走 ShellExecute 路径。
 */
function translateStartProcess(command: string): string | null {
  const m = command.match(/^\s*Start-Process\s+/i);
  if (!m) return null;
  const rest = command.slice(m[0].length).trim();
  const takeValue = (name: string): string | undefined => {
    const vm = rest.match(new RegExp(`-${name}\\s+"([^"]*)"|-${name}\\s+'([^']*)'|-${name}\\s+(\\S+)`, 'i'));
    return vm ? (vm[1] ?? vm[2] ?? vm[3]) : undefined;
  };
  let filePath = takeValue('FilePath');
  if (!filePath) {
    const fm = rest.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
    if (fm) filePath = fm[1] ?? fm[2] ?? fm[3];
  }
  if (!filePath) return null;
  const workDir = takeValue('WorkingDirectory') ?? '';
  let argsRaw = '';
  const am = rest.match(/-ArgumentList\s+@?\(?([^)]*)\)?/i);
  if (am) {
    const tokens = am[1].match(/'([^']*)'|"([^"]*)"|([^\s,()]+)/g) ?? [];
    argsRaw = tokens
      .map((t) => (t.startsWith("'") || t.startsWith('"') ? t.slice(1, -1) : t))
      .filter((t) => t.length > 0)
      .map((t) => (/\s/.test(t) ? `"${t}"` : t))
      .join(' ');
  }
  return shellExecutePs(filePath, argsRaw, workDir);
}

/**
 * 以「可见窗口」方式执行开窗口型命令（runCommand 的 start / Start-Process 分支）。
 * 投递方式：非 detached + windowsHide 隐藏 PowerShell（与捕获模式同环境），
 * 由 .NET ShellExecute 打开目标——可见性机制详见 shellExecutePs 注释的实测结论。
 */
function launchVisibleCommand(command: string, cwd: string | undefined): void {
  if (!isWin) {
    spawn('/bin/sh', ['-c', command], {
      cwd: cwd || undefined,
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }
  // start 语法目标形如 `cmd /k "cd /d D:\hello"`：首段是程序，其余必须走 Arguments
  // （整串塞进 FileName 会被 ShellExecute 当成带空格的路径而静默失败）
  const { program, argsRaw } = splitTarget(extractLaunchTarget(command));
  const ps = translateStartProcess(command) ?? shellExecutePs(program, argsRaw, cwd ?? '');
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    cwd: cwd || undefined,
    windowsHide: true,
    stdio: 'ignore',
  }).unref();
}

/** 窗口启动型命令：以打开可见窗口为目的（start / Start-Process），不捕获输出 */
const LAUNCH_INTENT_RE = /^\s*(?:start\s+|cmd(?:\.exe)?\s+\/c\s+start\s+|Start-Process\s+)/i;

function isLaunchIntentCommand(command: string): boolean {
  return LAUNCH_INTENT_RE.test(command);
}

const runCommandTool: ToolDefinition = {
  name: 'runCommand',
  description:
    '在用户电脑上执行命令并返回输出（Windows 默认 PowerShell，可指定 cmd；macOS/Linux 用 sh）。支持工作目录与超时；start / Start-Process 等开窗口命令会以独立可见窗口启动且无输出。高危操作：执行前会向用户说明并等待确认',
  risk: 'danger',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令，如 Get-ChildItem C:/ 或 node -v' },
      cwd: { type: 'string', description: '工作目录（可省略；相对路径以用户主目录为基准）' },
      timeoutSec: { type: 'number', description: '超时秒数（1~300，默认 30；超时强制终止）' },
      shell: {
        type: 'string',
        enum: ['auto', 'cmd', 'powershell'],
        description: 'shell 选择：auto 平台默认（Windows=PowerShell）/ cmd / powershell',
      },
    },
    required: ['command'],
  },
  async execute(args) {
    const command = typeof args.command === 'string' ? args.command.trim() : '';
    if (!command) throw new Error('缺少命令：command 必须为非空字符串');
    let cwd: string | undefined;
    const rawCwd = cleanPathArg(args.cwd);
    if (rawCwd) {
      cwd = resolveUserPath(rawCwd);
      const cwdStat = await fs.stat(cwd).catch(() => null);
      if (!cwdStat || !cwdStat.isDirectory()) throw new Error(`工作目录不存在或不是文件夹：${cwd}`);
    }
    let timeoutSec = 30;
    if (typeof args.timeoutSec === 'number' && Number.isFinite(args.timeoutSec)) {
      timeoutSec = Math.min(Math.max(Math.round(args.timeoutSec), 1), COMMAND_MAX_TIMEOUT_SEC);
    }
    const shell = args.shell === 'cmd' || args.shell === 'powershell' ? args.shell : 'auto';
    // start / Start-Process 类命令以「打开可见窗口」为目的：改走独立可见进程启动，
    // 否则窗口会继承隐藏控制台的隐藏属性，用户看不到任何窗口
    if (isLaunchIntentCommand(command)) {
      launchVisibleCommand(command, cwd);
      return [
        `命令：${clipChars(command, 200)}`,
        '结果：已提交到独立窗口进程执行（该命令会打开新窗口，无输出可捕获）。',
        '注意：仅表示已启动，无法确认窗口内程序是否成功；如需获取命令输出请改用不带 start 的形式。',
      ].join('\n');
    }
    const out = await runShell(command, shell, cwd, timeoutSec * 1000);
    return [`命令：${clipChars(command, 200)}`, ...(cwd ? [`工作目录：${cwd}`] : []), formatShellOutcome(out)].join('\n');
  },
};

/* ---- 工具 16：openPath ---- */

const openPathTool: ToolDefinition = {
  name: 'openPath',
  description:
    '用系统默认程序打开目标：网页（http/https）、本地文件或文件夹，也可按应用名启动程序（如 cmd / notepad / explorer / calc）。打开终端窗口、应用请用本工具。写操作：需用户确认后执行',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: '网址（http/https）、本地路径，或应用名（如 cmd、notepad、explorer）',
      },
    },
    required: ['target'],
  },
  async execute(args) {
    const raw = cleanPathArg(args.target);
    if (!raw) throw new Error('缺少打开目标：target 必须为非空字符串');
    if (/^https?:\/\//i.test(raw)) {
      try {
        if (isWin) launchViaShell(raw, undefined);
        else {
          spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [raw], {
            detached: true,
            stdio: 'ignore',
          }).unref();
        }
        return `已请求默认浏览器打开：${raw}`;
      } catch (err) {
        throw new Error(`打开网页失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const p = resolveUserPath(raw);
    const stat = await fs.stat(p).catch(() => null);
    if (!stat) {
      // 不是 URL 也不是本地路径：按应用名 / 命令名启动（ShellExecute 语义可解析 PATH 与 App Paths）
      try {
        if (isWin) launchViaShell(raw, undefined);
        else {
          spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [raw], {
            detached: true,
            stdio: 'ignore',
          }).unref();
        }
      } catch (err) {
        throw new Error(`打开失败：${err instanceof Error ? err.message : String(err)}`);
      }
      return `已请求系统打开应用或目标：${raw}`;
    }
    try {
      if (isWin) launchViaShell(p, undefined);
      else {
        spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [p], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      }
    } catch (err) {
      throw new Error(`打开失败：${err instanceof Error ? err.message : String(err)}`);
    }
    return `已请求系统打开${stat.isDirectory() ? '文件夹' : '文件'}：${p}`;
  },
};

/* ---- 工具 17：getSystemInfo ---- */

const getSystemInfoTool: ToolDefinition = {
  name: 'getSystemInfo',
  description: '获取运行环境信息：操作系统、架构、CPU、内存、用户目录、临时目录等',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute() {
    const cpus = os.cpus();
    return [
      `操作系统：${os.type()} ${os.release()}（${os.platform()}）`,
      `架构：${os.arch()}`,
      `主机名：${os.hostname()}`,
      `CPU：${cpus[0]?.model ?? '未知'} × ${cpus.length} 核`,
      `内存：共 ${formatBytes(os.totalmem())}，可用 ${formatBytes(os.freemem())}`,
      `用户主目录：${os.homedir()}`,
      `临时目录：${os.tmpdir()}`,
      `服务端工作目录：${process.cwd()}`,
      `Node 版本：${process.version}`,
      `系统运行时长：${Math.round(os.uptime() / 3600)} 小时`,
    ].join('\n');
  },
};

/* ---- 工具 18：readClipboard ---- */

const CLIPBOARD_MAX_CHARS = 4000;

const readClipboardTool: ToolDefinition = {
  name: 'readClipboard',
  description: '读取系统剪贴板中的文本内容（仅支持文本；图片等非文本内容返回提示）',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute() {
    let text = '';
    if (isWin) {
      const out = await runShell('Get-Clipboard -Raw', 'powershell', undefined, 8000);
      if (out.code !== 0 && !out.stdout.trim()) {
        throw new Error(`读取剪贴板失败：${clipChars(out.stderr, 200)}`);
      }
      text = out.stdout.replace(/\r?\n$/, '');
    } else if (process.platform === 'darwin') {
      const out = await runShell('pbpaste', 'auto', undefined, 8000);
      text = out.stdout;
    } else {
      const out = await runShell('xclip -selection clipboard -o', 'auto', undefined, 8000);
      text = out.stdout;
    }
    if (!text.trim()) return '剪贴板为空或不含可读文本（可能存放的是图片等非文本内容）';
    return `剪贴板文本（${Array.from(text).length} 字）：\n${clipChars(text, CLIPBOARD_MAX_CHARS)}`;
  },
};

/* ---- 工具 19：writeClipboard ---- */

const writeClipboardTool: ToolDefinition = {
  name: 'writeClipboard',
  description: '把文本内容写入系统剪贴板（写操作：需用户确认后执行）',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要写入剪贴板的文本' },
    },
    required: ['text'],
  },
  async execute(args) {
    const text = typeof args.text === 'string' ? args.text : '';
    if (!text.trim()) throw new Error('缺少文本内容：text 必须为非空字符串');
    if (isWin) {
      // 多行文本经临时文件中转，规避 PowerShell 命令行引号转义问题
      const tmp = path.join(os.tmpdir(), `dra-clipboard-${Date.now()}.txt`);
      await fs.writeFile(tmp, text, 'utf8');
      try {
        const out = await runShell(
          `Get-Content -LiteralPath '${tmp}' -Raw -Encoding UTF8 | Set-Clipboard`,
          'powershell',
          undefined,
          8000
        );
        if (out.code !== 0) {
          throw new Error(`写入剪贴板失败：${clipChars(out.stderr, 200)}`);
        }
      } finally {
        await fs.rm(tmp, { force: true });
      }
    } else if (process.platform === 'darwin') {
      const out = await runShell('pbcopy', 'auto', undefined, 8000, text);
      if (out.code !== 0) throw new Error(`写入剪贴板失败：${clipChars(out.stderr, 200)}`);
    } else {
      const out = await runShell('xclip -selection clipboard -i', 'auto', undefined, 8000, text);
      if (out.code !== 0) throw new Error(`写入剪贴板失败（可能未安装 xclip）：${clipChars(out.stderr, 200)}`);
    }
    return `已写入剪贴板（${Array.from(text).length} 字）`;
  },
};

/* =============== 注册表与统一执行入口 =============== */

const TOOLS: ToolDefinition[] = [
  getCurrentTimeTool,
  calculatorTool,
  webSummaryTool,
  searchKnowledgeTool,
  saveKnowledgeTool,
  deleteKnowledgeDocTool,
  readTextFileTool,
  writeTextFileTool,
  listDirectoryTool,
  createDirectoryTool,
  deletePathTool,
  movePathTool,
  copyPathTool,
  searchFilesTool,
  runCommandTool,
  openPathTool,
  getSystemInfoTool,
  readClipboardTool,
  writeClipboardTool,
];

const registry = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** 导出全部内置工具的 schema（随 /api/chat 透传给上游模型，带风险分级） */
export function listToolSchemas(): ToolSchema[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    risk: tool.risk ?? 'read',
  }));
}

/** 查询工具风险分级（未知工具返回 undefined） */
export function getToolRisk(name: string): ToolRisk | undefined {
  return registry.get(name)?.risk;
}

/** 从 JSON Schema 中读取 required 字段名列表 */
function requiredParams(tool: ToolDefinition): string[] {
  const required = (tool.parameters as { required?: unknown }).required;
  return Array.isArray(required) ? required.filter((n): n is string => typeof n === 'string') : [];
}

/**
 * 统一执行入口：解析 argsJson → 未知工具 / 风险授权 / 缺必填参数校验 → 执行。
 * 任何失败都以 {ok:false, error} 返回，工具内部异常同样兜底，绝不抛出。
 * 写（write）/ 高危（danger）工具未经 confirmed=true 授权时拒绝执行。
 */
export async function executeTool(
  name: string,
  argsJson: string,
  confirmed = false
): Promise<ToolExecutionResult> {
  const tool = registry.get(name);
  if (!tool) {
    return { ok: false, error: `未知工具：${name}（可用工具：${[...registry.keys()].join('、')}）` };
  }
  const risk = tool.risk ?? 'read';
  if ((risk === 'write' || risk === 'danger') && !confirmed) {
    return {
      ok: false,
      error: `工具 ${name} 为${risk === 'danger' ? '高危' : '写'}操作，需用户授权后执行`,
    };
  }

  let args: Record<string, unknown> = {};
  const trimmed = argsJson.trim();
  if (trimmed) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `参数解析失败（应为 JSON 对象字符串）：${reason}` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: '参数必须是 JSON 对象（键值对）' };
    }
    args = parsed as Record<string, unknown>;
  }

  for (const key of requiredParams(tool)) {
    const value = args[key];
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
      return { ok: false, error: `缺少必填参数：${key}` };
    }
  }

  try {
    const result = await tool.execute(args);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
