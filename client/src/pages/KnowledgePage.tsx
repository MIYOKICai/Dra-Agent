/**
 * 知识库页面（/knowledge）：ima 式双栏布局——
 * 左栏：当前知识库信息（图标 + 名称下拉 + 删除知识库 + 「个人知识库」副标）、
 * 内容工具行（搜索 / 排序 / 新建文档 / 新建知识库）、文档列表（悬浮删除、
 * 上传 .txt/.md/.docx/.pdf、重建向量）；
 * 右栏：基于知识库问答——空态居中提示，底部输入卡（检索模式徽标 + 模型
 * 下拉 + 发送圆钮），回答经 searchKB 检索增强后由 streamChat 流式输出，
 * 并在消息下方以引用片形式标注来源与相似度。
 * 复用 ProjectSidebar 推入式侧边栏与画布同款令牌（黑白灰、亮暗主题自适应）。
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type { KBCitation, KBInfoEx } from '@shared/types';
import {
  addDocumentFile,
  createDocument,
  createKB,
  deleteDocument,
  deleteKB,
  fetchKBQA,
  rebuildKB,
  saveKBQA,
  searchKB,
  streamChat,
} from '../api/gateway';
import { useKBStore } from '../store/kbStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { safeLocalStorage } from '../store/safeStorage';
import { ProjectSidebar } from '../components/canvas/ProjectSidebar';
import { DocEditor } from '../components/kb/DocEditor';
import { Toast } from '../components/Toast';
import { Select } from '../components/fields/SelectField';
import {
  IconArrowUp,
  IconBook,
  IconCheck,
  IconFileText,
  IconFlag,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSparkles,
  IconTrash,
  IconUpload,
  IconX,
} from '../components/icons';

/** 单个上传文件上限（原始文件；与服务端 express.raw limit 一致，提取文本 ≤2MB 由服务端校验） */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** 检索召回片段数 */
const TOP_K = 5;

/** 问答记录写盘节流间隔（毫秒） */
const QA_SAVE_INTERVAL_MS = 1000;

interface QAMessage {
  role: 'user' | 'assistant';
  content: string;
  /** assistant 消息附带的引用（来源 + 相似度） */
  sources?: KBCitation[];
}

/** 工具行圆形图标按钮 */
function ToolButton({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
        active ? 'bg-wash-strong text-ink' : 'text-ink-muted hover:bg-wash hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

export function KnowledgePage() {
  const kbs = useKBStore((s) => s.kbs);
  const kbLoading = useKBStore((s) => s.loading);
  const refetchKBs = useKBStore((s) => s.refetch);
  const providers = useSettingsStore((s) => s.providers);
  const refetchModels = useSettingsStore((s) => s.refetch);
  const showToast = useUiStore((s) => s.showToast);
  const showReport = useUiStore((s) => s.showReport);
  const showConfirm = useUiStore((s) => s.showConfirm);

  /** 记住上次选中的知识库（刷新 / 重开浏览器后回到同一个库，避免误看其他库的空会话） */
  const [activeKbId, setActiveKbId] = useState<string | null>(() => {
    try {
      return safeLocalStorage.getItem('dra-agent-active-kb');
    } catch {
      return null;
    }
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [sortAsc, setSortAsc] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newKbName, setNewKbName] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<QAMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [modelKey, setModelKey] = useState('');
  /** 正在编辑的文档 id（双击文档行进入全屏编辑器） */
  const [editingDocId, setEditingDocId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 问答流式请求的中止控制器（切库时中止，避免串写其他库会话） */
  const streamAbortRef = useRef<AbortController | null>(null);
  /** 当前 messages 已归属的知识库 id（防止切库瞬间把旧会话写进新库的存储） */
  const loadedForRef = useRef<string | null>(null);
  /** 上次问答写盘时间（节流用） */
  const lastSaveRef = useRef(0);

  const activeKb: KBInfoEx | null = useMemo(
    () => kbs.find((k) => k.id === activeKbId) ?? kbs[0] ?? null,
    [kbs, activeKbId]
  );
  const currentKbId = activeKb?.id;

  /** 可对话模型清单（provider::model 复合键）：仅列出已配置密钥的服务商（mock 恒可用），默认取第一个 */
  const chatModels = useMemo(
    () =>
      providers
        .filter((p) => p.available)
        .flatMap((p) =>
          p.models
            .filter((m) => m.kind.includes('chat'))
            .map((m) => ({ value: `${p.id}::${m.id}`, label: `${p.name} · ${m.name}` }))
        ),
    [providers]
  );

  useEffect(() => {
    void refetchKBs();
    void refetchModels();
  }, [refetchKBs, refetchModels]);

  /** 当前选中库 id 变化时持久化（无效 id 由 activeKb 回退逻辑兜底） */
  useEffect(() => {
    const id = currentKbId;
    if (!id) return;
    try {
      safeLocalStorage.setItem('dra-agent-active-kb', id);
    } catch {
      // 隐私模式：忽略
    }
  }, [currentKbId]);

  /** 切换知识库 / 首次载入：中止进行中的流式回答，并从服务端拉取该库的问答记录（持久化，刷新不丢） */
  useEffect(() => {
    const id = currentKbId;
    if (!id) return;
    let cancelled = false;
    streamAbortRef.current?.abort();
    void fetchKBQA(id)
      .then((remote) => {
        if (cancelled) return;
        loadedForRef.current = id;
        // 空内容的 assistant 是流式占位，不恢复为空气泡
        setMessages(
          remote
            .filter((m) => m.role === 'user' || m.content.trim())
            .map((m) => ({ role: m.role, content: m.content, sources: m.sources ?? [] }))
        );
      })
      .catch(() => {
        if (cancelled) return;
        loadedForRef.current = id;
        setMessages([]); // 服务端读取失败按空会话处理，后续保存会重试覆盖
      });
    return () => {
      cancelled = true;
    };
  }, [currentKbId]);

  /**
   * 问答记录持久化（PUT /api/kb/:id/qa）：1s 节流 + 尾随写入。
   * 首条消息立即落盘（提问后马上刷新也不丢）；流式期间每秒至多写一次，
   * 最后一段增量在 1s 后尾随保存（完成 / 停顿均落盘）；
   * loadedForRef 归属检查防止切库瞬间把旧会话写进新库。
   */
  useEffect(() => {
    const id = currentKbId;
    if (!id || loadedForRef.current !== id) return;
    const write = () => {
      lastSaveRef.current = Date.now();
      void saveKBQA(id, messages).catch(() => undefined); // 保存失败静默，下次变更重试
    };
    const elapsed = Date.now() - lastSaveRef.current;
    if (elapsed >= QA_SAVE_INTERVAL_MS) {
      write();
      return;
    }
    const timer = setTimeout(write, QA_SAVE_INTERVAL_MS - elapsed);
    return () => clearTimeout(timer);
  }, [messages, currentKbId]);

  /** 问答区滚动跟随 */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const docs = useMemo(() => {
    if (!activeKb) return [];
    const kw = query.trim().toLowerCase();
    const list = kw
      ? activeKb.documents.filter((d) => d.name.toLowerCase().includes(kw))
      : activeKb.documents;
    return [...list].sort((a, b) =>
      sortAsc ? a.name.localeCompare(b.name, 'zh-Hans-CN') : b.name.localeCompare(a.name, 'zh-Hans-CN')
    );
  }, [activeKb, query, sortAsc]);

  /** 统一操作包装：busy 互斥 → 执行 → refetch → toast */
  const guard = async (action: () => Promise<string>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      showToast(await action());
      await refetchKBs();
    } catch (err) {
      showToast(`操作失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const onCreateKB = () => {
    const name = newKbName.trim();
    if (!name) return;
    void guard(async () => {
      const kb = await createKB({ name, chunkSize: 500, chunkOverlap: 50 });
      setActiveKbId(kb.id);
      setCreating(false);
      setNewKbName('');
      return `已创建知识库「${kb.name}」`;
    });
  };

  const onDeleteDoc = async (docId: string, docName: string) => {
    if (!activeKb) return;
    if (
      !(await showConfirm({
        title: '删除文档',
        message: `确定删除「${docName}」？`,
        confirmLabel: '删除',
        danger: true,
      }))
    ) {
      return;
    }
    void guard(async () => {
      await deleteDocument(activeKb.id, docId);
      return `已删除文档「${docName}」`;
    });
  };

  /** 删除当前知识库（连同全部文档）：确认后整库删除；当前库被删时重置选中态并清掉持久化 id */
  const onDeleteKB = () => {
    const kb = activeKb;
    if (!kb) return;
    void (async () => {
      if (
        !(await showConfirm({
          title: '删除知识库',
          message: `「${kb.name}」将被删除，库内 ${kb.documents.length} 个文档将一并删除，无法恢复。`,
          confirmLabel: '删除',
          danger: true,
        }))
      ) {
        return;
      }
      const wasLast = kbs.length <= 1;
      void guard(async () => {
        await deleteKB(kb.id);
        // 删的是当前展示库：重置选中态并清掉持久化 id（activeKb 自动回退到剩余首个库）
        setActiveKbId(null);
        setEditingDocId(null);
        try {
          safeLocalStorage.removeItem('dra-agent-active-kb');
        } catch {
          // 隐私模式：忽略
        }
        if (wasLast) {
          // 删掉最后一个库：清空问答会话，避免残留上一库的消息
          loadedForRef.current = null;
          setMessages([]);
        }
        return `已删除知识库「${kb.name}」`;
      });
    })();
  };

  /** 新建空白文档：自动命名「未命名文档」/「未命名文档 2」…，创建成功后直接进入编辑器 */
  const onCreateDoc = () => {
    const kb = activeKb;
    if (!kb) {
      showToast('请先创建或选择一个知识库');
      return;
    }
    void guard(async () => {
      const names = new Set(kb.documents.map((d) => d.name));
      let name = '未命名文档';
      for (let i = 2; names.has(name); i += 1) {
        name = `未命名文档 ${i}`;
      }
      const doc = await createDocument(kb.id, name);
      setEditingDocId(doc.id);
      return `已新建文档「${doc.name}」`;
    });
  };

  const onRebuild = () => {
    if (!activeKb) return;
    void guard(async () => {
      const updated = await rebuildKB(activeKb.id);
      return `已重建「${updated.name}」向量：${updated.mode === 'vector' ? '向量' : '关键词'}模式，${updated.chunkCount} 块`;
    });
  };

  const onFilesChange = (event: ChangeEvent<HTMLInputElement>) => {
    const kbId = activeKb?.id;
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!kbId || files.length === 0) return;
    void guard(async () => {
      let ok = 0;
      for (const file of files) {
        if (file.size > MAX_FILE_BYTES) {
          showToast(`「${file.name}」超过 20MB，已跳过`);
          continue;
        }
        try {
          // 统一走文件上传端点：服务端按扩展名提取文本（txt/md 直读，docx/pdf 解析）后入库
          await addDocumentFile(kbId, file);
          ok += 1;
        } catch (err) {
          showToast(`「${file.name}」上传失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return ok > 0 ? `已上传 ${ok} 个文档` : '没有文档被上传';
    });
  };

  /** 问答：检索增强 → 流式回答；引用片段随回答落库展示 */
  const onSend = async () => {
    const question = draft.trim();
    if (!question || streaming) return;
    if (!activeKb) {
      showToast('请先创建或选择一个知识库');
      return;
    }
    if (chatModels.length === 0) {
      showToast('没有可用的对话模型，请在设置中配置服务商');
      return;
    }
    const [providerId, modelId] = (modelKey || chatModels[0].value).split('::');
    setDraft('');
    setStreaming(true);
    const ac = new AbortController();
    streamAbortRef.current = ac;
    setMessages((prev) => [...prev, { role: 'user', content: question }, { role: 'assistant', content: '', sources: [] }]);

    let fragments: { text: string; source: string; score: number }[] = [];
    try {
      const result = await searchKB(activeKb.id, question, TOP_K);
      fragments = result.fragments;
    } catch (err) {
      showToast(`知识库检索失败：${err instanceof Error ? err.message : String(err)}`);
    }

    const context = fragments
      .map((f, i) => `[片段 ${i + 1}｜来源：${f.source}｜相似度 ${(f.score * 100).toFixed(0)}%]\n${f.text}`)
      .join('\n\n');
    const system =
      '你是知识库问答助手。仅依据给定的知识库片段回答用户问题；' +
      '片段不足以回答时明确说明。回答使用简体中文，简洁分点。' +
      (context ? `\n\n知识库片段：\n${context}` : '\n\n（本次检索未命中任何片段，请据实说明。）');

    const history = messages.slice(-6).map((m) => ({ role: m.role, content: m.content }));
    const append = (text: string) => {
      if (ac.signal.aborted) return; // 已切库中止：丢弃残余 delta，避免串写其他库会话
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + text };
        return next;
      });
    };

    try {
      await streamChat(
        {
          provider: providerId,
          model: modelId,
          temperature: 0.4,
          messages: [
            { role: 'system', content: system },
            ...history,
            { role: 'user', content: question },
          ],
        },
        {
          onEvent: (event) => {
            if (event.type === 'delta') append(event.text);
            else if (event.type === 'error') append(`\n\n[错误] ${event.message}`);
          },
        },
        ac.signal
      );
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === 'assistant' && fragments.length > 0) {
          next[next.length - 1] = {
            ...last,
            sources: fragments.slice(0, 4).map((f) => ({ source: f.source, score: f.score })),
          };
        }
        return next;
      });
    } finally {
      setStreaming(false);
      if (streamAbortRef.current === ac) streamAbortRef.current = null;
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-base text-ink">
      <ProjectSidebar />

      <div className="relative flex min-w-0 flex-1">
        {/* ============ 左栏：知识库信息与内容 ============ */}
        <section className="flex w-[340px] shrink-0 flex-col border-r border-line">
          {/* 库信息头 */}
          <div className="flex items-center gap-3.5 px-5 pb-5 pt-6">
            <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-line bg-wash-strong">
              <IconBook className="h-6 w-6 text-ink" />
            </span>
            <div className="min-w-0 flex-1">
              {activeKb ? (
                <div className="flex min-w-0 flex-col">
                  <Select
                    ariaLabel="切换知识库"
                    value={activeKb.id}
                    options={kbs.map((kb) => ({ value: kb.id, label: kb.name }))}
                    onChange={setActiveKbId}
                    triggerClassName="min-w-0 w-full text-lg font-semibold text-ink"
                  />
                  {/* 第二行：整行删除按钮（与 Select 触发器同高 28px / h-7） */}
                  <button
                    type="button"
                    title="删除知识库"
                    aria-label="删除知识库"
                    disabled={busy}
                    onClick={onDeleteKB}
                    className="mt-2 flex h-7 w-full items-center justify-center gap-2 rounded-xl border border-line text-sm text-ink-muted transition-colors hover:bg-wash hover:text-ink disabled:opacity-40"
                  >
                    <IconTrash className="h-4 w-4" />
                    删除知识库
                  </button>
                </div>
              ) : (
                <p className="truncate text-lg font-semibold text-ink">知识库</p>
              )}
              <p className="mt-0.5 text-xs text-ink-muted">个人知识库</p>
            </div>
          </div>

          {/* 内容工具行 */}
          <div className="flex items-center justify-between px-5 pb-2 pt-4">
            <p className="text-xs text-ink-muted">
              内容({activeKb ? activeKb.documents.length : 0})
            </p>
            <div className="flex items-center gap-0.5">
              <ToolButton label="搜索文档" active={searchOpen} onClick={() => setSearchOpen((v) => !v)}>
                <IconSearch className="h-4 w-4" />
              </ToolButton>
              <ToolButton label={sortAsc ? '切换为倒序' : '切换为正序'} onClick={() => setSortAsc((v) => !v)}>
                <span className="text-xs font-semibold tracking-tight">{sortAsc ? '↑↓' : '↓↑'}</span>
              </ToolButton>
              <ToolButton label="新建文档" onClick={onCreateDoc}>
                <IconFileText className="h-4 w-4" />
              </ToolButton>
              <ToolButton label="新建知识库" active={creating} onClick={() => setCreating((v) => !v)}>
                <IconPlus className="h-4 w-4" />
              </ToolButton>
            </div>
          </div>

          {searchOpen && (
            <div className="px-5 pb-2">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索文档名称…"
                className="w-full rounded-lg border border-line bg-panel px-2.5 py-1.5 text-xs text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-ink-muted"
              />
            </div>
          )}

          {creating && (
            <div className="flex items-center gap-1.5 px-5 pb-2">
              <input
                autoFocus
                value={newKbName}
                maxLength={50}
                onChange={(e) => setNewKbName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onCreateKB();
                  if (e.key === 'Escape') setCreating(false);
                }}
                placeholder="新知识库名称"
                className="min-w-0 flex-1 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-xs text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-ink-muted"
              />
              <ToolButton label="确认创建" onClick={onCreateKB}>
                <IconCheck className="h-4 w-4" />
              </ToolButton>
              <ToolButton label="取消" onClick={() => setCreating(false)}>
                <IconX className="h-4 w-4" />
              </ToolButton>
            </div>
          )}

          {/* 文档列表 */}
          <div className="min-h-0 flex-1 overflow-y-auto px-3">
            {kbLoading && <p className="px-2 py-3 text-xs text-ink-muted">加载中…</p>}
            {!kbLoading && !activeKb && (
              <p className="px-2 py-3 text-xs leading-relaxed text-ink-muted">
                暂无知识库，点击右上角 ＋ 新建一个，再上传文档（.txt/.md/.docx/.pdf）。
              </p>
            )}
            {docs.map((doc) => (
              <div
                key={doc.id}
                onDoubleClick={() => setEditingDocId(doc.id)}
                title={`双击查看并编辑「${doc.name}」`}
                className="group flex cursor-text items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-wash"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-base">
                  <IconFileText className="h-4 w-4 text-ink-muted" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-ink" title={doc.name}>
                    {doc.name}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-ink-muted">
                    <span className="font-semibold text-ink">{doc.chunkCount}</span> 块 ·{' '}
                    {new Date(doc.createdAt).toLocaleTimeString('zh-CN', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
                <button
                  type="button"
                  title="举报该文档"
                  aria-label={`举报文档 ${doc.name}`}
                  disabled={busy}
                  onClick={() => showReport({ targetType: 'kbdoc', targetId: doc.id })}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-muted opacity-0 transition-all hover:bg-wash-strong hover:text-ink group-hover:opacity-100"
                >
                  <IconFlag className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  title="删除该文档"
                  aria-label={`删除文档 ${doc.name}`}
                  disabled={busy}
                  onClick={() => void onDeleteDoc(doc.id, doc.name)}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-muted opacity-0 transition-all hover:bg-wash-strong hover:text-ink group-hover:opacity-100"
                >
                  <IconTrash className="h-4 w-4" />
                </button>
              </div>
            ))}
            {activeKb && docs.length === 0 && !kbLoading && (
              <p className="py-8 text-center text-xs text-ink-faint">
                {query.trim() ? '没有匹配的文档' : '没有更多内容了'}
              </p>
            )}
          </div>

          {/* 库操作 */}
          <div className="flex items-center gap-2 px-5 py-3">
            <button
              type="button"
              disabled={busy || !activeKb}
              onClick={() => fileInputRef.current?.click()}
              className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-line bg-panel text-xs text-ink transition-colors hover:bg-wash disabled:opacity-40"
            >
              <IconUpload className="h-3.5 w-3.5" />
              上传文档
            </button>
            <button
              type="button"
              disabled={busy || !activeKb}
              onClick={onRebuild}
              title="用当前可用的向量化服务商重算全部片段向量"
              className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-line bg-panel text-xs text-ink transition-colors hover:bg-wash disabled:opacity-40"
            >
              <IconRefresh className="h-3.5 w-3.5" />
              重建向量
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.md,.markdown,.docx,.pdf"
            multiple
            className="hidden"
            onChange={onFilesChange}
          />
        </section>

        {/* ============ 右栏：基于知识库问答 ============ */}
        <section className="relative flex min-w-0 flex-1 flex-col">
          {messages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3">
              <span className="flex size-14 items-center justify-center rounded-2xl border border-line bg-wash-strong">
                <IconSparkles className="h-6 w-6 text-ink-muted" />
              </span>
              <p className="text-sm text-ink-muted">基于知识库问答</p>
            </div>
          ) : (
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-6 py-6">
                {messages.map((m, i) =>
                  m.role === 'user' ? (
                    <div key={i} className="flex justify-end">
                      <p className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-wash-strong px-3.5 py-2.5 text-sm leading-relaxed text-ink">
                        {m.content}
                      </p>
                    </div>
                  ) : (
                    <div key={i} className="flex flex-col gap-2">
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
                        {m.content}
                        {streaming && i === messages.length - 1 && (
                          <span className="ml-0.5 animate-pulse text-ink-muted">▍</span>
                        )}
                      </p>
                      {m.sources && m.sources.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {m.sources.map((s, j) => (
                            <span
                              key={j}
                              className="rounded-md bg-wash px-1.5 py-0.5 text-[10px] text-ink-muted"
                              title={s.source}
                            >
                              引用 {j + 1} · {s.source} · {(s.score * 100).toFixed(0)}%
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                )}
              </div>
            </div>
          )}

          {/* 底部输入卡 */}
          <div className="px-6 pb-2">
            <div className="mx-auto w-full max-w-2xl rounded-2xl border border-line bg-panel p-3">
              <textarea
                value={draft}
                rows={2}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void onSend();
                  }
                }}
                placeholder="基于知识库提问"
                className="h-10 w-full resize-none bg-transparent px-1 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-muted"
              />
              <div className="mt-1 flex items-center gap-2">
                {activeKb && (
                  <span
                    title={activeKb.mode === 'vector' ? '向量相似度检索' : '关键词（bigram）重合度检索'}
                    className="rounded-full bg-wash px-2.5 py-1 text-xs text-ink-muted"
                  >
                    {activeKb.mode === 'vector' ? '向量' : '关键词'} 检索
                  </span>
                )}
                {chatModels.length > 0 && (
                  <Select
                    ariaLabel="问答模型"
                    value={modelKey || chatModels[0].value}
                    options={chatModels}
                    onChange={setModelKey}
                    triggerClassName="rounded-full bg-wash py-1 pl-2.5 pr-2 text-xs text-ink-muted"
                  />
                )}
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => void onSend()}
                  disabled={!draft.trim() || streaming}
                  aria-label="发送"
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-mono text-mono-fg transition-opacity hover:opacity-90 disabled:opacity-30"
                >
                  <IconArrowUp className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
          <p className="pb-3 text-center text-[10px] text-ink-faint">内容由 AI 生成，仅供参考</p>
        </section>

        {/* 文档编辑器：覆盖右侧内容区（左侧边栏保持可见） */}
        {editingDocId && activeKb && (
          <DocEditor
            kbId={activeKb.id}
            docId={editingDocId}
            onClose={() => {
              setEditingDocId(null);
              void refetchKBs();
            }}
          />
        )}
      </div>

      <Toast />
    </div>
  );
}
