/**
 * 助手消息代码块（参考对话式创作页样式）：
 * - 头部左侧语言标签（html / css / js…），右侧 复制 / 下载 /（HTML|SVG 时）运行
 * - 代码体灰阶语法高亮（遵循画布单色系约束：关键字/字符串提亮、注释弱化斜体），
 *   横向滚动、超高内滚
 * - 「运行」通过 onRun 回调把代码交给宿主（创作面板右侧内嵌预览列，分栏展示），本组件不弹窗
 * - MessageContent：把含 ``` 围栏的助手消息按 文本/代码块 顺序渲染（流式期间未闭合
 *   围栏按代码段处理，打字过程中代码块实时出现）；文本段经 react-markdown 渲染
 *   标题 / 加粗 / 列表 / 表格等（remark-gfm 表格 + remark-breaks 单换行成硬换行），
 *   组件样式全部单色系覆盖
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { IconCopy, IconDownload, IconPlay } from './icons';
import { useUiStore } from '../store/uiStore';
import { parseMessageSegments } from '../lib/messageSegments';

/* ============================ 彩色语法高亮 ============================ */

type TokKind = '' | 'kw' | 'str' | 'num' | 'attr' | 'com' | 'fn' | 'prop' | 'id';
interface Tok {
  t: string;
  c: TokKind;
}

/**
 * token 配色（VS Code Light 风格，参考用户提供的样例图）：
 * 关键字紫 / 字符串砖红 / 标识符亮蓝 / 对象键与成员海军蓝 / 函数名棕 /
 * 数字蓝 / 属性赭橙 / 注释灰斜体；标点与正文深墨。仅代码块用彩色，其余界面保持单色系
 */
const TOKEN_CLASS: Record<TokKind, string> = {
  '': 'text-ink',
  kw: 'text-[#a626a4]',
  str: 'text-[#a31515]',
  num: 'text-[#0550ae]',
  attr: 'text-[#953800]',
  com: 'text-[#6e7781] italic',
  fn: 'text-[#795e26]',
  prop: 'text-[#0451a5]',
  id: 'text-[#2b7fff]',
};

/** 全局扫描：按 re 切分，匹配处经 classify 产出 token，间隙为正文 */
function scan(code: string, re: RegExp, classify: (m: RegExpExecArray) => Tok[]): Tok[] {
  const toks: Tok[] = [];
  let last = 0;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m.index > last) toks.push({ t: code.slice(last, m.index), c: '' });
    toks.push(...classify(m));
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex += 1; // 零长匹配防护
  }
  if (last < code.length) toks.push({ t: code.slice(last), c: '' });
  return toks;
}

/** JS / TS / JSON 及类 C 语言（注释、字符串、关键字、数字、函数名、对象键、成员、标识符） */
const JS_RE =
  /(\/\*[\s\S]*?(?:\*\/|$))|(\/\/[^\n]*)|(`(?:\\[\s\S]|[^`\\])*`?|"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?)|\b(const|let|var|function|return|if|else|for|while|do|switch|case|default|break|continue|new|class|extends|super|import|export|from|as|async|await|try|catch|finally|throw|typeof|instanceof|delete|void|in|of|this|null|undefined|true|false)\b|\b(0x[\da-fA-F]+|\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$]*)(?=\s*\()|\b([A-Za-z_$][\w$]*)(?=\s*:)|(?<=\.)([A-Za-z_$][\w$]*)|\b([A-Za-z_$][\w$]*)\b/g;

function jsClassify(m: RegExpExecArray): Tok[] {
  if (m[1] || m[2]) return [{ t: m[0], c: 'com' }];
  if (m[3]) return [{ t: m[0], c: 'str' }];
  if (m[4]) return [{ t: m[0], c: 'kw' }];
  if (m[5]) return [{ t: m[0], c: 'num' }];
  if (m[6]) return [{ t: m[0], c: 'fn' }]; // 后随「(」→ 函数名
  if (m[7]) return [{ t: m[0], c: 'prop' }]; // 后随「:」→ 对象键
  if (m[8]) return [{ t: m[0], c: 'prop' }]; // 前随「.」→ 成员属性
  return [{ t: m[0], c: 'id' }]; // 其余标识符
}

/** Python（# 注释、三引号字符串、函数名、标识符） */
const PY_RE =
  /(#[^\n]*)|("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?)|\b(def|class|return|if|elif|else|for|while|in|not|and|or|import|from|as|with|try|except|finally|raise|lambda|pass|break|continue|global|None|True|False|self|print)\b|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_][\w]*)(?=\s*\()|\b([A-Za-z_][\w]*)\b/g;

function pyClassify(m: RegExpExecArray): Tok[] {
  if (m[1]) return [{ t: m[0], c: 'com' }];
  if (m[2]) return [{ t: m[0], c: 'str' }];
  if (m[3]) return [{ t: m[0], c: 'kw' }];
  if (m[4]) return [{ t: m[0], c: 'num' }];
  if (m[5]) return [{ t: m[0], c: 'fn' }];
  return [{ t: m[0], c: 'id' }];
}

/** CSS / SCSS（注释、字符串、十六进制色值、@规则、整条选择器链、属性、函数名、数值单位） */
const CSS_RE =
  /(\/\*[\s\S]*?(?:\*\/|$))|("(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?)|(#[\da-fA-F]{3,8}\b)|(@[\w-]+)|((?:[.#:*]?[\w-]+|\*)(?:[.#:*][\w-]+|\*)*(?:[\s,>+~]+(?:[.#:*]?[\w-]+|\*)(?:[.#:*][\w-]+|\*)*)*)(?=\s*\{)|([a-zA-Z-]+(?=\s*:))|([a-zA-Z-]+(?=\())|(-?\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr)?)/g;

function cssClassify(m: RegExpExecArray): Tok[] {
  if (m[1]) return [{ t: m[0], c: 'com' }];
  if (m[2]) return [{ t: m[0], c: 'str' }];
  if (m[3]) return [{ t: m[0], c: 'num' }]; // 十六进制色值
  if (m[4]) return [{ t: m[0], c: 'kw' }]; // @media 等规则
  if (m[5]) {
    /* 整条选择器链（thead th / h1, h2 / .card .title）逐词标红，避免链中前面的词无色 */
    return scan(m[5], /[.#:*]?[\w-]+|\*/g, (sm) => [{ t: sm[0], c: 'kw' }]);
  }
  if (m[6]) return [{ t: m[0], c: 'attr' }]; // 属性名
  if (m[7]) return [{ t: m[0], c: 'fn' }]; // rgba / var / calc 等函数
  return [{ t: m[0], c: 'num' }];
}

/** 标签内子分词：标签名提亮、属性弱化、属性值字符串提亮 */
function tokenizeTag(tag: string): Tok[] {
  return scan(
    tag,
    /(<\/?)([a-zA-Z][\w:-]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([\w-]+)(?==)|(\/?>)/g,
    (m) => {
      if (m[2] !== undefined) return [{ t: m[1], c: '' }, { t: m[2], c: 'kw' }];
      if (m[3] !== undefined) return [{ t: m[3], c: 'str' }];
      if (m[4] !== undefined) return [{ t: m[4], c: 'attr' }];
      if (m[5] !== undefined) return [{ t: m[5], c: '' }];
      return [{ t: m[0], c: '' }]; // <!DOCTYPE …> 等非标准标签按正文
    }
  );
}

/** HTML / XML / SVG：注释、标签、属性、字符串；style/script 内嵌套 CSS/JS 高亮 */
function tokenizeMarkup(code: string): Tok[] {
  const toks: Tok[] = [];
  const lower = code.toLowerCase();
  const n = code.length;
  let i = 0;
  while (i < n) {
    if (code.startsWith('<!--', i)) {
      const end = lower.indexOf('-->', i + 4);
      const stop = end === -1 ? n : end + 3;
      toks.push({ t: code.slice(i, stop), c: 'com' });
      i = stop;
      continue;
    }
    /* 标签入口：接受开标签（<字母）、闭合标签（</）、DOCTYPE（<!）——
       否则闭合标签会落入纯文本分支导致 </div> 等无色 */
    if (code[i] === '<' && /[a-zA-Z!/]/.test(code[i + 1] ?? '')) {
      const gt = code.indexOf('>', i);
      const stop = gt === -1 ? n : gt + 1;
      const tagText = code.slice(i, stop);
      toks.push(...tokenizeTag(tagText));
      i = stop;
      // <style> / <script> 的内嵌代码沿用对应高亮器（到闭合标签为止；未闭合到结尾）
      const name = /^<\/?([a-zA-Z][\w:-]*)/.exec(tagText)?.[1]?.toLowerCase() ?? '';
      const selfClosed = /\/\s*>$/.test(tagText);
      if (!tagText.startsWith('</') && !selfClosed && (name === 'style' || name === 'script')) {
        const close = lower.indexOf(`</${name}`, i);
        const innerStop = close === -1 ? n : close;
        if (innerStop > i) {
          const inner = code.slice(i, innerStop);
          toks.push(...(name === 'style' ? scan(inner, CSS_RE, cssClassify) : scan(inner, JS_RE, jsClassify)));
          i = innerStop;
        }
      }
      continue;
    }
    const next = code.indexOf('<', i + 1);
    const stop = next === -1 ? n : next;
    toks.push({ t: code.slice(i, stop), c: '' });
    i = stop;
  }
  return toks;
}

/** 按语言分派高亮器；未识别语言不高亮（纯正文灰） */
function tokenizeCode(code: string, language: string): Tok[] {
  switch (language) {
    case 'html':
    case 'xml':
    case 'svg':
    case 'vue':
      return tokenizeMarkup(code);
    case 'css':
    case 'scss':
    case 'less':
      return scan(code, CSS_RE, cssClassify);
    case 'python':
    case 'py':
      return scan(code, PY_RE, pyClassify);
    case 'js':
    case 'javascript':
    case 'jsx':
    case 'ts':
    case 'typescript':
    case 'tsx':
    case 'json':
    case 'java':
    case 'go':
    case 'rust':
    case 'c':
    case 'cpp':
      return scan(code, JS_RE, jsClassify);
    default:
      // 纯文本类语言保持不高亮；其余未知语言（bash/sql/ruby 等）按类 C 规则高亮，
      // 保证任何代码块至少有着色（注释/字符串/数字/关键字）
      if (/^(text|txt|plain|diff|log|)$/.test(language)) return [{ t: code, c: '' }];
      return scan(code, JS_RE, jsClassify);
  }
}

/* ============================ 代码块组件 ============================ */

/** 语言 → 下载扩展名 */
const EXT_MAP: Record<string, string> = {
  html: 'html', svg: 'svg', xml: 'xml', css: 'css', js: 'js', javascript: 'js',
  jsx: 'jsx', ts: 'ts', typescript: 'ts', tsx: 'tsx', json: 'json',
  python: 'py', py: 'py', bash: 'sh', sh: 'sh', markdown: 'md', md: 'md',
  java: 'java', go: 'go', rust: 'rs', sql: 'sql',
};

function downloadName(language: string): string {
  const ext = EXT_MAP[language.toLowerCase()];
  if (!ext) return 'code.txt';
  if (ext === 'html') return 'index.html';
  if (ext === 'css') return 'style.css';
  if (ext === 'js' || ext === 'jsx') return 'main.js';
  if (ext === 'ts' || ext === 'tsx') return 'main.ts';
  if (ext === 'py') return 'main.py';
  return `code.${ext}`;
}

/** 头部行内操作（图标 + 文字，悬停微亮） */
function HeaderAction({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-ink-muted transition-colors hover:bg-wash hover:text-ink"
    >
      {icon}
      {label}
    </button>
  );
}

export function CodeBlock({
  code,
  language,
  onRun,
}: {
  code: string;
  language: string;
  onRun: (code: string) => void;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  const tokens = useMemo(() => tokenizeCode(code, language), [code, language]);
  /** 可运行预览：HTML / SVG（围栏标注或内容探测） */
  const runnable =
    language === 'html' || language === 'svg' || /^\s*(<!doctype\s+html|<html[\s>])/i.test(code);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    []
  );

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      showToast('复制失败，请手动选择代码复制');
    }
  };

  const onDownload = () => {
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName(language);
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-base">
      {/* 头部：左语言标签 / 右操作（复制、下载、运行），与参考样式一致 */}
      <div className="flex h-10 shrink-0 items-center justify-between px-4">
        <span className="text-xs lowercase text-ink-muted">{language || 'text'}</span>
        <div className="flex items-center gap-0.5">
          <HeaderAction
            icon={<IconCopy className="h-3.5 w-3.5" />}
            label={copied ? '已复制' : '复制'}
            onClick={() => void onCopy()}
          />
          <HeaderAction icon={<IconDownload className="h-3.5 w-3.5" />} label="下载" onClick={onDownload} />
          {runnable && (
            <>
              <span className="mx-1.5 h-4 w-px bg-line" aria-hidden="true" />
              <HeaderAction
                icon={<IconPlay className="h-3.5 w-3.5" />}
                label="运行"
                onClick={() => onRun(code)}
              />
            </>
          )}
        </div>
      </div>

      {/* 代码体：横向滚动，超高内滚（长文件不撑爆对话流）；滚动条默认隐藏、悬停渐显 */}
      <pre className="code-scroll max-h-[420px] overflow-auto px-4 pb-3.5 pt-1 font-mono text-[13px] leading-relaxed text-ink-muted">
        <code>
          {tokens.map((tok, i) => (
            <span key={i} className={TOKEN_CLASS[tok.c]}>
              {tok.t}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

/* ============================ 消息内容渲染 ============================ */

/**
 * markdown 组件单色系覆盖：标题/加粗提亮为 ink，正文 muted，表格与行内代码用描边+浅底，
 * 不引入任何彩色与阴影。段落首尾去 margin，保证与消息气泡间距一致。
 */
const MD_COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="mb-2 mt-5 text-lg font-semibold text-ink first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-5 text-base font-semibold text-ink first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1.5 mt-4 text-[15px] font-semibold text-ink first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-1.5 mt-3 text-sm font-semibold text-ink first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="my-2.5 break-words leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-ink underline underline-offset-2">
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 marker:text-ink-muted">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-ink-muted">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed pl-0.5">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-line pl-3 text-ink-muted">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-line" />,
  code: ({ children }) => (
    <code className="rounded bg-wash px-1 py-0.5 font-mono text-[12.5px] text-ink">{children}</code>
  ),
  pre: ({ children }) => <pre className="overflow-x-auto">{children}</pre>,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-wash">{children}</thead>,
  th: ({ children }) => (
    <th className="border border-line px-2.5 py-1.5 text-left font-medium text-ink">{children}</th>
  ),
  td: ({ children }) => <td className="border border-line px-2.5 py-1.5 align-top text-ink-muted">{children}</td>,
};

/** 文本段 markdown 渲染（gfm 表格 + 单换行硬换行，贴合聊天排版习惯） */
function MarkdownText({ content }: { content: string }) {
  return (
    <div className="min-w-0 break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={MD_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

/** 助手消息渲染：无代码段整段 markdown；含围栏时按 文本(markdown)/代码块 顺序渲染 */
export function MessageContent({
  content,
  onRun,
}: {
  content: string;
  onRun: (code: string) => void;
}) {
  const segments = useMemo(() => parseMessageSegments(content), [content]);
  if (segments.length === 1 && segments[0].type === 'text') {
    return <MarkdownText content={content} />;
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {segments.map((seg, i) =>
        seg.type === 'code' ? (
          <CodeBlock key={i} code={seg.content} language={seg.language} onRun={onRun} />
        ) : seg.content ? (
          <MarkdownText key={i} content={seg.content} />
        ) : null
      )}
    </div>
  );
}
