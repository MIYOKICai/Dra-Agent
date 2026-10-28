import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ChatMessage, ChatRequest, SSEEvent } from '../../../shared/types';
import { getAdapter } from '../providers';
import { runAgent } from '../agent';
import { checkText } from '../safety';

export const chatRouter = Router();

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

function sendEvent(res: Response, event: SSEEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function isChatMessages(value: unknown): value is ChatMessage[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => {
      const msg = item as ChatMessage;
      return typeof msg?.role === 'string' && typeof msg?.content === 'string';
    })
  );
}

/**
 * POST /api/chat：SSE 流式对话。
 * 事件序列：delta... → [tool_calls] → [blocked(输出命中敏感词时)] → done。
 * 输入命中敏感词时不请求上游，直接 blocked + done；
 * 客户端中断（req close）时向上游发送 abort。
 */
chatRouter.post('/', (req: Request, res: Response) => {
  const body = req.body as Partial<ChatRequest> | undefined;
  if (!body || typeof body.provider !== 'string' || !isChatMessages(body.messages)) {
    res.status(400).json({ error: '请求格式错误：需要 provider 与非空 messages 数组' });
    return;
  }
  const adapter = getAdapter(body.provider);
  if (!adapter) {
    res.status(404).json({ error: `未知服务商：${body.provider}` });
    return;
  }

  res.writeHead(200, SSE_HEADERS);
  res.flushHeaders();

  const controller = new AbortController();
  // Node 18+ 中 req 的 close 在请求体读取完毕即触发，不能用于检测客户端断开；
  // 监听 res 的 close：未正常结束响应就关闭连接（客户端中断）时才 abort 上游
  const onResClose = (): void => {
    if (!res.writableEnded) {
      controller.abort();
    }
  };
  res.on('close', onResClose);

  const request: ChatRequest = {
    provider: body.provider,
    model: typeof body.model === 'string' ? body.model : '',
    messages: body.messages,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    tools: Array.isArray(body.tools) ? body.tools : undefined,
    // 视觉输入：随请求透传，由 provider 层做能力校验与多模态拼装
    images: Array.isArray(body.images)
      ? (body.images as unknown[]).filter((url): url is string => typeof url === 'string')
      : undefined,
    // 服务端 Agent 模式：ReAct 循环 / 风险分级 / 记忆与知识库注入（runAgent 内处理）
    agent: body.agent === true,
    historySummary: typeof body.historySummary === 'string' ? body.historySummary : undefined,
    refreshSummary: body.refreshSummary === true,
    toolConfirms: Array.isArray(body.toolConfirms)
      ? (body.toolConfirms as unknown[]).filter(
          (c): c is { callId: string; approved: boolean } =>
            Boolean(c) &&
            typeof (c as { callId?: unknown }).callId === 'string' &&
            typeof (c as { approved?: unknown }).approved === 'boolean'
        )
      : undefined,
  };

  void (async () => {
    try {
      // 诊断日志：每次对话请求的模型与视觉输入数量
      console.log(
        `[chat] model=${request.model} images=${request.images?.length ?? 0} (${request.images?.reduce((n, u) => n + u.length, 0) ?? 0} 字符)`
      );
      if (!adapter.isAvailable()) {
        sendEvent(res, {
          type: 'error',
          message: `服务商「${adapter.name}」未配置 API Key，请在 server/.env 配置后重试`,
        });
        sendEvent(res, { type: 'done' });
        return;
      }

      // 输入安全检查：所有 role=user 消息
      const userInput = request.messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .join('\n');

      /* ---- 服务端 Agent 模式：ReAct 循环下沉到 runAgent ---- */
      if (request.agent === true) {
        // 恢复模式（确认续跑）：协议消息由客户端原样回传，跳过输入检查
        const isResume = (request.toolConfirms?.length ?? 0) > 0;
        if (!isResume) {
          const agentInputCheck = await checkText(userInput);
          if (agentInputCheck.blocked) {
            sendEvent(res, {
              type: 'blocked',
              reason: `输入命中敏感词：${agentInputCheck.hits.join('、')}`,
            });
            sendEvent(res, { type: 'done', finishReason: 'blocked' });
            return;
          }
        }
        const result = await runAgent(request, adapter, (event) => sendEvent(res, event), controller.signal);
        // 输出安全检查：done 之前对累积文本检查，命中则补发 blocked 事件
        const outputCheck = await checkText(result.text);
        if (outputCheck.blocked) {
          sendEvent(res, { type: 'blocked', reason: `输出命中敏感词：${outputCheck.hits.join('、')}` });
        }
        sendEvent(res, { type: 'done', finishReason: result.finishReason, usage: result.usage });
        return;
      }

      const inputCheck = await checkText(userInput);
      if (inputCheck.blocked) {
        sendEvent(res, { type: 'blocked', reason: `输入命中敏感词：${inputCheck.hits.join('、')}` });
        sendEvent(res, { type: 'done', finishReason: 'blocked' });
        return;
      }

      let accumulated = '';
      const result = await adapter.chatStream(
        request,
        {
          onDelta: (text) => {
            accumulated += text;
            sendEvent(res, { type: 'delta', text });
          },
        },
        controller.signal
      );

      if (result.toolCalls.length > 0) {
        sendEvent(res, { type: 'tool_calls', calls: result.toolCalls });
      }

      // 输出安全检查：done 之前对累积文本检查，命中则补发 blocked 事件
      const outputCheck = await checkText(accumulated);
      if (outputCheck.blocked) {
        sendEvent(res, { type: 'blocked', reason: `输出命中敏感词：${outputCheck.hits.join('、')}` });
      }

      sendEvent(res, {
        type: 'done',
        finishReason: result.toolCalls.length > 0 ? 'tool_calls' : result.finishReason,
        usage: result.usage,
      });
    } catch (err) {
      if (!controller.signal.aborted && !res.destroyed && !res.writableEnded) {
        sendEvent(res, { type: 'error', message: err instanceof Error ? err.message : String(err) });
        sendEvent(res, { type: 'done' });
      }
    } finally {
      res.off('close', onResClose);
      if (!res.destroyed && !res.writableEnded) {
        res.end();
      }
    }
  })();
});
