/**
 * 服务端对话 Agent：ReAct 循环 + 工具风险分级 + 记忆 / 知识库上下文注入。
 * - 理解：客户端上传全量历史，服务端负责压缩（LLM 摘要，超窗口 / refreshSummary 时）
 *   并按最后一条用户消息自动检索知识库，注入增强 system
 * - 决策 / 行动：模型发起 tool_calls → 只读工具直接执行（失败重试 1 次）；
 *   写 / 高危工具暂停，发 confirm_required 事件交由用户确认，客户端回传
 *   toolConfirms 后进入恢复模式补齐执行并续跑
 * - 记忆：收敛后 fire-and-forget 提取用户稳定信息写入长期画像（data/profile.json）
 */
import type { ChatMessage, ChatRequest, SSEEvent, SSEToolCall } from '../../shared/types';
import type { ProviderAdapter } from './providers';
import { executeTool, getToolRisk, listToolSchemas } from './tools';
import { searchKB } from './kb';
import { appendProfileFacts, extractProfileFacts, loadProfileFacts } from './memory';

/** ReAct 最大轮数（防死循环；每轮可包含多次工具调用） */
const MAX_ROUNDS = 6;
/** 历史窗口：超过该条数的早期消息压缩为摘要注入 system */
const HISTORY_WINDOW = 16;
/** 摘要输入的整体字符上限（防超长历史拖垮摘要请求） */
const SUMMARY_INPUT_CHARS = 6000;

type AgentUsage = { promptTokens: number; completionTokens: number };

export interface AgentRunResult {
  /** 跨轮累积的完整回复文本（含中间轮解释文字） */
  text: string;
  /** stop=收敛；confirm_required=暂停待确认；max_rounds=达到轮次上限 */
  finishReason: string;
  usage?: AgentUsage;
}

/** 工具清单 + ReAct 规范（带风险分级标签） */
function buildToolSection(tools: ReturnType<typeof listToolSchemas>): string {
  const riskLabel: Record<string, string> = { read: '只读', write: '写入', danger: '高危' };
  return [
    '',
    '你可以调用以下工具获取外部信息或执行操作（仅按 JSON Schema 传参）：',
    ...tools.map((t) => `- ${t.name}（${riskLabel[t.risk ?? 'read'] ?? '只读'}）：${t.description}`),
    '规范：',
    '- 需要实时信息 / 计算 / 检索时才调用工具，依据返回结果继续回答；信息足够后停止调用，直接给出最终回答。',
    '- 标注「写入」的工具会修改数据、「高危」的工具不可逆：调用前用一句话向用户说明即将执行的操作；这类调用会先暂停并弹出确认卡片，用户在界面上确认后才会真正执行。',
    '- 严禁编造工具未返回的数据。',
  ].join('\n');
}

/** 序列化摘要输入：每条消息一行（角色前缀），整体截断到 SUMMARY_INPUT_CHARS */
function serializeOverflow(overflow: ChatMessage[]): string {
  const lines: string[] = [];
  let total = 0;
  for (const m of overflow) {
    const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '工具';
    const content = Array.from(m.content).slice(0, 300).join('');
    const line = `${who}：${content}`;
    total += line.length + 1;
    if (total > SUMMARY_INPUT_CHARS) break;
    lines.push(line);
  }
  return lines.join('\n');
}

/** 用 LLM 将旧摘要与溢出消息合并为新摘要；失败抛出由调用方兜底（回退旧摘要） */
async function summarizeHistory(
  adapter: ProviderAdapter,
  oldSummary: string,
  overflow: ChatMessage[],
  signal: AbortSignal
): Promise<string> {
  const res = await adapter.chatStream(
    {
      provider: adapter.id,
      model: '',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            '你是对话摘要器。将给定的对话历史压缩为简洁摘要，保留：用户的诉求与偏好、已确认的事实与结论、未完成的事项。直接输出摘要正文，不要任何开场白。',
        },
        {
          role: 'user',
          content: [
            oldSummary ? `已有摘要：\n${oldSummary}` : '',
            '新增对话：',
            serializeOverflow(overflow),
            '',
            '请输出合并后的完整摘要（500 字以内）。',
          ]
            .filter((part) => part.length > 0)
            .join('\n'),
        },
      ],
    },
    { onDelta: () => {} },
    signal
  );
  return res.text.trim().slice(0, 1200);
}

/**
 * 非恢复模式：组装增强 system（基底 + 工具规范 + 长期记忆 + 历史摘要 + 知识库检索），
 * 原地回写 messages[0]。检索 / 画像 / 摘要任一失败均静默降级，不阻塞对话。
 */
async function buildContext(
  messages: ChatMessage[],
  request: ChatRequest,
  adapter: ProviderAdapter,
  onEvent: (e: SSEEvent) => void,
  signal: AbortSignal
): Promise<void> {
  const parts: string[] = [];
  const first = messages[0];
  parts.push(first?.role === 'system' && first.content ? first.content : '你是一个乐于助人的 AI 助手。');

  // ① 工具清单 + ReAct 规范
  const tools = listToolSchemas();
  if (tools.length > 0) parts.push(buildToolSection(tools));

  // ② 长期用户画像
  try {
    const facts = await loadProfileFacts();
    if (facts.length > 0) {
      parts.push(['', '[关于用户的长期记忆]', ...facts.map((f) => `- ${f}`)].join('\n'));
    }
  } catch {
    // 画像读取失败：静默降级
  }

  // ③ 历史摘要：客户端要求整体重摘，或历史超窗口时增量压缩
  const history = messages.filter((m) => m.role !== 'system');
  let summary = request.historySummary ?? '';
  const wantSummarize = request.refreshSummary === true || history.length > HISTORY_WINDOW;
  if (wantSummarize) {
    const overflow =
      request.refreshSummary === true ? history : history.slice(0, history.length - HISTORY_WINDOW);
    try {
      const merged = await summarizeHistory(adapter, summary, overflow, signal);
      if (merged) {
        summary = merged;
        onEvent({ type: 'memory_summary', summary });
      }
    } catch {
      // 摘要失败：沿用旧摘要
    }
  }
  if (summary) {
    parts.push(['', '[历史对话摘要]', summary, '（更早的对话已压缩为摘要，其后为最近原文）'].join('\n'));
  }

  // ④ 知识库检索：用最后一条用户消息查询
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (lastUser && lastUser.content.trim()) {
    try {
      const query = Array.from(lastUser.content.trim()).slice(0, 200).join('');
      const { fragments } = await searchKB(query, 3);
      if (fragments.length > 0) {
        parts.push(
          [
            '',
            '[知识库检索结果]（回答可引用，注明来源文件）',
            ...fragments.map((f, i) => `${i + 1}. ${f.text}（来源：${f.source}）`),
          ].join('\n')
        );
        onEvent({ type: 'rag_context', fragments });
      }
    } catch {
      // 检索失败：静默降级
    }
  }

  const systemContent = parts.join('\n\n');
  if (first?.role === 'system') {
    messages[0] = { ...first, content: systemContent };
  } else {
    messages.unshift({ role: 'system', content: systemContent });
  }
}

/** 恢复模式：补齐 confirm 暂停时未执行的调用（只读直执行；写 / 高危按用户授权执行或跳过） */
async function resumePendingCalls(
  messages: ChatMessage[],
  toolConfirms: { callId: string; approved: boolean }[],
  onEvent: (e: SSEEvent) => void
): Promise<void> {
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0);
  if (!lastAssistant?.tool_calls) return;
  const answered = new Set(
    messages.filter((m) => m.role === 'tool' && m.tool_call_id).map((m) => m.tool_call_id)
  );
  for (const call of lastAssistant.tool_calls) {
    if (answered.has(call.id)) continue;
    const risk = getToolRisk(call.name) ?? 'read';
    let content: string;
    let ok: boolean;
    if (risk === 'read') {
      const r = await executeTool(call.name, call.arguments);
      ok = r.ok;
      content = r.ok ? (r.result ?? '') : `工具执行失败：${r.error ?? '未知错误'}`;
    } else if (toolConfirms.find((c) => c.callId === call.id)?.approved === true) {
      const r = await executeTool(call.name, call.arguments, true);
      ok = r.ok;
      content = r.ok ? (r.result ?? '') : `工具执行失败：${r.error ?? '未知错误'}`;
    } else {
      ok = false;
      content = '用户未授权该工具调用，已跳过执行。';
    }
    onEvent({ type: 'tool_result', callId: call.id, name: call.name, content, ok });
    messages.push({ role: 'tool', tool_call_id: call.id, content });
  }
}

/** 收敛后异步提取长期记忆（fire-and-forget，不阻塞响应收尾；异常静默） */
async function updateProfile(
  adapter: ProviderAdapter,
  messages: ChatMessage[],
  answer: string
): Promise<void> {
  try {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser || !answer.trim()) return;
    const clip = (s: string, n: number): string => Array.from(s).slice(0, n).join('');
    const transcript = `用户：${clip(lastUser.content, 600)}\n助手：${clip(answer, 400)}`;
    const facts = await extractProfileFacts(adapter, transcript);
    if (facts.length === 0) return;
    const total = await appendProfileFacts(facts);
    console.log(`[agent] 长期记忆更新：+${facts.length} 条（共 ${total} 条）`);
  } catch (err) {
    console.log(`[agent] 长期记忆提取失败（已忽略）：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 运行服务端 Agent：入口（新对话）→ 上下文注入 → ReAct 主循环；
 * 恢复模式（toolConfirms 非空）→ 补齐被确认暂停的调用 → 主循环。
 * 主循环内 delta 实时转发，收敛后由调用方（路由）负责输出检查与 done 事件。
 */
export async function runAgent(
  request: ChatRequest,
  adapter: ProviderAdapter,
  onEvent: (event: SSEEvent) => void,
  signal: AbortSignal
): Promise<AgentRunResult> {
  // 协议消息拷贝：恢复模式下为客户端原样回传的完整协议数组（含 system / tool 消息）
  const messages: ChatMessage[] = request.messages.map((m) => ({ ...m }));
  const isResume = Array.isArray(request.toolConfirms) && request.toolConfirms.length > 0;

  if (isResume) {
    await resumePendingCalls(messages, request.toolConfirms ?? [], onEvent);
  } else {
    await buildContext(messages, request, adapter, onEvent, signal);
  }

  const tools = listToolSchemas();
  let text = '';
  let finishReason = 'stop';
  let usage: AgentUsage | undefined;
  let converged = false;

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const result = await adapter.chatStream(
      { ...request, messages, tools },
      {
        onDelta: (t) => {
          text += t;
          onEvent({ type: 'delta', text: t });
        },
      },
      signal
    );
    if (result.usage) {
      usage = usage
        ? {
            promptTokens: usage.promptTokens + result.usage.promptTokens,
            completionTokens: usage.completionTokens + result.usage.completionTokens,
          }
        : result.usage;
    }

    // 无工具调用：本轮即最终回答
    if (result.toolCalls.length === 0) {
      finishReason = result.finishReason;
      converged = true;
      break;
    }

    // 记录 assistant 工具调用并转发（带风险分级）
    messages.push({
      role: 'assistant',
      content: result.text,
      tool_calls: result.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
    });
    const callsWithRisk: SSEToolCall[] = result.toolCalls.map((c) => ({
      ...c,
      risk: getToolRisk(c.name),
    }));
    onEvent({ type: 'tool_calls', calls: callsWithRisk });

    // 含写 / 高危调用：暂停等待用户确认（确认后客户端回传完整协议数组续跑）
    if (callsWithRisk.some((c) => c.risk === 'write' || c.risk === 'danger')) {
      onEvent({
        type: 'confirm_required',
        calls: callsWithRisk.filter((c) => c.risk !== 'read'),
        messages,
      });
      return { text, finishReason: 'confirm_required', usage };
    }

    // 全只读：逐个执行（失败重试 1 次）→ 回填观察消息进入下一轮
    for (const call of result.toolCalls) {
      let r = await executeTool(call.name, call.arguments);
      if (!r.ok) r = await executeTool(call.name, call.arguments);
      const content = r.ok ? (r.result ?? '') : `工具执行失败：${r.error ?? '未知错误'}`;
      onEvent({ type: 'tool_result', callId: call.id, name: call.name, content, ok: r.ok });
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }

  if (!converged) {
    finishReason = 'max_rounds';
    onEvent({ type: 'agent_step', kind: 'notice', content: `已达最大工具调用轮次（${MAX_ROUNDS} 轮），以上为当前进展` });
  } else {
    // 收敛成功：异步提取长期记忆
    void updateProfile(adapter, messages, text);
  }

  return { text, finishReason, usage };
}
