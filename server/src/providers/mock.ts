import type {
  ChatRequest,
  ImageRequest,
  ModelInfo,
  ProviderInfo,
  SSEToolCall,
  ToolSchema,
} from '../../../shared/types';
import type {
  ChatStreamCallbacks,
  ChatStreamResult,
  ProbeResult,
  ProviderAdapter,
} from './base';

/** 本地确定性字符串哈希（djb2 变体） */
function hashString(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 按固定字符数切段（用 Array.from 保证不截断代理对） */
function chunkString(text: string, size: number): string[] {
  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += size) {
    chunks.push(chars.slice(i, i + size).join(''));
  }
  return chunks;
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 基于字符 hash 的 64 维伪向量（L2 归一化） */
function hashEmbed(text: string, dim: number): number[] {
  const vector = new Array<number>(dim).fill(0);
  let i = 0;
  for (const ch of text) {
    const h = hashString(`${ch}#${i}`);
    vector[h % dim] += 1;
    vector[(h >>> 8) % dim] += 0.5;
    i++;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => Number((v / norm).toFixed(6)));
}

/** 渐变底 + prompt 文字水印的演示 SVG */
function buildDemoSvg(prompt: string, seed: number): string {
  const hue = hashString(prompt) % 360;
  const hue2 = (hue + 60) % 360;
  const label = xmlEscape(clip(prompt.trim(), 24) || '演示图像');
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">',
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
    `<stop offset="0%" stop-color="hsl(${hue},70%,62%)"/>`,
    `<stop offset="100%" stop-color="hsl(${hue2},72%,45%)"/>`,
    '</linearGradient></defs>',
    '<rect width="1024" height="1024" fill="url(#g)"/>',
    `<circle cx="${300 + ((seed * 173) % 400)}" cy="380" r="180" fill="rgba(255,255,255,0.18)"/>`,
    `<circle cx="${640 + ((seed * 97) % 260)}" cy="660" r="120" fill="rgba(255,255,255,0.12)"/>`,
    `<text x="512" y="470" text-anchor="middle" font-family="'Microsoft YaHei',sans-serif" font-size="52" font-weight="bold" fill="rgba(255,255,255,0.92)">${label}</text>`,
    `<text x="512" y="560" text-anchor="middle" font-family="'Microsoft YaHei',sans-serif" font-size="30" fill="rgba(255,255,255,0.75)">演示模式生成 · mock-image</text>`,
    '</svg>',
  ].join('');
}

function toSvgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

function pickTool(tools: ToolSchema[], wantTime: boolean, wantCalc: boolean): ToolSchema | undefined {
  if (wantTime) {
    const found = tools.find((tool) => /time|时间/i.test(`${tool.name} ${tool.description}`));
    if (found) return found;
  }
  if (wantCalc) {
    const found = tools.find((tool) => /calc|math|计算|expression/i.test(`${tool.name} ${tool.description}`));
    if (found) return found;
  }
  return tools[0];
}

/** 提取消息中的四则运算片段（如 23*7、(1+2)*3 的平铺部分），用于 calculator 演示参数 */
function extractExpression(prompt: string): string | undefined {
  const match = /\d+(?:\.\d+)?(?:\s*[+\-*/%^]\s*\d+(?:\.\d+)?)+/.exec(prompt);
  return match ? match[0].replace(/\s+/g, '') : undefined;
}

/**
 * mock 服务商：无需任何密钥、始终可用，让无 API Key 时也能全流程演示。
 * chat 逐字流式返回演示文本并支持 function calling 演示；
 * image 返回本地生成的 SVG data URL；embedding 返回字符 hash 伪向量。
 */
export class MockProvider implements ProviderAdapter {
  readonly id = 'mock';
  readonly name = '演示模式';

  private readonly models: ModelInfo[] = [
    { id: 'mock-chat', name: '演示对话模型', kind: ['chat'] },
    { id: 'mock-image', name: '演示绘图模型', kind: ['image'] },
    { id: 'mock-embedding', name: '演示向量模型', kind: ['embedding'] },
  ];

  isAvailable(): boolean {
    return true;
  }

  listModels(): ModelInfo[] {
    return this.models;
  }

  toInfo(): ProviderInfo {
    return { id: this.id, name: this.name, available: true, models: this.models };
  }

  async chatStream(
    req: ChatRequest,
    cb: ChatStreamCallbacks,
    signal: AbortSignal
  ): Promise<ChatStreamResult> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const prompt = (lastUser?.content ?? '').trim();
    // 已进入"工具结果回传"轮：给出最终回答，不再发起工具调用，让 Agent 循环收敛
    const lastTool = [...req.messages].reverse().find((m) => m.role === 'tool');
    const reply = lastTool
      ? [
          `已收到工具返回结果：${clip(lastTool.content, 160) || '（空）'}。`,
          '综合以上工具结果，这是演示模式下的最终回答（未调用真实模型服务）。',
        ].join('\n')
      : [
          `收到你的消息：「${clip(prompt, 60) || '（空）'}」。`,
          '当前处于演示模式：未调用任何真实模型服务，以下为本地生成的演示回复。',
          '1. 流式输出已生效，可以看到文字逐段推送；',
          '2. 携带 tools 并在消息中包含“时间”或“计算”等关键词，可演示 function calling；',
          '3. 在 server/.env 配置任一真实服务商的 API Key 后，本节点即可切换到真实模型。',
        ].join('\n');

    let text = '';
    for (const chunk of chunkString(reply, 2)) {
      if (signal.aborted) {
        return { text, finishReason: 'stop', toolCalls: [] };
      }
      text += chunk;
      cb.onDelta(chunk);
      await sleep(12);
    }

    const toolCalls = lastTool ? [] : this.maybeToolCalls(req, prompt);
    if (toolCalls.length > 0) {
      const hint = `\n（演示：正在请求调用工具 ${toolCalls[0].name}，请把 tool_calls 事件交给工作流执行工具后回传）`;
      text += hint;
      cb.onDelta(hint);
    }
    return { text, finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop', toolCalls };
  }

  /** 消息包含“时间/计算”等关键词且携带 tools 时，返回一次工具调用用于演示 */
  private maybeToolCalls(req: ChatRequest, prompt: string): SSEToolCall[] {
    const tools = req.tools ?? [];
    if (tools.length === 0) return [];
    const wantTime = /时间|几点|date|time/i.test(prompt);
    const expression = extractExpression(prompt);
    const wantCalc = /计算|math|calc|expression/i.test(prompt) || expression !== undefined;
    if (!wantTime && !wantCalc) return [];
    const callId = (tool: ToolSchema): string =>
      `call_mock_${hashString(prompt + tool.name).toString(36)}`;
    // 消息里带可计算的算式时优先演示 calculator，参数直接取自原文
    if (expression) {
      const calc = tools.find((tool) =>
        /calc|math|计算|expression/i.test(`${tool.name} ${tool.description}`)
      );
      if (calc) {
        return [{ id: callId(calc), name: calc.name, arguments: JSON.stringify({ expression }) }];
      }
    }
    const tool = pickTool(tools, wantTime, wantCalc);
    if (!tool) return [];
    const args =
      wantCalc && !wantTime
        ? '{"expression":"1+1"}'
        : wantTime && !wantCalc
          ? '{"timezone":"Asia/Shanghai"}'
          : '{}';
    return [{ id: callId(tool), name: tool.name, arguments: args }];
  }

  async generateImage(req: ImageRequest): Promise<string[]> {
    const count = Math.min(Math.max(Math.trunc(req.count ?? 1) || 1, 1), 4);
    const images: string[] = [];
    for (let i = 0; i < count; i++) {
      images.push(toSvgDataUrl(buildDemoSvg(req.prompt, i)));
    }
    return images;
  }

  async embed(input: string[]): Promise<number[][]> {
    return input.map((text) => hashEmbed(text, 64));
  }

  async probe(): Promise<ProbeResult> {
    const startedAt = Date.now();
    await sleep(20);
    return { ok: true, latencyMs: Date.now() - startedAt };
  }
}
