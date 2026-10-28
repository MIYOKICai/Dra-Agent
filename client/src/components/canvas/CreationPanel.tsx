/**
 * 一键创作面板：独立创作入口，覆盖画布主区与四角控件（z-40），不绑定当前画布。
 * - 「生成」：对话式创作——携带历史流式问答，会话持久化到 localStorage，
 *   左侧边栏「创作对话」分组可回看（经 uiStore.activeCreationSessionId 交接）
 * - 「画布」：把想法编排成工作流，生成后新建一个画布载入（不动当前画布）
 * 面板不渲染关闭按钮，Esc 返回画布（生成中不可关）。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useReactFlow, useUpdateNodeInternals } from '@xyflow/react';
import type { ChatMessage, FileMeta, SSEEvent, SSEToolCall } from '@shared/types';
import { deleteNodeFile, fetchNodeFileText, streamChat, uploadNodeFile } from '../../api/gateway';
import { MessageContent } from '../CodeBlock';
import {
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconDatabase,
  IconEdit,
  IconFileText,
  IconImage,
  IconLoader,
  IconPaperclip,
  IconRefresh,
  IconShare,
  IconSparkles,
  IconStop,
  IconTerminal,
  IconThumbDown,
  IconThumbUp,
  IconVolume2,
  IconWrench,
  IconX,
} from '../icons';
import { getTtsState, subscribeTts, toggleTts } from '../../lib/tts';
import { Select } from '../fields/SelectField';
import { useSettingsStore } from '../../store/settingsStore';
import { useUiStore } from '../../store/uiStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import {
  buildComposerSystem,
  buildConversationSystem,
  parseComposerOutput,
  toWorkflowTemplate,
  type ComposerMode,
} from '../../lib/composeWorkflow';
import { applyTemplateAnimated } from '../../templates/loader';
import {
  backfillMessageMeta,
  deriveSessionTitle,
  newSessionId,
  useCreationSessions,
  type CreationMessage,
  type CreationSession,
  type CreationStep,
} from '../../lib/creationSessions';

/** 生成 / 画布 两个风格段选项 */
const MODE_OPTIONS: { value: ComposerMode; label: string }[] = [
  { value: 'generate', label: '对话' },
  { value: 'canvas', label: '画布' },
];

/**
 * 长对话压缩：客户端上送全量历史，压缩（LLM 摘要）在服务端完成；
 * 已有摘要未覆盖的新消息攒够该阈值时，要求服务端对全量历史整体重摘。
 */
const SUMMARY_REFRESH_STEP = 8;

/** 截断摘要文本（工具过程 chip 单行展示用） */
const clipText = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** 对话附件：单条消息最多 6 个；文档正文截断长度与图片 dataURL 字符上限 */
const MAX_CHAT_ATTACHMENTS = 6;
const MAX_CHAT_DOC_CHARS = 6_000;
const MAX_CHAT_IMAGE_CHARS = 6_000_000;

/** 对话附件（仅元信息；原始 File 暂存 ref，发送图片时才转 dataURL，不落盘） */
interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  kind: FileMeta['kind'];
  status: 'uploading' | 'done' | 'failed';
  error?: string;
}

/** File → dataURL（图片视觉输入用）；失败返回 null */
function fileToDataURL(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** 附件大小展示 */
function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

/** 工具风险徽标（过程行与确认卡共用）：write 黄点 / danger 红点 */
const RISK_DOT: Record<string, string> = { write: 'bg-amber-500', danger: 'bg-rose-500' };
const RISK_LABEL: Record<string, string> = { write: '写入', danger: '高危' };

/** 单条过程 chip：图标 + 标签 · 单行截断摘要（notice 为过程说明行，风险徽标标注写 / 高危） */
function AgentStepRow({ step }: { step: CreationStep }) {
  const isCall = step.kind === 'tool_call';
  const isNotice = step.kind === 'notice';
  const summary = isCall ? `${step.tool ?? ''}(${step.content})` : step.content;
  const risk = isCall ? step.risk : undefined;
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-ink-muted" title={summary}>
      {isNotice ? (
        <IconSparkles className="h-3.5 w-3.5 shrink-0" />
      ) : isCall ? (
        <IconWrench className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <IconTerminal className="h-3.5 w-3.5 shrink-0" />
      )}
      <span className="shrink-0 font-medium">
        {isNotice ? '过程' : isCall ? '工具调用' : '工具结果'}
      </span>
      {risk && RISK_DOT[risk] && (
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${RISK_DOT[risk]}`} />
      )}
      {risk && RISK_LABEL[risk] && <span className="shrink-0">{RISK_LABEL[risk]}</span>}
      <span className="shrink-0">·</span>
      <span className="min-w-0 truncate">{summary}</span>
      {step.kind === 'tool_result' && step.ok === false && (
        <span className="shrink-0 font-medium">失败</span>
      )}
    </div>
  );
}

/** 工具执行确认卡：写 / 高危调用暂停时渲染，勾选授权后继续（全部拒绝则跳过执行） */
function ToolConfirmCard({
  calls,
  onDecide,
}: {
  calls: SSEToolCall[];
  onDecide: (confirms: { callId: string; approved: boolean }[]) => void;
}) {
  const [checked, setChecked] = useState<boolean[]>(() => calls.map(() => true));
  return (
    <div className="rounded-2xl border border-line bg-panel p-4">
      <p className="text-sm font-medium text-ink">
        Agent 请求执行{calls.length > 1 ? `以下 ${calls.length} 项` : '以下'}操作，请确认
      </p>
      <div className="mt-3 flex flex-col gap-2">
        {calls.map((c, i) => {
          const risk = c.risk === 'danger' ? 'danger' : 'write';
          return (
            <label
              key={c.id}
              className="flex min-w-0 cursor-pointer items-center gap-2 text-xs text-ink-muted"
            >
              <input
                type="checkbox"
                checked={checked[i] ?? true}
                onChange={(e) =>
                  setChecked((prev) => prev.map((v, j) => (j === i ? e.target.checked : v)))
                }
                className="h-3.5 w-3.5 shrink-0"
              />
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${RISK_DOT[risk]}`} />
              <span className="shrink-0 font-medium text-ink">{RISK_LABEL[risk]}</span>
              <span className="shrink-0 font-medium">{c.name}</span>
              <span className="min-w-0 truncate">{clipText(c.arguments.trim() || '{}', 80)}</span>
            </label>
          );
        })}
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() =>
            onDecide(calls.map((c, i) => ({ callId: c.id, approved: checked[i] ?? true })))
          }
          className="rounded-full bg-mono px-3.5 py-1.5 text-xs font-medium text-mono-fg transition-opacity hover:opacity-90"
        >
          允许已选并继续
        </button>
        <button
          type="button"
          onClick={() => onDecide(calls.map((c) => ({ callId: c.id, approved: false })))}
          className="rounded-full border border-line px-3.5 py-1.5 text-xs text-ink-muted transition-colors hover:text-ink"
        >
          全部拒绝
        </button>
      </div>
    </div>
  );
}

/** 操作行小图标按钮（active 态提亮为 ink 表示已选中） */
function ActionBtn({
  children,
  onClick,
  label,
  active,
}: {
  children: ReactNode;
  onClick: () => void;
  label: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-wash ${
        active ? 'text-ink' : 'text-ink-muted'
      }`}
    >
      {children}
    </button>
  );
}

/** 助手消息操作行（参考图一样式）：复制 / 点赞 / 点踩 / 分享 / 朗读 + 用量 tok + 时间 */
function AssistantActions({ message, voiceKey }: { message: CreationMessage; voiceKey: string }) {
  const showToast = useUiStore((s) => s.showToast);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);
  /** 全局朗读状态订阅：只有目标键命中的按钮切换为合成中 / 停止态 */
  const tts = useSyncExternalStore(subscribeTts, getTtsState);
  const speaking = tts.id === voiceKey;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      showToast('复制失败：浏览器未授权剪贴板');
    }
  };

  const share = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      showToast('内容已复制，去粘贴分享吧');
    } catch {
      showToast('复制失败：浏览器未授权剪贴板');
    }
  };

  const totalTok = message.usage
    ? message.usage.promptTokens + message.usage.completionTokens
    : 0;
  const usageText =
    totalTok >= 1000
      ? `${(totalTok / 1000).toFixed(totalTok >= 10000 ? 0 : 1)}K token`
      : `${totalTok} token`;
  const timeText = message.time
    ? new Date(message.time).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '';

  return (
    <div className="mt-2 flex items-center gap-0.5 text-xs text-ink-muted">
      <ActionBtn onClick={copy} label={copied ? '已复制' : '复制'}>
        {copied ? <IconCheck className="h-4 w-4" /> : <IconCopy className="h-3.5 w-3.5" />}
      </ActionBtn>
      <ActionBtn
        onClick={() => setFeedback((f) => (f === 'up' ? null : 'up'))}
        label="点赞"
        active={feedback === 'up'}
      >
        <IconThumbUp className="h-3.5 w-3.5" />
      </ActionBtn>
      <ActionBtn
        onClick={() => setFeedback((f) => (f === 'down' ? null : 'down'))}
        label="点踩"
        active={feedback === 'down'}
      >
        <IconThumbDown className="h-3.5 w-3.5" />
      </ActionBtn>
      <ActionBtn onClick={share} label="分享">
        <IconShare className="h-3.5 w-3.5" />
      </ActionBtn>
      {/* 语音朗读：点按合成并播放（晓晓音色），朗读中变停止；同一时间只朗读一条 */}
      <ActionBtn
        onClick={() => void toggleTts(voiceKey, message.content)}
        label={speaking ? (tts.loading ? '正在合成语音' : '停止朗读') : '朗读'}
        active={speaking}
      >
        {speaking && tts.loading ? (
          <IconLoader className="h-3.5 w-3.5 animate-spin" />
        ) : speaking ? (
          <IconStop className="h-3.5 w-3.5" />
        ) : (
          <IconVolume2 className="h-3.5 w-3.5" />
        )}
      </ActionBtn>
      {message.usage && totalTok > 0 && (
        <span
          className="ml-2 flex items-center gap-1"
          title={`输入 ${message.usage.promptTokens} + 输出 ${message.usage.completionTokens} token`}
        >
          <IconDatabase className="h-3.5 w-3.5" />
          用量 {usageText}
        </span>
      )}
      {timeText && <span className="ml-3 tabular-nums">{timeText}</span>}
    </div>
  );
}

/** 会话落盘：新会话用首条用户消息作标题；updatedAt 置顶，并同步为侧边栏当前会话。
 *  memory：本次服务端压缩出的新摘要（缺省保留会话已有摘要） */
function persistSession(
  id: string,
  firstIdea: string,
  messages: CreationMessage[],
  memory?: { summary: string; summaryAt: number }
) {
  const now = Date.now();
  const existing = useCreationSessions.getState().sessions.find((s) => s.id === id);
  const session: CreationSession = {
    id,
    title: existing?.title ?? deriveSessionTitle(firstIdea),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    messages,
    summary: memory?.summary ?? existing?.summary,
    summaryAt: memory?.summaryAt ?? existing?.summaryAt,
  };
  useCreationSessions.getState().upsert(session);
  useUiStore.getState().setActiveCreationSessionId(id);
}

export function CreationPanel() {
  const setCreationOpen = useUiStore((s) => s.setCreationOpen);
  const showToast = useUiStore((s) => s.showToast);
  const setGeneratingSessionId = useUiStore((s) => s.setGeneratingSessionId);
  const providers = useSettingsStore((s) => s.providers);

  /** 面板模式与路由联动：generate ↔ /chat，compose ↔ /canvas（详见 handleModeChange） */
  const mode = useUiStore((s) => s.composerMode);
  const setMode = useUiStore((s) => s.setComposerMode);
  const [draft, setDraft] = useState('');
  const [modelKey, setModelKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  /** 当前对话消息（生成模式）；空数组 = 新对话，居中 hero 布局 */
  const [messages, setMessages] = useState<CreationMessage[]>([]);
  /** 当前会话 id（新对话首次发送时创建并落盘） */
  const [sessionId, setSessionId] = useState<string | null>(null);
  /** 右侧内嵌预览列的代码（点代码块「运行」展开；null = 关闭） */
  const [previewCode, setPreviewCode] = useState<string | null>(null);
  /** 预览前的侧边栏折叠态：关闭预览时恢复，避免覆盖用户手动展开/收起的选择 */
  const prevCollapsedRef = useRef(false);
  /** 代码预览分栏展开期间自动收起左侧边栏（折叠为图标栏），给对话列与预览列让位 */
  useEffect(() => {
    if (!previewCode) return;
    prevCollapsedRef.current = useUiStore.getState().sidebarCollapsed;
    useUiStore.getState().setSidebarCollapsed(true);
    return () => {
      useUiStore.getState().setSidebarCollapsed(prevCollapsedRef.current);
    };
  }, [previewCode]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 发送代次：切换会话时自增，旧请求的收尾据此判定失效，不再触碰面板状态 */
  const sendSeqRef = useRef(0);
  /** 对话附件：输入卡上传的文件（发送后清空；仅生成模式可用） */
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachDragOver, setAttachDragOver] = useState(false);
  const attachInputRef = useRef<HTMLInputElement>(null);
  /** 附件原始 File（会话内暂存，发送图片时转 dataURL；不持久化） */
  const attachFilesRef = useRef(new Map<string, File>());
  /** 最近复制的消息下标（短暂显示对勾反馈） */
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  /** 待确认的工具调用（服务端 confirm_required 暂停时非空；消息流末尾渲染确认卡） */
  const [confirmState, setConfirmState] = useState<{
    calls: SSEToolCall[];
    messages: ChatMessage[];
  } | null>(null);
  /** 确认卡决议回传：确认卡按钮 resolve 后，onChat 内 await 放行续跑 */
  const confirmResolverRef = useRef<((v: { callId: string; approved: boolean }[] | null) => void) | null>(
    null
  );
  /** 对话流是否贴近底部：离开底部时显示「滚动到底」悬浮按钮 */
  const [atBottom, setAtBottom] = useState(true);

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
  const activeModel = modelKey || chatModels[0]?.value || '';

  const navigate = useNavigate();
  /** 生成完成后把视口适配到全部节点（面板关闭后用户直接看到画布动画） */
  const { fitView } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const close = () => {
    if (busy) return;
    setCreationOpen(false);
    // 清掉 URL 中的面板参数（?creation / ?session），保证关闭后刷新直接落在画布
    navigate('/canvas', { replace: true });
  };

  /** 会话交接：侧边栏点击会话（设 id）载入历史；「一键创作」入口（设 null）重置为新对话。
      切换时中止进行中的流式请求（旧请求收尾经 sendSeqRef 判定失效）。 */
  const activeSessionId = useUiStore((s) => s.activeCreationSessionId);
  useEffect(() => {
    sendSeqRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    // 确认卡等待中切走：放行 resolver（null = 取消续跑），避免悬挂
    confirmResolverRef.current?.(null);
    confirmResolverRef.current = null;
    setConfirmState(null);
    setBusy(false);
    setPhase('');
    setPreviewCode(null);
    setGeneratingSessionId(null);
    if (!activeSessionId) {
      setMessages([]);
      setSessionId(null);
      return;
    }
    const session = useCreationSessions.getState().sessions.find((s) => s.id === activeSessionId);
    // 历史消息回填 time/usage（功能上线前的消息没有落盘数据，仅补展示字段，不改持久化）
    setMessages(session ? backfillMessageMeta(session.messages, session.updatedAt) : []);
    setSessionId(session ? session.id : null);
  }, [activeSessionId, setGeneratingSessionId]);

  /** 生成/画布切换：模式写回 uiStore 并联动路由——生成=/chat（对话），画布=/canvas */
  const handleModeChange = (m: ComposerMode) => {
    setMode(m);
    if (m === 'generate') {
      navigate(activeSessionId ? `/chat?session=${activeSessionId}` : '/chat', { replace: true });
    } else {
      // 画布模式无附件入口：清掉残留，避免切换回生成时误发
      setAttachments([]);
      attachFilesRef.current.clear();
      navigate('/canvas', { replace: true });
    }
  };

  /** Esc：预览开着先关预览，否则关闭面板（生成中不可关，避免状态悬挂）；
      无关闭按钮，Esc 是返回画布的唯一方式 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (previewCode) {
        setPreviewCode(null);
        return;
      }
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, previewCode]);

  /** 新消息 / 流式增量时滚动到对话底部 */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  /** 输入框随内容自动增高（上限 160px，超出后内部滚动）；清空草稿后回落 */
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  /** 滚动 tracking：距底超过 120px 视为离开底部，显示悬浮回底按钮 */
  const onScrollChange = () => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
  };

  const scrollToBottom = () => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  };

  const copyMessage = async (index: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(index);
      window.setTimeout(() => setCopiedIdx((cur) => (cur === index ? null : cur)), 1500);
    } catch {
      showToast('复制失败，请重试');
    }
  };

  /** 引用编辑：把该条用户消息放回输入框（不清除会话历史） */
  const editMessage = (text: string) => {
    setDraft(text);
    taRef.current?.focus();
  };

  /** 添加附件：校验大小与数量 → 乐观上屏 → 上传 /api/files（服务端沿用客户端 id 并解析文档文本） */
  const addFiles = async (files: File[]) => {
    const list = files.filter((f) => f.size > 0);
    if (list.length === 0) return;
    const remaining = MAX_CHAT_ATTACHMENTS - attachments.length;
    if (remaining <= 0) {
      showToast(`单条消息最多 ${MAX_CHAT_ATTACHMENTS} 个附件`);
      return;
    }
    if (list.length > remaining) showToast(`单条消息最多 ${MAX_CHAT_ATTACHMENTS} 个附件`);
    for (const file of list.slice(0, remaining)) {
      if (file.size > 20 * 1024 * 1024) {
        showToast(`「${file.name}」超过 20MB 上限`);
        continue;
      }
      const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
      attachFilesRef.current.set(id, file);
      setAttachments((prev) => [
        ...prev,
        {
          id,
          name: file.name,
          size: file.size,
          kind: file.type.startsWith('image/') ? 'image' : 'doc',
          status: 'uploading',
        },
      ]);
      try {
        const meta: FileMeta = await uploadNodeFile(file, id);
        setAttachments((prev) =>
          prev.map((a) =>
            a.id === id
              ? {
                  ...a,
                  kind: meta.kind,
                  status: meta.extract === 'failed' ? 'failed' : 'done',
                  error: meta.extractError,
                }
              : a
          )
        );
      } catch (err) {
        setAttachments((prev) =>
          prev.map((a) =>
            a.id === id
              ? { ...a, status: 'failed', error: err instanceof Error ? err.message : '上传失败' }
              : a
          )
        );
      }
    }
  };

  /** 移除附件：同步清掉暂存 File，已上传的顺带删除服务端文件（静默失败） */
  const removeAttachment = (id: string) => {
    attachFilesRef.current.delete(id);
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target && target.status !== 'uploading') void deleteNodeFile(id);
      return prev.filter((a) => a.id !== id);
    });
  };

  /**
   * 生成模式：对话式创作（服务端 Agent）。
   * 客户端只负责附件拼装与全量历史上送；ReAct 循环、工具执行、风险确认
   * （confirm_required 暂停 → 确认卡 → toolConfirms 续跑）、历史压缩与
   * 知识库检索全部在服务端完成，过程经 SSE 事件流式呈现。
   */
  const onChat = async () => {
    const idea = draft.trim();
    const atts = attachments.filter((a) => a.status === 'done');
    if ((!idea && atts.length === 0) || busy) return;
    if (!activeModel) {
      showToast('没有可用对话模型，请先在右上角「⚙ 模型」中配置');
      return;
    }
    if (attachments.some((a) => a.status === 'uploading')) {
      showToast('附件还在上传中，请稍候');
      return;
    }
    const [provider, model] = activeModel.split('::');
    const seq = ++sendSeqRef.current;

    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setDraft('');

    // 附件并入消息：文档拉取服务端解析正文（截断），图片转 dataURL 走视觉通道；
    // 消息只保留【文件/图片：名称】标记与文档正文（图片 base64 不落盘）
    let userContent = idea;
    const imageDataURLs: string[] = [];
    for (const a of atts) {
      if (a.kind === 'image') {
        const file = attachFilesRef.current.get(a.id);
        const url = file ? await fileToDataURL(file) : null;
        if (url && url.length <= MAX_CHAT_IMAGE_CHARS) {
          imageDataURLs.push(url);
          userContent += `\n【图片：${a.name}】`;
        } else {
          userContent += `\n【图片：${a.name}（过大未发送）】`;
        }
      } else {
        userContent += `\n【文件：${a.name}】`;
        try {
          const text = await fetchNodeFileText(a.id, ac.signal);
          if (text.trim()) userContent += `\n${clipText(text, MAX_CHAT_DOC_CHARS)}`;
        } catch {
          // 提取失败：仅保留文件名标记，不阻塞发送
        }
      }
    }
    userContent = userContent.trim();
    setAttachments([]);
    attachFilesRef.current.clear();

    const base: CreationMessage[] = [
      ...messages,
      { role: 'user', content: userContent, time: Date.now() },
    ];
    const working: CreationMessage[] = [...base, { role: 'assistant', content: '' }];
    setMessages(working);

    let sid = sessionId;
    const isNew = !sid;
    if (!sid) sid = newSessionId();
    setSessionId(sid);

    setPhase('');

    // 新会话先行 upsert（不触碰 activeCreationSessionId，避免交接 effect 中止本次流式）：
    // 侧边栏立即出现该行并显示环形加载动画，完成后由 persistSession 接管并同步选中态
    if (isNew) {
      useCreationSessions.getState().upsert({
        id: sid,
        title: deriveSessionTitle(userContent),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: base,
      });
    }
    setGeneratingSessionId(sid);

    // 会话已有摘要：随请求上送服务端增量续摘；未覆盖的新消息攒够阈值时整体重摘
    const prev = useCreationSessions.getState().sessions.find((s) => s.id === sid);
    const prevSummary = prev?.summary;
    const refreshSummary =
      Boolean(prevSummary) && base.length - (prev?.summaryAt ?? 0) >= SUMMARY_REFRESH_STEP;

    // 全量历史交服务端压缩（system 置顶；工具规范 / 记忆 / 知识库检索由服务端注入）
    const chatHistory: ChatMessage[] = [
      { role: 'system', content: buildConversationSystem() },
      ...base.map((m) => ({ role: m.role, content: m.content })),
    ];

    /** 刷新在途助手消息（正文 + 过程步骤实时可见） */
    const paint = (content: string, steps: CreationStep[]) => {
      working[working.length - 1] = { role: 'assistant', content, steps };
      setMessages([...working]);
    };

    let visible = ''; // 展示用累计正文（跨轮累加，中间轮的解释文字也保留）
    const steps: CreationStep[] = []; // 工具调用 / 过程说明（随消息持久化）
    const usageAcc = { promptTokens: 0, completionTokens: 0 }; // 各轮 token 用量累计
    let error = '';
    let pendingConfirm: { calls: SSEToolCall[]; messages: ChatMessage[] } | null = null;
    let memory: { summary: string; summaryAt: number } | undefined;
    let needSep = false; // 工具 / 过程阶段结束后再出现正文时补空行分隔

    /** 服务端 Agent 的 SSE 事件处理（首发与确认续跑共用同一闭包） */
    const handleEvent = (event: SSEEvent) => {
      if (event.type === 'delta') {
        if (needSep) {
          visible += visible ? '\n\n' : '';
          needSep = false;
        }
        visible += event.text;
        paint(visible, steps);
      } else if (event.type === 'agent_step') {
        if (event.kind === 'thought') {
          visible += (visible ? '\n\n' : '') + event.content;
          paint(visible, steps);
        } else {
          needSep = true;
          steps.push({ kind: 'notice', content: event.content });
          paint(visible, steps);
        }
      } else if (event.type === 'rag_context') {
        needSep = true;
        const sources = [...new Set(event.fragments.map((f) => f.source))].join('、');
        steps.push({
          kind: 'notice',
          content: clipText(`知识库命中 ${event.fragments.length} 段：${sources}`, 80),
        });
        paint(visible, steps);
      } else if (event.type === 'tool_calls') {
        needSep = true;
        for (const c of event.calls) {
          steps.push({
            kind: 'tool_call',
            tool: c.name,
            risk: c.risk,
            content: clipText(c.arguments.trim() || '{}', 80),
          });
        }
        paint(visible, steps);
      } else if (event.type === 'tool_result') {
        needSep = true;
        steps.push({
          kind: 'tool_result',
          tool: event.name,
          ok: event.ok,
          content: clipText(event.content, 120),
        });
        paint(visible, steps);
      } else if (event.type === 'memory_summary') {
        memory = { summary: event.summary, summaryAt: base.length };
      } else if (event.type === 'confirm_required') {
        pendingConfirm = { calls: event.calls, messages: event.messages };
      } else if (event.type === 'error') {
        error = event.message;
      } else if (event.type === 'blocked') {
        error = `内容命中敏感词：${event.reason}`;
      } else if (event.type === 'done') {
        // 上游 usage（stream_options.include_usage）：各轮累计为整条回答的用量
        if (event.usage) {
          usageAcc.promptTokens += event.usage.promptTokens;
          usageAcc.completionTokens += event.usage.completionTokens;
        }
      }
    };

    await streamChat(
      {
        provider,
        model,
        messages: chatHistory,
        temperature: 0.7,
        agent: true,
        ...(prevSummary ? { historySummary: prevSummary } : {}),
        ...(refreshSummary ? { refreshSummary: true } : {}),
        // 视觉输入：每轮都带上，服务端注入最后一条 user 消息的多模态数组
        ...(imageDataURLs.length > 0 ? { images: imageDataURLs } : {}),
      },
      { onEvent: handleEvent },
      ac.signal
    );

    /** 确认卡决议 → 续跑（后续轮次可能再次出现写 / 高危调用，循环处理） */
    for (;;) {
      if (ac.signal.aborted || error) break;
      // pendingConfirm 由 handleEvent 闭包赋值，TS 流分析看不到：读取时显式收窄
      const pending = pendingConfirm as { calls: SSEToolCall[]; messages: ChatMessage[] } | null;
      if (!pending) break;
      // 半截内容先落盘（确认期间刷新 / 切换会话不丢）
      working[working.length - 1] = {
        role: 'assistant',
        content: visible,
        steps,
        time: Date.now(),
        usage: usageAcc.promptTokens + usageAcc.completionTokens > 0 ? usageAcc : undefined,
      };
      persistSession(sid, idea, working, memory);
      setConfirmState(pending);
      const confirms = await new Promise<{ callId: string; approved: boolean }[] | null>(
        (resolve) => {
          confirmResolverRef.current = resolve;
        }
      );
      confirmResolverRef.current = null;
      setConfirmState(null);
      // null = 用户取消（停止 / 切换会话）：不再续跑，半截内容走收尾逻辑
      if (!confirms || ac.signal.aborted || error) break;
      const resumeMessages = pending.messages;
      pendingConfirm = null;
      await streamChat(
        {
          provider,
          model,
          messages: resumeMessages,
          temperature: 0.7,
          agent: true,
          toolConfirms: confirms,
          ...(imageDataURLs.length > 0 ? { images: imageDataURLs } : {}),
        },
        { onEvent: handleEvent },
        ac.signal
      );
    }

    abortRef.current = null;
    setGeneratingSessionId(null);

    // 流式期间切换了会话：半截回答仅落盘到原会话，不再触碰当前面板状态
    if (seq !== sendSeqRef.current) {
      if (visible) {
        working[working.length - 1] = {
          role: 'assistant',
          content: visible,
          steps,
          time: Date.now(),
          usage:
            usageAcc.promptTokens + usageAcc.completionTokens > 0 ? usageAcc : undefined,
        };
        persistSession(sid, idea, working, memory);
      } else if (isNew) {
        useCreationSessions.getState().remove(sid);
      }
      return;
    }

    setBusy(false);

    // 首字前失败 / 中止：移除空气泡，不产生空会话（新会话同步从列表移除）
    if (!visible) {
      setMessages(base);
      if (isNew) useCreationSessions.getState().remove(sid);
      if (error) showToast(`生成失败：${error}`);
      return;
    }
    const finalContent = error ? `${visible}\n\n（生成中断：${error}）` : visible;
    working[working.length - 1] = {
      role: 'assistant',
      content: finalContent,
      steps,
      time: Date.now(),
      usage: usageAcc.promptTokens + usageAcc.completionTokens > 0 ? usageAcc : undefined,
    };
    setMessages([...working]);
    persistSession(sid, idea, working, memory);
    // 会话已落盘：URL 同步 session 参数，刷新后可恢复该会话
    navigate(`/chat?session=${sid}`, { replace: true });
  };

  /**
   * 画布模式（重构）：发送即新建画布并切换过去——面板立即关闭、画布可见，
   * LLM 编排在后台流式进行（画布顶部显示指示条）；完成后校验结果并
   * 从左到右动画装配（节点标题打字机 + 正文逐字写入）。
   * 中途用户切走画布则放弃写入，避免污染其他画布。
   */
  const onCompose = async () => {
    const idea = draft.trim();
    if (!idea || busy) return;
    if (!activeModel) {
      showToast('没有可用对话模型，请先在右上角「⚙ 模型」中配置');
      return;
    }
    const [provider, model] = activeModel.split('::');

    // 已有一键创作在后台进行时不允许重复发起（避免两条流互相切换画布）
    if (useUiStore.getState().composingBusy) {
      showToast('正在编排工作流，请稍候…');
      return;
    }

    // 立即新建画布并切换（当前画布内容先回写清单）→ 关面板露出空画布，
    // 顶部指示条展示分析阶段，随流式返回更新，装配开始时消失；
    // 全程锁（含装配动画）从发送起生效，结束（成功/失败/取消）时解除
    const canvasId = useWorkspaceStore.getState().createCanvas();
    setCreationOpen(false);
    useUiStore.getState().setComposing('正在理解你的想法…');
    useUiStore.getState().setComposingBusy(true, canvasId);
    showToast('已创建新画布，正在编排工作流…');

    const chatMessages: ChatMessage[] = [
      { role: 'system', content: buildComposerSystem('canvas') },
      { role: 'user', content: idea },
    ];
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setPhase('正在理解你的想法…');

    let text = '';
    let error = '';
    let lastDelta = Date.now();
    await streamChat(
      { provider, model, messages: chatMessages, temperature: 0.6 },
      {
        onEvent: (event) => {
          if (event.type === 'delta') {
            text += event.text;
            if (Date.now() - lastDelta > 1200) {
              lastDelta = Date.now();
              setPhase('正在编排节点与连线…');
              useUiStore.getState().setComposing('正在编排节点与连线…');
            }
          } else if (event.type === 'error') {
            error = event.message;
          } else if (event.type === 'blocked') {
            error = `内容命中敏感词：${event.reason}`;
          }
        },
      },
      ac.signal
    );
    abortRef.current = null;
    setBusy(false);
    setPhase('');
    useUiStore.getState().setComposing(null);

    if (error) {
      useUiStore.getState().setComposingBusy(false);
      showToast(`生成失败：${error}`);
      return;
    }
    const parsed = parseComposerOutput(text);
    if (!parsed) {
      useUiStore.getState().setComposingBusy(false);
      showToast('生成结果解析失败，请调整描述后重试');
      return;
    }
    if (parsed.nodes.length < 3) {
      useUiStore.getState().setComposingBusy(false);
      showToast('生成的工作流过短，请补充更多细节后重试');
      return;
    }
    // 流式期间用户已切走画布：放弃装配（新画布保持空白），不触碰当前画布
    if (useWorkspaceStore.getState().activeId !== canvasId) {
      useUiStore.getState().setComposingBusy(false);
      showToast('已取消工作流生成');
      return;
    }

    // 画布清单同步工作流名（applyTemplateAnimated 内 setName 只更新画布态）
    useWorkspaceStore.getState().renameCanvas(canvasId, parsed.name);
    void applyTemplateAnimated(toWorkflowTemplate(parsed), {
      // 节点入场动画结束后重测把手位置，保证连线端点贴合节点
      onNodeSettled: (id) => updateNodeInternals(id),
      // 每步装配后重新取景，随节点生成自动调节缩放，动画始终可见。
      // 双 rAF：等新节点挂载并被 RF 测量后再 fitView——同步调用时 RF 内部还没有
      // 该节点的尺寸信息，算出的视口不变 → 看起来「没有过渡动画」直接跳变
      onProgress: () => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            void fitView({ padding: 0.25, duration: 380 });
          })
        );
      },
      onDone: () => {
        updateNodeInternals(parsed.nodes.map((n) => n.id));
        void fitView({ padding: 0.2, duration: 400 });
        showToast(
          `已生成「${parsed.name}」：${parsed.nodes.length} 节点 / ${parsed.edges.length} 连线`
        );
      },
      // 装配结束（含中途切走画布中止）解除全程锁
    }).finally(() => useUiStore.getState().setComposingBusy(false));
  };

  const onSend = () => {
    if (mode === 'generate') void onChat();
    else void onCompose();
  };

  const stop = () => {
    // 确认卡等待中：视为取消续跑（不执行任何待确认调用）
    if (confirmResolverRef.current) {
      confirmResolverRef.current(null);
      confirmResolverRef.current = null;
      return;
    }
    abortRef.current?.abort();
  };

  /** 当前所选模型的服务商名（占位符「给 DeepSeek 发送消息」用） */
  const providerName = chatModels.find((o) => o.value === activeModel)?.label.split(' · ')[0] ?? '';

  const statusText = busy
    ? phase || '生成中…'
    : mode === 'canvas'
      ? 'Enter 生成，Shift+Enter 换行；将在新画布中生成工作流'
      : messages.length === 0
        ? 'Enter 发送，Shift+Enter 换行；对话将保存在左侧「创作对话」中'
        : '内容由 AI 生成，请仔细甄别';

  const placeholder =
    mode === 'canvas'
      ? '输入你想实现的 Agent 想法，例如：把任意主题变成四格漫画的工作流…'
      : providerName
        ? `给 ${providerName} 发送消息`
        : '描述你想创作的内容，或聊聊你的 Agent 想法…';

  return (
    <div className="absolute inset-0 z-40 flex bg-base">
      {/* 左侧对话列：flex-1 吃掉除预览列外全部宽度（预览列动画收放时自动跟随），
          min-w 保底防挤压；预览列固定 560px 上限（≤45%），宽屏下对话列远宽于比例分栏 */}
      <div
        className={`flex min-w-[520px] flex-1 flex-col ${
          previewCode ? 'border-r border-line' : 'items-center'
        } ${messages.length === 0 && !previewCode ? 'justify-center' : ''}`}
      >
        {/* 标题 + 模式切换：仅在「一键创作」按钮进入的新对话（尚无消息）时显示；
            展示创作对话历史时不渲染，保持纯对话视图 */}
        {messages.length === 0 && (
          <div className="flex shrink-0 flex-col items-center">
            <h1 className="text-[26px] font-semibold tracking-tight text-ink">你好，今天想要创作什么？</h1>

            {/* 生成 / 画布 风格切换 */}
            <div className="mt-5 flex items-center rounded-full border border-line bg-panel p-1">
              {MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleModeChange(opt.value)}
                  disabled={busy}
                  className={`h-8 w-24 rounded-full text-xs font-medium transition-colors ${
                    mode === opt.value ? 'bg-mono text-mono-fg' : 'text-ink-muted hover:text-ink'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 对话流：宽度与底部输入栏同步（max-w-[860px]），流式增量自动滚底；
            离开底部时右下角悬浮「回到底部」按钮 */}
        {messages.length > 0 && (
          <div className="relative min-h-0 w-full flex-1">
            <div
              ref={scrollRef}
              onScroll={onScrollChange}
              className="chat-scroll-fade no-scrollbar flex h-full w-full justify-center overflow-y-auto px-6 pt-10"
            >
              {/* pb 放内容列内部：flex 滚动容器的 padding-bottom 在滚动末端不参与可滚区域，
                  放内层才能保证滚到底时末条消息与输入卡之间留出间距（64px）；裁剪线仍与卡片顶边齐平 */}
              <div className="flex w-full max-w-[860px] flex-col gap-8 pb-16">
                {messages.map((m, i) =>
                  m.role === 'user' ? (
                    <div key={i} className="flex flex-col items-end gap-1.5">
                      <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl bg-wash-strong px-4 py-2.5 text-sm leading-relaxed text-ink">
                        {m.content}
                      </div>
                      <div className="flex items-center gap-0.5">
                        {m.time ? (
                          <span className="mr-1 flex h-3.5 items-center text-[11px] text-ink-faint">
                            {new Date(m.time).toLocaleTimeString('zh-CN', {
                              hour: '2-digit',
                              minute: '2-digit',
                              hour12: false,
                            })}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => void copyMessage(i, m.content)}
                          aria-label="复制消息"
                          className="flex h-6 w-6 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-wash hover:text-ink"
                        >
                          {copiedIdx === i ? (
                            <IconCheck className="h-3.5 w-3.5" />
                          ) : (
                            <IconCopy className="h-3.5 w-3.5" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => editMessage(m.content)}
                          aria-label="编辑消息"
                          className="flex h-6 w-6 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-wash hover:text-ink"
                        >
                          <IconEdit className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div key={i} className="min-w-0 text-sm leading-relaxed text-ink">
                      {/* ReAct 工具过程 chip：内联单行（图标 + 标签 · 摘要），参考对话式 Agent 样式 */}
                      {(m.steps?.length ?? 0) > 0 && (
                        <div className="mb-2 flex flex-col gap-1.5">
                          {m.steps!.map((s, si) => (
                            <AgentStepRow key={si} step={s} />
                          ))}
                        </div>
                      )}
                      {m.content ? (
                        <MessageContent content={m.content} onRun={setPreviewCode} />
                      ) : (m.steps?.length ?? 0) > 0 ? (
                        <span className="animate-pulse text-ink-muted">正在根据工具结果继续思考…</span>
                      ) : (
                        <span className="animate-pulse text-ink-muted">正在思考…</span>
                      )}
                      {/* 每条助手消息都显示操作行：复制 / 点赞 / 点踩 / 分享 / 朗读（+ 用量 / 时间，历史消息缺数据时仅隐藏对应字段） */}
                      {m.content ? <AssistantActions message={m} voiceKey={`m-${i}`} /> : null}
                    </div>
                  )
                )}
                {/* 写 / 高危工具确认卡：服务端 confirm_required 暂停时渲染于消息流末尾 */}
                {confirmState && (
                  <ToolConfirmCard
                    calls={confirmState.calls}
                    onDecide={(confirms) => confirmResolverRef.current?.(confirms)}
                  />
                )}
              </div>
            </div>
            {!atBottom && (
              <button
                type="button"
                onClick={scrollToBottom}
                aria-label="滚动到底部"
                className="absolute bottom-4 right-4 z-20 flex h-8 w-8 items-center justify-center rounded-full border border-line bg-elevated text-ink-muted transition-colors hover:text-ink"
              >
                <IconChevronDown className="h-4 w-4" />
              </button>
            )}
          </div>
        )}

        {/* 输入卡 + 状态行：比内容区更宽（外扩对称），px-6 与消息流同留白——
            预览分栏对话列变窄时内容不贴边 */}
        <div className="mx-auto flex w-full max-w-[968px] shrink-0 flex-col px-6">
          <div
            className={`rounded-3xl border bg-panel p-3 transition-colors ${
              attachDragOver ? 'border-ink' : 'border-line'
            } ${messages.length === 0 ? 'mt-6' : 'mt-4'}`}
            onDragOver={(e) => {
              if (mode !== 'generate' || busy) return;
              e.preventDefault();
              setAttachDragOver(true);
            }}
            onDragLeave={() => setAttachDragOver(false)}
            onDrop={(e) => {
              if (mode !== 'generate' || busy) return;
              e.preventDefault();
              setAttachDragOver(false);
              void addFiles(Array.from(e.dataTransfer.files));
            }}
          >
            {/* 附件 chip 行：kind 图标 + 名称 + 大小 + 状态（上传中环形 / 解析失败降级）+ 移除 */}
            {attachments.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1.5 px-1 pt-1">
                {attachments.map((a) => (
                  <span
                    key={a.id}
                    title={a.error ?? `${a.name}（${formatBytes(a.size)}）`}
                    className="flex max-w-[240px] items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-xs text-ink-muted"
                  >
                    {a.kind === 'image' ? (
                      <IconImage className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <IconFileText className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span className="min-w-0 truncate">{a.status === 'failed' ? '解析失败' : a.name}</span>
                    {a.status !== 'failed' && (
                      <span className="shrink-0 text-[10px]">{formatBytes(a.size)}</span>
                    )}
                    {a.status === 'uploading' && <IconLoader className="h-3 w-3 shrink-0 animate-spin" />}
                    <button
                      type="button"
                      aria-label="移除附件"
                      className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors hover:bg-wash hover:text-ink"
                      onClick={() => removeAttachment(a.id)}
                    >
                      <IconX className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={taRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  onSend();
                }
              }}
              disabled={busy}
              rows={1}
              autoFocus
              placeholder={placeholder}
              className="block max-h-[320px] w-full resize-none overflow-y-auto no-scrollbar bg-transparent px-2 py-1.5 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-muted disabled:opacity-50"
            />
            <div className="mt-1.5 flex items-center justify-between gap-3 px-1 pb-0.5">
              <div className="flex min-w-0 items-center gap-2">
                {mode === 'generate' && (
                  <>
                    <button
                      type="button"
                      onClick={() => attachInputRef.current?.click()}
                      disabled={busy}
                      title="上传文件（PDF / Word / TXT / 图片，≤20MB）"
                      aria-label="上传文件"
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line text-ink-muted transition-colors hover:bg-wash-faint hover:text-ink disabled:opacity-50"
                    >
                      <IconPaperclip className="h-3.5 w-3.5" />
                    </button>
                    <input
                      ref={attachInputRef}
                      type="file"
                      multiple
                      accept=".pdf,.doc,.docx,.txt,.md,.markdown,image/*"
                      className="hidden"
                      onChange={(e) => {
                        void addFiles(Array.from(e.target.files ?? []));
                        e.target.value = '';
                      }}
                    />
                  </>
                )}
                <span className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-line px-3 text-xs text-ink-muted">
                  <IconSparkles className="h-3.5 w-3.5" />
                  Agent 模式
                </span>
                <Select
                  options={chatModels.length > 0 ? chatModels : [{ value: '', label: '未配置模型' }]}
                  value={activeModel}
                  onChange={setModelKey}
                  disabled={busy || chatModels.length === 0}
                  triggerClassName="h-8 max-w-[200px] rounded-full border border-line bg-transparent px-3 text-xs text-ink-muted transition-colors hover:text-ink"
                />
              </div>
              {busy ? (
                <button
                  type="button"
                  onClick={stop}
                  aria-label="停止生成"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-wash-strong text-ink transition-colors hover:bg-wash"
                >
                  <span className="h-3 w-3 rounded-[2px] bg-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onSend}
                  disabled={!draft.trim() && !attachments.some((a) => a.status === 'done')}
                  aria-label="发送"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-mono text-mono-fg transition-colors hover:bg-mono-hover disabled:opacity-30"
                >
                  <IconArrowUp className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          {/* 状态行 */}
          <p
            className={`text-center text-xs text-ink-muted ${
              messages.length === 0 ? 'mt-4' : 'mb-5 mt-3'
            }`}
          >
            {statusText}
          </p>
        </div>
      </div>

      {/* 右侧内嵌预览列：常驻挂载，width 0 ↔ min(560px, 45%) 过渡；对话列 flex-1 自动补位；
          收起后卸载 iframe 释放资源 */}
      <div
        className="h-full min-w-0 overflow-hidden transition-[width] duration-300 ease-out"
        style={{ width: previewCode ? 'min(560px, 45%)' : '0%' }}
      >
        {previewCode && <PreviewPane code={previewCode} onClose={() => setPreviewCode(null)} />}
      </div>
    </div>
  );
}

/** 预览 iframe 内滚动条样式：细滚条 + 半透明圆角滑块（外层样式管不到 iframe 文档，经 srcDoc 注入） */
const PREVIEW_SCROLLBAR_CSS =
  '<style>html{scrollbar-width:thin;scrollbar-color:rgba(127,127,127,.4) transparent}' +
  '::-webkit-scrollbar{width:9px;height:9px}' +
  '::-webkit-scrollbar-thumb{background:rgba(127,127,127,.35);border-radius:99px;border:2px solid transparent;background-clip:content-box}' +
  '::-webkit-scrollbar-thumb:hover{background:rgba(127,127,127,.6);border:2px solid transparent;background-clip:content-box}' +
  '::-webkit-scrollbar-track{background:transparent}' +
  '::-webkit-scrollbar-corner{background:transparent}</style>';

/** 把滚动条样式注入预览 HTML：有 <head> 插其后，否则置于文档最前 */
function withPreviewScrollbar(code: string): string {
  if (/<head[^>]*>/i.test(code)) {
    return code.replace(/<head[^>]*>/i, (m) => m + PREVIEW_SCROLLBAR_CSS);
  }
  return PREVIEW_SCROLLBAR_CSS + code;
}

/** 右侧内嵌预览列内容：标题取 HTML <title>，支持重新加载；Esc / ✕ 收起 */
function PreviewPane({ code, onClose }: { code: string; onClose: () => void }) {
  const [nonce, setNonce] = useState(0);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(code)?.[1]?.trim() || 'HTML 预览';

  return (
    <div className="preview-fade-in flex h-full w-full flex-col border-l border-line bg-base">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line pl-5 pr-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{title}</span>
        <button
          type="button"
          onClick={() => setNonce((v) => v + 1)}
          title="重新加载"
          aria-label="重新加载"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-wash hover:text-ink"
        >
          <IconRefresh className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          title="关闭预览"
          aria-label="关闭预览"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-wash hover:text-ink"
        >
          <IconX className="h-4 w-4" />
        </button>
      </div>
      {/* sandbox 允许脚本但隔离源，模型产出的代码安全渲染；滚动条样式注入 srcDoc */}
      <iframe
        key={nonce}
        srcDoc={withPreviewScrollbar(code)}
        sandbox="allow-scripts"
        title={title}
        className="min-h-0 flex-1 bg-white"
      />
    </div>
  );
}
