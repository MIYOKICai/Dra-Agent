/**
 * 服务端内置工具注册表：供 Agent 节点（function calling）与 /api/tools/* 端点使用。
 * - listToolSchemas()：导出 ToolSchema 列表（随 /api/chat 的 tools 参数透传给上游模型）
 * - executeTool(name, argsJson)：统一执行入口；参数解析失败 / 未知工具 / 缺必填参数 /
 *   工具内部异常一律转换为结果对象返回，绝不向路由层抛出异常。
 */
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

/* =============== 注册表与统一执行入口 =============== */

const TOOLS: ToolDefinition[] = [
  getCurrentTimeTool,
  calculatorTool,
  webSummaryTool,
  searchKnowledgeTool,
  saveKnowledgeTool,
  deleteKnowledgeDocTool,
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
