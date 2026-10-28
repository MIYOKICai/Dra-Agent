/**
 * 「一键创作」对话会话存储（生成模式）：
 * - 会话列表持久化到 localStorage（zustand persist → `agent-creation-sessions-v1`），
 *   左侧边栏「创作对话」分组与创作面板共享同一份数据
 * - upsert 按最近更新置顶；流式回答期间不写盘，仅在回答结束/中止后统一落盘
 *   （参考知识库问答的经验：流式期间频繁序列化会拖慢渲染）
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ToolRisk } from '@shared/types';
import { safeLocalStorage } from '../store/safeStorage';

/** 助手消息的工具过程步骤（随消息持久化，回看时以单行 chip 呈现） */
export interface CreationStep {
  kind: 'tool_call' | 'tool_result' | 'notice';
  /** kind 为 tool_call / tool_result 时的工具名；notice 无 */
  tool?: string;
  /** 调用=参数摘要；结果=结果摘要（截断）；notice=过程说明 */
  content: string;
  /** 仅 tool_call：风险分级（write 黄点 / danger 红点徽标） */
  risk?: ToolRisk;
  /** 仅 tool_result：执行是否成功 */
  ok?: boolean;
}

/** 对话消息（创作会话内仅用户 / 助手两种角色） */
export interface CreationMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 助手消息的 ReAct 工具调用过程（可选） */
  steps?: CreationStep[];
  /** 助手消息完成时间戳（流式结束后写入；回看操作行的时间显示） */
  time?: number;
  /** 助手消息 token 用量（上游返回时才有；操作行「用量」显示） */
  usage?: { promptTokens: number; completionTokens: number };
}

/** 一次「生成」模式的创作对话 */
export interface CreationSession {
  id: string;
  /** 标题取自首条用户消息（截断） */
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: CreationMessage[];
  /** 长对话压缩摘要（服务端 LLM 生成，覆盖到 summaryAt 条消息为止） */
  summary?: string;
  /** 摘要覆盖到的消息条数（客户端据此决定是否要求服务端整体重摘） */
  summaryAt?: number;
}

interface CreationSessionsState {
  sessions: CreationSession[];
  /** 新增或更新会话（按 updatedAt 置顶） */
  upsert: (session: CreationSession) => void;
  /** 移除会话（首字前失败/中止时清掉刚预创建的会话，避免列表残留无回答的空壳） */
  remove: (id: string) => void;
  /** 重命名会话标题（空输入忽略，保持原标题；不改变列表排序） */
  rename: (id: string, title: string) => void;
}

export const useCreationSessions = create<CreationSessionsState>()(
  persist(
    (set, get) => ({
      sessions: [],
      upsert: (session) =>
        set({
          sessions: [session, ...get().sessions.filter((s) => s.id !== session.id)],
        }),
      remove: (id) =>
        set({
          sessions: get().sessions.filter((s) => s.id !== id),
        }),
      rename: (id, title) => {
        const t = title.trim();
        if (!t) return;
        set({
          sessions: get().sessions.map((s) => (s.id === id ? { ...s, title: t } : s)),
        });
      },
    }),
    {
      name: 'agent-creation-sessions-v1',
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (s) => ({ sessions: s.sessions }),
    }
  )
);

/** 由首条用户消息派生会话标题（压平空白后截断 20 字） */
export function deriveSessionTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 20 ? `${t.slice(0, 20)}…` : t;
}

/** 会话 id 生成（与画布 store 同款兜底策略） */
export function newSessionId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 粗略 token 估算（中英混合约 2.5 字符/token），仅用于历史消息缺真实 usage 时的展示回填 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

/**
 * 历史消息元数据回填：用量/时间功能上线前的助手消息没有 time / usage 落盘，
 * 载入会话时补齐展示数据（不改持久化）——用量按正文长度估算；
 * 时间从会话 updatedAt 起按固定步长向历史倒推，已有真实时间的消息保持不变。
 * 用户消息缺 time（时间戳功能前发送）：取其后第一条已具时间助手消息的时间
 * （发送必然早于回复），其后无助手消息时沿用会话 updatedAt。
 */
export function backfillMessageMeta(
  messages: CreationMessage[],
  updatedAt?: number
): CreationMessage[] {
  let cursor = updatedAt ?? Date.now();
  return messages.map((m, idx) => {
    if (m.role === 'user') {
      if (m.time) return m;
      for (let j = idx + 1; j < messages.length; j++) {
        if (messages[j].role === 'assistant' && messages[j].time) {
          return { ...m, time: messages[j].time };
        }
      }
      return { ...m, time: cursor };
    }
    if (m.role !== 'assistant') return m;
    let next = m;
    if (!next.time) {
      next = { ...next, time: cursor };
      cursor -= 45_000;
    } else {
      cursor = Math.min(cursor, next.time);
    }
    if (!next.usage) {
      next = {
        ...next,
        usage: { promptTokens: 0, completionTokens: estimateTokens(next.content) },
      };
    }
    return next;
  });
}
