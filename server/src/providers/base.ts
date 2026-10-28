import type {
  ChatRequest,
  ImageRequest,
  ModelInfo,
  ProviderInfo,
  SSEToolCall,
} from '../../../shared/types';
import type { ProviderConfig } from '../config';

/** 流式对话过程中的回调（adapter 负责逐段推送） */
export interface ChatStreamCallbacks {
  onDelta(text: string): void;
}

/** 流式对话结束后的聚合结果 */
export interface ChatStreamResult {
  /** 累积的完整回复文本 */
  text: string;
  /** 上游 finish_reason（stop / tool_calls / length 等） */
  finishReason: string;
  /** 聚合后的工具调用（含 arguments 分片合并） */
  toolCalls: SSEToolCall[];
  /** 上游 token 用量（上游支持 include_usage 时才有） */
  usage?: { promptTokens: number; completionTokens: number };
}

/** 连通性探测结果 */
export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** 向量化选项 */
export interface EmbedOptions {
  model?: string;
  signal?: AbortSignal;
}

/** Provider 适配器统一接口：所有服务商（含 mock）都实现该接口 */
export interface ProviderAdapter {
  readonly id: string;
  readonly name: string;
  isAvailable(): boolean;
  listModels(): ModelInfo[];
  toInfo(): ProviderInfo;
  /** SSE 流式对话；上游错误以异常抛出，由路由层统一转 error 事件 */
  chatStream(req: ChatRequest, cb: ChatStreamCallbacks, signal: AbortSignal): Promise<ChatStreamResult>;
  /** 返回 url 或 dataURL 列表 */
  generateImage(req: ImageRequest, signal?: AbortSignal): Promise<string[]>;
  /** 批量向量化，入参输出一一对应 */
  embed(input: string[], options?: EmbedOptions): Promise<number[][]>;
  /** 最小连通性探测 */
  probe(signal?: AbortSignal): Promise<ProbeResult>;
}

/* =============== OpenAI 兼容上游的响应结构 =============== */

interface UpstreamChatChunk {
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

interface UpstreamImageResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
}

interface UpstreamEmbeddingResponse {
  data?: Array<{ index?: number; embedding: number[] }>;
}

/** 拼接 baseUrl 与 API 路径 */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/** 读取上游错误响应中的可读信息 */
async function readUpstreamError(res: Response): Promise<string> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    // ignore
  }
  if (body) {
    try {
      const json = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
      const msg =
        (typeof json.error === 'object' && json.error?.message) ||
        (typeof json.error === 'string' ? json.error : undefined) ||
        json.message;
      if (msg) return `${res.status} ${msg}`;
    } catch {
      // 非 JSON 响应体
    }
    return `${res.status} ${body.slice(0, 200)}`;
  }
  return `${res.status} ${res.statusText || '上游请求失败'}`;
}

/**
 * OpenAI 兼容实现基类：覆盖 chat/completions（SSE 流式 + function calling）、
 * images/generations、embeddings 与连通性探测。子类只覆盖差异配置。
 */
export class OpenAICompatProvider implements ProviderAdapter {
  constructor(protected readonly cfg: ProviderConfig) {}

  get id(): string {
    return this.cfg.id;
  }

  get name(): string {
    return this.cfg.name;
  }

  isAvailable(): boolean {
    return Boolean(this.cfg.apiKey);
  }

  listModels(): ModelInfo[] {
    return this.cfg.models;
  }

  toInfo(): ProviderInfo {
    return {
      id: this.id,
      name: this.name,
      available: this.isAvailable(),
      models: this.listModels(),
    };
  }

  protected headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
    };
  }

  /** 单次请求最多携带的图片数（超出丢弃，防止请求体过大） */
  private static readonly MAX_VISION_IMAGES = 6;

  /**
   * 提取请求中的视觉输入：仅接受 dataURL 与公网 http(s) 图片地址，去重限量。
   * 无图时返回空数组。
   */
  private visionImages(req: ChatRequest): string[] {
    return (req.images ?? [])
      .filter(
        (url, index, arr): url is string =>
          typeof url === 'string' &&
          (url.startsWith('data:image/') || url.startsWith('http://') || url.startsWith('https://')) &&
          arr.indexOf(url) === index
      )
      .slice(0, OpenAICompatProvider.MAX_VISION_IMAGES);
  }

  /** 请求的模型是否声明支持视觉输入（按 models 清单的 vision 标记；未知模型视为不支持） */
  private modelSupportsVision(model: string): boolean {
    const id = model || this.cfg.chatModel;
    return this.cfg.models.some((m) => m.id === id && m.vision === true);
  }

  protected buildChatPayload(req: ChatRequest, visionImages: string[] = []): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model || this.cfg.chatModel,
      // 内部 ChatMessage 的 tool_calls 为 { id, name, arguments } 简形，
      // OpenAI 兼容上游要求 { id, type: 'function', function: { name, arguments } }，
      // 原样透传会在多轮工具对话的第二轮请求触发上游 422（missing field 'type'）
      messages: req.messages.map((m) => {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          return {
            role: m.role,
            content: m.content ?? '',
            tool_calls: m.tool_calls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            })),
          };
        }
        return m;
      }),
      stream: true,
    };
    // 视觉输入：把最后一条 user 消息转为多模态数组（文本 + 图片），OpenAI 兼容格式
    if (visionImages.length > 0) {
      const messages = body.messages as Array<{ role: string; content: unknown }>;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role === 'user') {
          messages[i] = {
            role: 'user',
            content: [
              { type: 'text', text: String(messages[i].content ?? '') },
              ...visionImages.map((url) => ({ type: 'image_url', image_url: { url } })),
            ],
          };
          break;
        }
      }
    }
    if (typeof req.temperature === 'number') {
      body.temperature = req.temperature;
    }
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }
    // 请求上游在最后一个 chunk 附带 usage（OpenAI 兼容扩展；不支持的服务商会忽略该字段）
    body.stream_options = { include_usage: true };
    return body;
  }

  protected buildImagePayload(req: ImageRequest): Record<string, unknown> {
    return {
      model: req.model || this.cfg.imageModel,
      prompt: req.prompt,
      size: req.size ?? '1024x1024',
      response_format: 'url',
      n: req.count ?? 1,
    };
  }

  protected parseImageResponse(json: UpstreamImageResponse): string[] {
    return (json.data ?? [])
      .map((item) => item.url ?? (item.b64_json ? `data:image/png;base64,${item.b64_json}` : ''))
      .filter((url) => url.length > 0);
  }

  async chatStream(
    req: ChatRequest,
    cb: ChatStreamCallbacks,
    signal: AbortSignal
  ): Promise<ChatStreamResult> {
    if (!this.cfg.baseUrl) {
      throw new Error('该服务商未配置服务地址');
    }
    // 视觉输入校验：带图但模型不支持时明确报错，避免「模型说看不到图」的静默降级
    const visionImages = this.visionImages(req);
    if (visionImages.length > 0 && !this.modelSupportsVision(req.model)) {
      throw new Error('当前模型不支持视觉输入（看图）：请改用豆包 Seed 系列等支持视觉的对话模型');
    }
    const res = await fetch(joinUrl(this.cfg.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.buildChatPayload(req, visionImages)),
      signal,
    });
    if (!res.ok) {
      throw new Error(`对话请求失败：${await readUpstreamError(res)}`);
    }
    if (!res.body) {
      throw new Error('对话请求未返回流式响应体');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let finishReason = 'stop';
    let usage: { promptTokens: number; completionTokens: number } | undefined;
    const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let chunk: UpstreamChatChunk;
      try {
        chunk = JSON.parse(payload) as UpstreamChatChunk;
      } catch {
        return; // 忽略无法解析的行
      }
      // usage chunk（choices 为空数组）在 choices 判空前捕获
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) return;
      const delta = choice.delta;
      if (delta?.content) {
        text += delta.content;
        cb.onDelta(delta.content);
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;
          const entry = toolAcc.get(index) ?? { id: '', name: '', arguments: '' };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.arguments += tc.function.arguments;
          toolAcc.set(index, entry);
        }
      }
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          handleLine(line);
        }
      }
      if (buffer.trim()) handleLine(buffer);
    } finally {
      reader.releaseLock();
    }

    const toolCalls: SSEToolCall[] = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, entry]) => ({ id: entry.id, name: entry.name, arguments: entry.arguments }));
    if (toolCalls.length > 0 && finishReason === 'stop') {
      finishReason = 'tool_calls';
    }
    return { text, finishReason, toolCalls, usage };
  }

  async generateImage(req: ImageRequest, signal?: AbortSignal): Promise<string[]> {
    if (!this.cfg.baseUrl) {
      throw new Error('该服务商未配置服务地址');
    }
    const want = Math.min(Math.max(Math.trunc(req.count ?? 1) || 1, 1), 4);
    /** 单次请求：count 经各服务商的 buildImagePayload 落到 n（不支持 n 的上游默认回 1 张） */
    const generate = async (count: number): Promise<string[]> => {
      const res = await fetch(joinUrl(this.cfg.baseUrl, '/images/generations'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.buildImagePayload({ ...req, count })),
        signal,
      });
      if (!res.ok) {
        throw new Error(`图像生成失败：${await readUpstreamError(res)}`);
      }
      const json = (await res.json()) as UpstreamImageResponse;
      return this.parseImageResponse(json);
    };
    // 首请求按目标数量要 n；上游不支持 n（智谱 / 部分 OpenAI 兼容服务）只回 1 张时，
    // 缺口以并行 n=1 请求补齐（单张失败静默跳过，至少保住已到手的部分）
    const images = await generate(want);
    if (images.length >= want) {
      return images.slice(0, want);
    }
    const rest = await Promise.all(
      Array.from({ length: want - images.length }, () => generate(1).catch(() => [] as string[]))
    );
    const all = [...images, ...rest.flat()];
    if (all.length === 0) {
      throw new Error('图像生成返回结果为空');
    }
    return all.slice(0, want);
  }

  async embed(input: string[], options?: EmbedOptions): Promise<number[][]> {
    if (!this.cfg.baseUrl) {
      throw new Error('该服务商未配置服务地址');
    }
    const model = options?.model || this.cfg.embeddingModel;
    if (!model) {
      throw new Error('该服务商未配置 embedding 模型');
    }
    const res = await fetch(joinUrl(this.cfg.baseUrl, '/embeddings'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model, input }),
      signal: options?.signal,
    });
    if (!res.ok) {
      throw new Error(`向量生成失败：${await readUpstreamError(res)}`);
    }
    const json = (await res.json()) as UpstreamEmbeddingResponse;
    const rows = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (rows.length !== input.length) {
      throw new Error('向量生成返回数量与输入不一致');
    }
    return rows.map((row) => row.embedding);
  }

  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    const startedAt = Date.now();
    try {
      const res = await fetch(joinUrl(this.cfg.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: this.cfg.chatModel,
          messages: [{ role: 'user', content: '回复 pong' }],
          max_tokens: 8,
          stream: false,
        }),
        signal,
      });
      const latencyMs = Date.now() - startedAt;
      if (!res.ok) {
        return { ok: false, latencyMs, error: await readUpstreamError(res) };
      }
      return { ok: true, latencyMs };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
