/**
 * 文档编辑器（知识库页双击文档打开的全屏覆盖层，ima 式）：
 * - 顶栏：返回（脏内容确认）+ 行内可编辑标题（粗体大号）+ 保存状态
 *   （未保存黄点 / 已保存对勾）+ 保存（Ctrl/Cmd+S，PUT 更新后服务端重分块
 *   重向量化）+ 关闭（脏内容确认）。
 * - 工具行：撤销/重做（600ms 合并快照的本地历史）、Markdown 快捷
 *   （加粗 / 斜体 / 删除线 / 标题 / 引用 / 列表 / 代码，直接作用于编辑区
 *   DOM 的所见即所得操作）、「编辑 / 预览」分段控件、AI 优化全文（流式
 *   润色后一次性替换正文）。
 * - 主区：干净纸面（bg-base），正文列 max-w-4xl 居中、行高放宽；编辑态为
 *   所见即所得（contentEditable 直接渲染排版内容，输入经 htmlToMarkdown
 *   序列化回 Markdown 源文本，数据层始终是 Markdown）；预览态将 Markdown
 *   渲染为文章排版（轻量渲染器，覆盖工具栏语法）；AI 生成期间正文区被
 *   半透明毛玻璃遮罩覆盖（续写 / 优化两态，可取消 / Esc 中止）。
 * - 底部 AI 输入条：圆角输入卡 + 右下角圆形发送钮，输入要求后流式续写
 *   至正文末尾（生成期间输入条禁用、正文只读，完成后清空输入）。
 * - 底部状态条：左侧字数统计，右侧最近保存时间提示。
 * 全部黑白灰令牌，亮暗主题自适应。
 */
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { getDocument, streamChat, updateDocument } from '../../api/gateway';
import { useSettingsStore } from '../../store/settingsStore';
import { useUiStore } from '../../store/uiStore';
import { IconArrowLeft, IconArrowUp, IconCheck, IconLoader, IconSparkles, IconX } from '../icons';

interface Snap {
  title: string;
  body: string;
}

/** 快照历史推进间隔：小于该值的连续输入合并为一次撤销步 */
const COALESCE_MS = 600;
/** 历史栈上限 */
const HISTORY_LIMIT = 60;

/**
 * 轻量 Markdown → HTML：覆盖工具栏支持的语法（标题 / 引用 / 列表 / 加粗 /
 * 斜体 / 删除线 / 行内代码 / 代码块）。先整体转义 HTML 再应用标记，输出可安全
 * 注入；样式类以完整字面量写在标签上，供 Tailwind JIT 扫描生成。
 */
function renderMarkdown(src: string): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = (s: string): string =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong class="font-semibold">$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em class="italic">$1</em>')
      .replace(/~~([^~]+)~~/g, '<del class="line-through">$1</del>')
      .replace(/`([^`]+)`/g, '<code class="rounded bg-wash px-1 py-0.5 font-mono text-xs">$1</code>');

  const out: string[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  let inList = false;
  let codeBuf: string[] | null = null;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p class="my-3 text-sm leading-7 text-ink first:mt-0">${para.map(inline).join('<br/>')}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(
        `<blockquote class="my-3 border-l-2 border-line pl-3 text-sm leading-7 text-ink-muted">${quote
          .map(inline)
          .join('<br/>')}</blockquote>`
      );
      quote = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };
  const pre = (raw: string[]): string =>
    `<pre class="my-3 overflow-x-auto rounded-lg bg-wash p-3"><code class="font-mono text-xs leading-6 text-ink">${esc(
      raw.join('\n')
    )}</code></pre>`;

  for (const line of src.replace(/\r\n?/g, '\n').split('\n')) {
    if (codeBuf !== null) {
      if (line.trim().startsWith('```')) {
        out.push(pre(codeBuf));
        codeBuf = null;
      } else {
        codeBuf.push(line);
      }
      continue;
    }
    const t = line.trim();
    if (t.startsWith('```')) {
      flushAll();
      codeBuf = [];
    } else if (!t) {
      flushAll();
    } else if (t.startsWith('### ')) {
      flushAll();
      out.push(`<h3 class="mb-2 mt-5 text-sm font-semibold text-ink">${inline(t.slice(4))}</h3>`);
    } else if (t.startsWith('## ') || t.startsWith('# ')) {
      flushAll();
      const cut = t.startsWith('## ') ? 3 : 2;
      out.push(`<h2 class="mb-2 mt-6 text-base font-semibold text-ink">${inline(t.slice(cut))}</h2>`);
    } else if (t.startsWith('> ')) {
      flushPara();
      flushList();
      quote.push(t.slice(2));
    } else if (t.startsWith('- ') || t.startsWith('* ')) {
      flushPara();
      flushQuote();
      if (!inList) {
        out.push('<ul class="my-3 list-disc pl-5 text-sm leading-7 text-ink">');
        inList = true;
      }
      out.push(`<li class="my-1">${inline(t.slice(2))}</li>`);
    } else {
      flushList();
      flushQuote();
      para.push(line);
    }
  }
  if (codeBuf !== null) out.push(pre(codeBuf));
  flushAll();
  return out.join('');
}

/**
 * 编辑器 DOM → Markdown（htmlToMarkdown）：所见即所得编辑态的序列化出口，
 * 与 renderMarkdown 的产出标签集合对称覆盖——块级：P/DIV（段落，段间空行）、
 * H1/H2/H3（# 标题）、UL/OL/LI（- 与 1. 列表，嵌套缩进两空格）、BLOCKQUOTE
 * （> 引用）、PRE>CODE（``` 围栏代码块）、HR（---）；行内：STRONG/B
 * （**粗体**）、EM/I（*斜体*）、DEL/S/STRIKE（~~删除~~）、CODE（`行内代码`）、
 * A（[文字](链接)）、BR（段内换行）。B/I/STRIKE/DIV 等是 execCommand 可能
 * 产生而渲染器不产出的标签，一并处理保证往返不丢格式；未知行内标签透传
 * 内容，空段落丢弃。文本节点原样输出（DOM 已完成实体解码，&nbsp;/零宽空格
 * 等编辑副产物在 clean 中统一清洗）。
 */
function htmlToMarkdown(root: HTMLElement): string {
  /** 行内文本清洗：去零宽占位、&nbsp; 还原空格、压行尾空白与连续换行 */
  const clean = (s: string): string =>
    s
      .replace(/\u200b/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();

  /** 行内序列化：文本原样，标记标签还原包裹符，BR 为段内换行 */
  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as HTMLElement;
    const inner = Array.from(el.childNodes).map(inline).join('');
    switch (el.tagName) {
      case 'BR':
        return '\n';
      case 'STRONG':
      case 'B':
        return inner ? `**${inner}**` : '';
      case 'EM':
      case 'I':
        return inner ? `*${inner}*` : '';
      case 'DEL':
      case 'S':
      case 'STRIKE':
        return inner ? `~~${inner}~~` : '';
      case 'CODE':
        return inner ? `\`${inner.replace(/\n/g, ' ')}\`` : '';
      case 'A': {
        const href = el.getAttribute('href') ?? '';
        return inner ? `[${inner}](${href})` : '';
      }
      default:
        return inner; // SPAN 等未知行内标签透传内容
    }
  };

  /** 取纯文本（BR 还原为换行，用于代码块内容提取——textContent 会丢掉 BR） */
  const domText = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as HTMLElement;
    if (el.tagName === 'BR') return '\n';
    return Array.from(el.childNodes).map(domText).join('');
  };

  /** 列表：LI 项内嵌套列表递归缩进两空格，其余内容按行内序列化合并为单行 */
  const serializeList = (list: HTMLElement, depth: number, ordered: boolean): string => {
    const lines: string[] = [];
    let idx = 1;
    for (const child of Array.from(list.children)) {
      if (child.tagName !== 'LI') continue;
      const li = child as HTMLElement;
      const parts: string[] = [];
      const nested: string[] = [];
      for (const node of Array.from(li.childNodes)) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          if (el.tagName === 'UL' || el.tagName === 'OL') {
            nested.push(serializeList(el, depth + 1, el.tagName === 'OL'));
            continue;
          }
        }
        parts.push(inline(node));
      }
      const item = clean(parts.join('')).replace(/\n+/g, ' ');
      lines.push(`${'  '.repeat(depth)}${ordered ? `${idx}. ` : '- '}${item}`);
      idx += 1;
      lines.push(...nested);
    }
    return lines.join('\n');
  };

  const blocks: string[] = [];
  /** 追加段落：空段丢弃（段间空行由块间 join('\n\n') 提供） */
  const pushPara = (raw: string) => {
    const text = clean(raw);
    if (text) blocks.push(text);
  };

  /** 块级遍历：连续行内节点聚合为一个段落，块级标签各自转换 */
  const walk = (parent: HTMLElement) => {
    let buf: string[] = [];
    const flush = () => {
      if (buf.length) {
        pushPara(buf.join(''));
        buf = [];
      }
    };
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        buf.push(node.nodeValue ?? '');
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = node as HTMLElement;
      const tag = el.tagName;
      if (tag === 'PRE') {
        flush();
        const code = domText(el).replace(/\n+$/, '');
        blocks.push(`\`\`\`\n${code}\n\`\`\``);
      } else if (tag === 'UL' || tag === 'OL') {
        flush();
        const md = serializeList(el, 0, tag === 'OL');
        if (md) blocks.push(md);
      } else if (tag === 'BLOCKQUOTE') {
        flush();
        const lines = clean(Array.from(el.childNodes).map(inline).join(''))
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l);
        if (lines.length) blocks.push(lines.map((l) => `> ${l}`).join('\n'));
      } else if (tag === 'H1' || tag === 'H2' || tag === 'H3') {
        flush();
        const text = clean(Array.from(el.childNodes).map(inline).join(''));
        if (text) blocks.push(`${tag === 'H1' ? '#' : tag === 'H2' ? '##' : '###'} ${text}`);
      } else if (tag === 'HR') {
        flush();
        blocks.push('---');
      } else if (tag === 'P' || tag === 'DIV') {
        flush();
        pushPara(Array.from(el.childNodes).map(inline).join(''));
      } else {
        buf.push(inline(el)); // 行内标签（含未知标签）聚合进当前段落
      }
    }
    flush();
  };

  walk(root);
  return blocks.join('\n\n');
}

export function DocEditor({
  kbId,
  docId,
  onClose,
}: {
  kbId: string;
  docId: string;
  onClose: () => void;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const showConfirm = useUiStore((s) => s.showConfirm);
  const providers = useSettingsStore((s) => s.providers);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  /** 底部输入条中的 AI 创作要求 */
  const [aiReq, setAiReq] = useState('');
  /** AI 输入条 textarea 引用（随内容自动增高用） */
  const aiTaRef = useRef<HTMLTextAreaElement>(null);
  /** 当前 AI 任务：write = 按要求续写至正文末尾，optimize = 润色优化全文（null = 空闲） */
  const [aiKind, setAiKind] = useState<'write' | 'optimize' | null>(null);
  /** AI 生成中（续写 / 优化共用）：正文只读、遮罩覆盖、输入条禁用 */
  const aiBusy = aiKind !== null;
  /** 本会话最近一次成功保存的时间戳（null = 打开后尚未保存过） */
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [, bumpHist] = useState(0);

  /** 所见即所得编辑区（contentEditable）：React 不管理其子内容，innerHTML 命令式维护 */
  const editorRef = useRef<HTMLDivElement>(null);
  /** 本地正文镜像：区分「用户输入序列化出的 body」与「外部变更的 body」，
      相等时同步 effect 不重设 innerHTML（保护光标不丢） */
  const localBodyRef = useRef('');
  /** 编辑区输入 → 序列化的节流定时器（~200ms 合并，blur / 保存 / AI 入口前强制 flush） */
  const syncTimerRef = useRef<number | null>(null);
  const mainScrollRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef<Snap>({ title: '', body: '' });
  const curRef = useRef<Snap>({ title: '', body: '' });
  const pastRef = useRef<Snap[]>([]);
  const futureRef = useRef<Snap[]>([]);
  const lastCommitRef = useRef(0);
  const aiAbortRef = useRef<AbortController | null>(null);

  /** AI 输入条随内容自动增高：单行起步，上限 160px 后内部滚动；清空后回落 */
  useEffect(() => {
    const el = aiTaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [aiReq]);

  /** 可对话模型清单：仅列出已配置密钥的服务商（available，mock 恒可用），provider::model 复合键 */
  const chatModels = providers
    .filter((p) => p.available)
    .flatMap((p) =>
      p.models
        .filter((m) => m.kind.includes('chat'))
        .map((m) => ({ key: `${p.id}::${m.id}`, label: `${p.name} · ${m.name}` }))
    );

  /** 加载文档原文 */
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    setSavedAt(null);
    getDocument(kbId, docId)
      .then((doc) => {
        if (!alive) return;
        setTitle(doc.name);
        setBody(doc.content);
        loadedRef.current = { title: doc.name, body: doc.content };
        curRef.current = { title: doc.name, body: doc.content };
      })
      .catch((err) => {
        if (alive) setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [kbId, docId]);

  /** 卸载时中止 AI 生成 */
  useEffect(() => () => aiAbortRef.current?.abort(), []);

  /**
   * 编辑区视图与 body 单向同步（外部变更 → 视图）：body 与本地镜像不一致
   * （加载 / 撤销 / 重做 / AI 流式 delta / AI 完成）或编辑区刚挂载（预览切回）
   * 时重设 innerHTML；用户输入路径由 onInput 序列化回 body，此后 body ===
   * 镜像，此处跳过以保护光标。AI 流式期间 contentEditable=false 且正文有
   * 遮罩，全量重渲染不产生光标问题。
   */
  useEffect(() => {
    const el = editorRef.current;
    if (!el || preview) return;
    const fresh = el.dataset.mdSynced !== '1';
    if (!fresh && body === localBodyRef.current) return;
    if (fresh) {
      try {
        document.execCommand('defaultParagraphSeparator', false, 'p'); // 回车产生 <p>
      } catch {
        /* 部分环境不支持该命令，忽略 */
      }
    }
    el.innerHTML = renderMarkdown(body);
    el.dataset.mdSynced = '1';
    localBodyRef.current = body;
  }, [body, loading, preview]);

  /** 卸载清理：未触发的序列化定时器（编辑区 DOM 随组件销毁，无需 flush） */
  useEffect(
    () => () => {
      if (syncTimerRef.current !== null) window.clearTimeout(syncTimerRef.current);
    },
    []
  );

  /** AI 流式写入时，主区滚动跟随到底部 */
  useEffect(() => {
    if (!aiBusy) return;
    const el = mainScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [body, aiBusy]);

  const dirty = title !== loadedRef.current.title || body !== loadedRef.current.body;
  const canUndo = pastRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;

  /** 提交快照：600ms 内的连续输入合并为一步 */
  const commit = (t: string, b: string) => {
    const now = Date.now();
    if (now - lastCommitRef.current > COALESCE_MS) {
      pastRef.current = [...pastRef.current.slice(-(HISTORY_LIMIT - 1)), { ...curRef.current }];
    }
    lastCommitRef.current = now;
    curRef.current = { title: t, body: b };
    futureRef.current = [];
    bumpHist((v) => v + 1);
  };

  const onTitleChange = (t: string) => {
    setTitle(t);
    commit(t, body);
  };
  const onBodyChange = (b: string) => {
    setBody(b);
    commit(title, b);
  };

  /**
   * 编辑区 → body（强制序列化）：DOM 转 Markdown 后走 onBodyChange（setBody
   * + 历史快照）。输入时经 scheduleSync 节流触发；blur、工具栏操作、保存
   * 与 AI 入口前调用保证读到最新正文。返回序列化结果。
   */
  const flushSync = (): string => {
    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    const el = editorRef.current;
    if (!el) return localBodyRef.current; // 预览态等编辑区已卸载时返回最近镜像
    const md = htmlToMarkdown(el);
    if (md !== localBodyRef.current) {
      localBodyRef.current = md;
      onBodyChange(md);
    }
    if (!md.trim() && el.innerHTML !== '') el.innerHTML = ''; // 清空后移除残留空段落，让 :empty 占位生效
    return md;
  };

  /** 输入节流：~200ms 合并一次 DOM → Markdown 序列化，避免每键全量转换 */
  const scheduleSync = () => {
    if (syncTimerRef.current !== null) return;
    syncTimerRef.current = window.setTimeout(() => {
      syncTimerRef.current = null;
      flushSync();
    }, 200);
  };

  const undo = () => {
    const prev = pastRef.current.pop();
    if (!prev) return;
    futureRef.current = [...futureRef.current, { ...curRef.current }];
    curRef.current = { ...prev };
    setTitle(prev.title);
    setBody(prev.body);
    lastCommitRef.current = 0;
    bumpHist((v) => v + 1);
  };

  const redo = () => {
    const next = futureRef.current.pop();
    if (!next) return;
    pastRef.current = [...pastRef.current, { ...curRef.current }];
    curRef.current = { ...next };
    setTitle(next.title);
    setBody(next.body);
    bumpHist((v) => v + 1);
  };

  /** 选区所在的最近块级元素（标题 / 引用 toggle 需感知当前状态） */
  const blockAtSelection = (): HTMLElement | null => {
    const el = editorRef.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0 || !sel.anchorNode || !el.contains(sel.anchorNode)) return null;
    let node: Node | null = sel.anchorNode;
    while (node && node !== el) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = (node as HTMLElement).tagName;
        if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'P' || tag === 'BLOCKQUOTE' || tag === 'LI') {
          return node as HTMLElement;
        }
      }
      node = node.parentNode;
    }
    return null;
  };

  /** 工具行公共出口：确认选区在编辑区内 → execCommand → 立即序列化回 body */
  const execFormat = (cmd: string, value?: string) => {
    const el = editorRef.current;
    if (!el || preview || aiBusy) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !el.contains(sel.anchorNode)) return;
    document.execCommand(cmd, false, value);
    flushSync();
  };

  /** 行内代码：选区文字包 <code>；无选区插入零宽空格占位（序列化时清理） */
  const insertInlineCode = () => {
    const el = editorRef.current;
    if (!el || preview || aiBusy) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !el.contains(sel.anchorNode)) return;
    const selected = sel.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    document.execCommand('insertHTML', false, `<code>${selected || '\u200b'}</code>`);
    flushSync();
  };

  /** 粘贴：拦截富文本，按纯文本逐行插入（行间 insertParagraph 产生新段落） */
  const onEditorPaste = (e: ReactClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    text
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .forEach((line, i) => {
        if (i > 0) document.execCommand('insertParagraph');
        if (line) document.execCommand('insertText', false, line);
      });
  };

  /** 编辑区键盘：Ctrl/Cmd+Z、Ctrl+Shift+Z、Ctrl+Y 交给自实现历史——浏览器
      原生 DOM 撤销会直接改 DOM 而 body 不同步，导致数据与视图脱钩 */
  const onEditorKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
      e.preventDefault();
      redo();
    }
  };

  const save = async () => {
    if (saving || loading) return;
    flushSync(); // 编辑区可能有节流窗口内未落盘的输入，先序列化再判定与保存
    const content = localBodyRef.current;
    if (title === loadedRef.current.title && content === loadedRef.current.body) return;
    if (!title.trim()) {
      showToast('标题不能为空');
      return;
    }
    if (!content.trim()) {
      showToast('内容不能为空');
      return;
    }
    setSaving(true);
    try {
      await updateDocument(kbId, docId, { name: title.trim(), content });
      loadedRef.current = { title: title.trim(), body: content };
      curRef.current = { title: title.trim(), body: content };
      pastRef.current = [];
      futureRef.current = [];
      bumpHist((v) => v + 1);
      setSavedAt(Date.now());
      showToast('已保存，文档已重新分块');
    } catch (err) {
      showToast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  /** Ctrl/Cmd+S 保存；AI 生成期间 Esc 取消（续写保留已写入部分，优化丢弃结果） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
      if (e.key === 'Escape' && aiKind) {
        e.preventDefault();
        aiAbortRef.current?.abort();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // save 闭包依赖最新 state，每次渲染重挂
  });

  const requestClose = async () => {
    if (
      dirty &&
      !(await showConfirm({
        title: '放弃未保存的更改？',
        message: '关闭后将丢失这些更改。',
        confirmLabel: '放弃并关闭',
        danger: true,
      }))
    ) {
      return;
    }
    onClose();
  };

  /**
   * AI 流式请求公共通道（续写 / 优化共用）：登记 AbortController（供取消 /
   * Esc / 卸载中止），逐 delta 回调累计文本；error 事件与网络异常统一弹
   * toast 并计为失败。返回是否完整成功（失败 / 中止返回 false，调用方据此
   * 决定是否落稿）。
   */
  const runAiStream = async (
    system: string,
    user: string,
    temperature: number,
    onDelta: (text: string) => void
  ): Promise<boolean> => {
    const [providerId, modelId] = chatModels[0].key.split('::');
    const ac = new AbortController();
    aiAbortRef.current = ac;
    let failed = false;
    try {
      await streamChat(
        {
          provider: providerId,
          model: modelId,
          temperature,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        {
          onEvent: (event) => {
            if (event.type === 'delta') {
              onDelta(event.text);
            } else if (event.type === 'error') {
              failed = true;
              showToast(`AI 生成出错：${event.message}`);
            }
          },
        },
        ac.signal
      );
    } catch {
      failed = true; // 用户中止或网络异常
    } finally {
      aiAbortRef.current = null;
    }
    return !failed;
  };

  /** 无可用对话模型时的统一提示；返回 false 表示不可发起 */
  const ensureModel = (): boolean => {
    if (chatModels.length === 0) {
      showToast('没有可用的对话模型，请在设置中配置服务商');
      return false;
    }
    return true;
  };

  /** AI 续写（底部输入条）：按输入要求流式写入正文末尾，完成后清空输入 */
  const generate = async () => {
    if (aiBusy) return; // 生成期间再次触发无效
    const req = aiReq.trim();
    if (!req) {
      showToast('先输入创作要求');
      return;
    }
    if (!ensureModel()) return;
    flushSync(); // 编辑区可能有节流窗口内未落盘的输入，先序列化再取续写基准
    const base = localBodyRef.current;
    const sep = base.trim() ? '\n\n' : '';
    let out = '';
    setAiKind('write');
    const ok = await runAiStream(
      '你是文档写作助手。根据用户要求直接输出正文内容，可使用 Markdown 格式，不要输出解释性文字。',
      req + (base.trim() ? `\n\n参考当前正文（开头 1500 字）：\n${base.slice(0, 1500)}` : ''),
      0.6,
      (text) => {
        out += text;
        onBodyChange(base + sep + out);
      }
    );
    if (ok) setAiReq(''); // 完成才清空输入；中止 / 失败保留，便于直接重试
    setAiKind(null);
  };

  /** AI 优化（工具行）：流式润色全文，完成后一次性替换正文并计入撤销历史；取消则丢弃结果 */
  const optimize = async () => {
    if (aiBusy || !body.trim()) return; // 生成期间再次点击无效；正文为空时按钮已禁用
    if (!ensureModel()) return;
    flushSync(); // 编辑区可能有节流窗口内未落盘的输入，先序列化再取优化基准
    const source = localBodyRef.current;
    let buffer = '';
    setAiKind('optimize');
    const ok = await runAiStream(
      '根据用户正文进行润色优化，保持原意与结构，直接输出优化后的全文，不要任何解释。',
      source,
      0.6,
      (text) => {
        buffer += text;
      }
    );
    // 完整成功且拿到内容才替换正文，避免出错 / 中止时用半截结果覆盖原文
    if (ok && buffer.trim()) {
      setBody(buffer);
      commit(title, buffer);
    }
    setAiKind(null);
  };

  const toolBtn =
    'flex h-7 min-w-7 items-center justify-center rounded-lg px-1.5 text-xs font-semibold text-ink-muted transition-colors hover:bg-wash hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent';

  return (
    <div className="absolute inset-0 z-[70] flex flex-col bg-base">
      {/* 顶栏：返回 + 行内标题 + 保存状态 + 保存 / 关闭 */}
      <div className="flex h-14 shrink-0 items-center gap-2 bg-base px-3">
        <button
          type="button"
          title="返回"
          aria-label="返回并关闭编辑器"
          onClick={() => void requestClose()}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-wash hover:text-ink"
        >
          <IconArrowLeft className="h-4 w-4" />
        </button>
        <input
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder="请输入标题"
          className="min-w-0 flex-1 bg-transparent text-lg font-semibold text-ink outline-none placeholder:text-ink-faint"
        />
        {!loading && (
          <span
            className="flex shrink-0 items-center gap-1.5 text-xs text-ink-muted"
            title={dirty ? '有未保存更改' : '更改均已保存'}
          >
            {dirty ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                未保存
              </>
            ) : (
              <>
                <IconCheck className="h-3.5 w-3.5" />
                已保存
              </>
            )}
          </span>
        )}
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || saving || loading || aiBusy}
          className="ml-1 flex h-8 shrink-0 items-center rounded-full bg-mono px-3.5 text-xs font-medium text-mono-fg transition-opacity hover:opacity-90 disabled:opacity-30"
        >
          {saving ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          title="关闭"
          aria-label="关闭编辑器"
          onClick={() => void requestClose()}
          className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-wash hover:text-ink"
        >
          <IconX className="h-4 w-4" />
        </button>
      </div>

      {/* 工具行：撤销/重做 + Markdown 快捷 + 编辑/预览 + AI 优化 */}
      <div className="flex h-10 shrink-0 items-center gap-1 bg-base px-3">
        <button type="button" title="撤销" className={toolBtn} disabled={!canUndo || aiBusy} onClick={undo}>
          ↶
        </button>
        <button type="button" title="重做" className={toolBtn} disabled={!canRedo || aiBusy} onClick={redo}>
          ↷
        </button>
        <span className="mx-1 h-4 w-px bg-line" />
        <button
          type="button"
          title="加粗"
          className={`${toolBtn} font-bold`}
          disabled={preview || aiBusy}
          onMouseDown={(e) => e.preventDefault()} // 保持编辑区选区
          onClick={() => execFormat('bold')}
        >
          B
        </button>
        <button
          type="button"
          title="斜体"
          className={`${toolBtn} italic`}
          disabled={preview || aiBusy}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => execFormat('italic')}
        >
          I
        </button>
        <button
          type="button"
          title="删除线"
          className={`${toolBtn} line-through`}
          disabled={preview || aiBusy}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => execFormat('strikeThrough')}
        >
          S
        </button>
        <button
          type="button"
          title="标题"
          className={toolBtn}
          disabled={preview || aiBusy}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => execFormat('formatBlock', blockAtSelection()?.tagName === 'H2' ? 'P' : 'H2')}
        >
          H
        </button>
        <button
          type="button"
          title="引用"
          className={toolBtn}
          disabled={preview || aiBusy}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => execFormat('formatBlock', blockAtSelection()?.tagName === 'BLOCKQUOTE' ? 'P' : 'BLOCKQUOTE')}
        >
          ❝
        </button>
        <button
          type="button"
          title="列表"
          className={toolBtn}
          disabled={preview || aiBusy}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => execFormat('insertUnorderedList')}
        >
          •
        </button>
        <button
          type="button"
          title="代码"
          className={toolBtn}
          disabled={preview || aiBusy}
          onMouseDown={(e) => e.preventDefault()}
          onClick={insertInlineCode}
        >
          {'</>'}
        </button>
        <span className="mx-1 h-4 w-px bg-line" />
        <div className="ml-1 flex h-8 items-center rounded-xl bg-wash-strong p-1" role="group" aria-label="编辑或预览">
          <button
            type="button"
            title="编辑源文本"
            aria-pressed={!preview}
            onClick={() => setPreview(false)}
            className={`h-6 rounded-lg px-3 text-xs font-medium transition-colors ${
              !preview ? 'bg-base text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
            }`}
          >
            编辑
          </button>
          <button
            type="button"
            title="预览文章排版"
            aria-pressed={preview}
            onClick={() => setPreview(true)}
            className={`h-6 rounded-lg px-3 text-xs font-medium transition-colors ${
              preview ? 'bg-base text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
            }`}
          >
            预览
          </button>
        </div>
        <span className="mx-1 h-4 w-px bg-line" />
        <button
          type="button"
          title="AI 优化全文"
          className={toolBtn}
          disabled={!body.trim()}
          onClick={() => void optimize()}
        >
          <IconSparkles className="h-3.5 w-3.5" />
        </button>
        <span className="flex-1" />
      </div>

      {/* 主区：编辑画布（AI 生成期间覆盖毛玻璃遮罩）+ 底部 AI 输入条 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <div ref={mainScrollRef} className="h-full overflow-y-auto">
            {loading ? (
              <p className="mx-auto max-w-4xl px-6 pt-12 text-sm text-ink-muted">加载中…</p>
            ) : loadError ? (
              <div className="mx-auto max-w-3xl px-6 pt-12">
                <p className="text-sm text-ink">{loadError}</p>
                <button
                  type="button"
                  onClick={onClose}
                  className="mt-3 rounded-full border border-line px-3 py-1.5 text-xs text-ink-muted transition-colors hover:bg-wash hover:text-ink"
                >
                  返回
                </button>
              </div>
            ) : preview ? (
              <div className="mx-auto w-full max-w-4xl px-6 py-10">
                <h1 className={`text-2xl font-semibold ${title.trim() ? 'text-ink' : 'text-ink-faint'}`}>
                  {title.trim() || '无标题'}
                </h1>
                <div
                  className="mt-5"
                  dangerouslySetInnerHTML={{
                    __html: body.trim()
                      ? renderMarkdown(body)
                      : '<p class="text-sm text-ink-faint">暂无内容，切回编辑或让 AI 续写。</p>',
                  }}
                />
              </div>
            ) : (
              <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col">
                {/* 所见即所得编辑区：React 不管理子内容，innerHTML 由同步 effect
                    （外部变更）与 flushSync（用户输入序列化）命令式维护；排版
                    样式由 renderMarkdown 输出标签自带，与预览态一致 */}
                <div
                  ref={editorRef}
                  contentEditable={!aiBusy}
                  suppressContentEditableWarning
                  role="textbox"
                  aria-multiline="true"
                  aria-label="文档正文"
                  data-placeholder="请输入正文…（支持 Markdown，Ctrl+S 保存）"
                  className="doc-editor-body min-h-[55vh] w-full flex-1 text-sm leading-7 text-ink outline-none"
                  onInput={() => scheduleSync()}
                  onBlur={() => {
                    flushSync();
                  }}
                  onPaste={onEditorPaste}
                  onKeyDown={onEditorKeyDown}
                />
              </div>
            )}
          </div>

          {/* AI 生成遮罩：半透明毛玻璃盖住正文区，续写 / 优化共用，可随时取消 */}
          {aiBusy && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-base/80 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-2">
                <IconLoader className="h-5 w-5 animate-spin text-ink-muted" />
                <p className="text-sm font-medium text-ink">
                  {aiKind === 'optimize' ? '正在使用 AI 优化…' : 'AI 正在续写…'}
                </p>
                {aiKind === 'optimize' && <p className="text-xs text-ink-muted">优化完成后自动替换正文</p>}
                <button
                  type="button"
                  onClick={() => aiAbortRef.current?.abort()}
                  className="mt-1 rounded-full border border-line px-3 py-1.5 text-xs text-ink-muted transition-colors hover:bg-wash hover:text-ink"
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 底部 AI 输入条：药丸形态（单行居中发送钮），长文本自动增高（上限 160px 后内部滚动）；
            生成期间禁用（Esc 取消）；预览模式不显示 */}
        {!preview && (
        <div className="shrink-0 px-6 pb-4">
          <div className="mx-auto flex w-full max-w-4xl items-end gap-2 rounded-[24px] border border-line bg-panel py-1.5 pl-4 pr-1.5">
            <textarea
              ref={aiTaRef}
              value={aiReq}
              rows={1}
              disabled={aiBusy}
              onChange={(e) => setAiReq(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void generate();
                }
              }}
              placeholder="告诉 AI 你的创作要求，AI 将续写至正文末尾…"
              className="max-h-[160px] min-w-0 flex-1 resize-none overflow-y-auto self-center bg-transparent py-1.5 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-muted disabled:opacity-50"
            />
            <button
              type="button"
              title="发送（Enter）"
              aria-label="发送"
              onClick={() => void generate()}
              disabled={aiBusy || !aiReq.trim()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-mono text-mono-fg transition-opacity hover:opacity-90 disabled:opacity-30"
            >
              <IconArrowUp className="h-4 w-4" />
            </button>
          </div>
        </div>
        )}
      </div>

      {/* 底部状态条：字数统计 + 最近保存时间 */}
      <div className="flex h-8 shrink-0 items-center justify-between bg-base px-6 text-[11px] text-ink-muted">
        <span className="tabular-nums">{body.length} 字</span>
        <span>
          {dirty
            ? '有未保存更改 · Ctrl+S 保存'
            : savedAt
              ? `保存于 ${new Date(savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
              : '尚未保存过'}
        </span>
      </div>
    </div>
  );
}
