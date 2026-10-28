/**
 * 一键创作：把用户的想法交给 LLM 编排成画布工作流。
 * - buildComposerSystem：节点类型目录 + JSON 输出约定（仅输出 JSON）
 * - parseComposerOutput：剥离代码围栏后解析并做结构校验（缺失字段兜底）
 * - toWorkflowTemplate：把 LLM 的扁平 JSON 补全为可载入画布的模板
 *   （分层布局 + 每类节点的 config 缺省值；provider/model 留空由 applyTemplate 回填）
 */
import type { NodeType } from '@shared/types';
import type { WorkflowTemplate } from '../templates';
import { IconSparkles } from '../components/icons';

/** LLM 可编排的节点类型（白名单） */
const NODE_TYPES = new Set(['input', 'file', 'template', 'llm', 'image', 'retrieval', 'condition', 'agent', 'output']);

export type ComposerMode = 'generate' | 'canvas';

const MODE_HINTS: Record<ComposerMode, string> = {
  generate: '偏内容创作：以文案 / 故事 / 图像生成链路为主，突出创意与产出质量。',
  canvas: '偏流程编排：合理使用检索 / 条件分支 / Agent 工具调用，突出链路健壮性。',
};

/** 「生成」模式的对话 system 提示词：先思考规划再产出（ReAct 式），只开展创作对话，不输出画布 JSON */
export function buildConversationSystem(): string {
  return [
    '你是 AI 工作流画布「一键创作」里的创作伙伴，与用户以对话方式打磨创意。',
    '要求：',
    '1. 用中文回答，语气自然简洁，直接给出结论与建议，不堆客套话。',
    '2. 先思考再输出：遇到复杂需求先给一句极简方案（做什么、分几步）再产出，避免长篇跑偏。',
    '3. 围绕用户的想法给出具体、可落地的建议：适合的节点链路（如 输入 → LLM → 图像 → 输出）、提示词写法、可用工具与分支设计。',
    '4. 用户想创作内容（文案 / 故事 / 图像描述等）时直接创作，给出成品而非空泛建议。',
    '5. 用户需要代码（网页效果 / 脚本 / 样式等）时，用 ```语言 的围栏代码块输出完整可运行的代码；网页效果一律输出单文件 HTML（内联 CSS 与 JS），确保点击「运行」即可直接预览。',
    '6. 事实与数据宁可说明假设也不要编造；无法核实的实时信息要注明不确定。',
    '7. 不要输出 JSON，也不要声称已生成画布；若用户想把想法变成可运行的工作流，提示其切换到「画布」模式生成。',
  ].join('\n');
}

/** 创作面板的 system 提示词：目录 + 格式 + 风格提示 */
export function buildComposerSystem(mode: ComposerMode): string {
  return [
    '你是画布工作流编排师。根据用户想法，设计一个可在节点画布上执行的工作流，仅输出一个 JSON 对象，不要解释、不要 markdown 代码块标记。',
    '',
    '可用节点 type 与 config：',
    '- input：起点，接收用户输入。config: { "text": "示例输入" }',
    '- file：文件上传起点。config: { "files": [] }（生成后需用户在节点上手动拖入 PDF / Word / TXT / 图片；仅当用户想法明确围绕已有文档 / 图片时才使用，并说明需手动上传）',
    '- llm：文本生成。config: { "systemPrompt": "角色与要求", "userPrompt": "可用 {{上游节点label}} 引用上游输出", "temperature": 0.7 }',
    '- agent：可调用工具的智能体。config: { "systemPrompt": "…", "userPrompt": "…", "tools": ["webSummary","getCurrentTime","calculator","searchKnowledge"], "maxIterations": 6 }',
    '- retrieval：知识库检索。config: { "query": "{{上游label}}", "topK": 3 }',
    '- template：文本模板拼接。config: { "template": "…{{上游label}}…" }',
    '- image：图像生成。config: { "prompt": "{{上游label}}", "size": "1024x1024", "count": 2 }',
    '- condition：按关键词二分支。config: { "keyword": "关键词" }，其两条出边分别带 sourceHandle "true" / "false"',
    '- output：终点，展示结果。config: {}',
    '',
    '输出格式：',
    '{"name":"简短工作流名","nodes":[{"id":"n1","type":"input","label":"主题输入","config":{"text":"…"}}],"edges":[{"source":"n1","target":"n2"},{"source":"n3","target":"n4","sourceHandle":"true"}]}',
    '',
    '规则：',
    '1. 以 input 开始、output 结束；节点 3~8 个；每条连线的 source/target 必须引用存在的节点 id。',
    '2. llm/agent 的 userPrompt、template 的 template、image 的 prompt、retrieval 的 query 用 {{节点label}} 引用上游输出。',
    '3. config 内容要具体、可直接执行，紧密围绕用户想法设计；中文书写；每个字符串字段控制在 60 字以内（{{引用}} 占位符除外）。用户给了长文本 / 参考资料 / 文档时，提炼要点与关键信息来设计节点，严禁把原文整段照抄进 config。',
    '4. 仅当用户想法明确要求按内容分流时才使用 condition 节点；其余情况一律使用线性链路（不做分支）。',
    '5. 使用 condition 时必须配对约定标记：其上游须有一个 llm/template 节点在输出中稳定写出标记词（如「[配图]」/「[跳过]」，并写入该节点的提示词要求），condition 的 keyword 必须恰为该标记词本身；禁止使用语义宽泛、运行时可能不出现的关键词。',
    `6. 本次创作风格：${MODE_HINTS[mode]}`,
  ].join('\n');
}

/** 剥离 ```json 围栏 / 前后杂文，取出首个 {...} JSON 文本 */
function stripFences(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return t;
}

/**
 * 从可能被截断的 LLM 输出中按括号配平提取 key（nodes / edges）数组里已完整闭合的对象。
 * 长参考文本会让模型输出超出 max tokens 被掐断，整体 JSON.parse 必然失败；
 * 逐对象扫描可抢救出已生成完成的节点/连线（末尾残缺对象直接丢弃）。
 */
function extractArrayObjects(text: string, key: 'nodes' | 'edges'): Record<string, unknown>[] {
  const keyIdx = text.indexOf(`"${key}"`);
  if (keyIdx < 0) return [];
  const arrStart = text.indexOf('[', keyIdx);
  if (arrStart < 0) return [];
  const out: Record<string, unknown>[] = [];
  let i = arrStart + 1;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (i >= text.length || text[i] !== '{') break;
    const objStart = i;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let complete = false;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          i++;
          complete = true;
          break;
        }
      }
    }
    if (!complete) break; // 输出在对象中途被截断
    try {
      out.push(JSON.parse(text.slice(objStart, i)) as Record<string, unknown>);
    } catch {
      // 单对象损坏（如字符串内含未转义控制符）：跳过该对象继续抢救后续
    }
  }
  return out;
}

/** 截断兜底：整体解析失败时，按 key 抢救 name / nodes / edges */
function salvageComposer(text: string): { name?: unknown; nodes?: unknown; edges?: unknown } | null {
  const nodes = extractArrayObjects(text, 'nodes');
  if (nodes.length === 0) return null;
  const edges = extractArrayObjects(text, 'edges');
  const nameMatch = text.match(/"name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  let name: unknown;
  if (nameMatch) {
    try {
      name = JSON.parse(`"${nameMatch[1]}"`) as unknown;
    } catch {
      name = nameMatch[1];
    }
  }
  return { name, nodes, edges: Array.isArray(edges) ? edges : [] };
}

/** LLM 原始输出解析并校验：不合法处兜底，节点/连线全空则视为失败 */
export function parseComposerOutput(
  text: string
): { name: string; nodes: ComposerNode[]; edges: ComposerEdge[] } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stripFences(text));
  } catch {
    // 整体解析失败（常见于长输入导致输出被 max tokens 截断）：抢救已完整生成的部分
    raw = salvageComposer(text);
    if (!raw) return null;
  }
  const obj = raw as { name?: unknown; nodes?: unknown; edges?: unknown };
  if (!obj || !Array.isArray(obj.nodes) || obj.nodes.length === 0) return null;

  const nodes: ComposerNode[] = [];
  const ids = new Set<string>();
  obj.nodes.forEach((n, i) => {
    const item = n as Partial<ComposerNode> & { type?: unknown };
    const type = typeof item.type === 'string' && NODE_TYPES.has(item.type) ? item.type : 'llm';
    const id = typeof item.id === 'string' && item.id && !ids.has(item.id) ? item.id : `c-${i + 1}`;
    ids.add(id);
    nodes.push({
      id,
      type,
      label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : type,
      config: (item.config && typeof item.config === 'object' ? item.config : {}) as Record<string, unknown>,
    });
  });

  const edges: ComposerEdge[] = [];
  if (Array.isArray(obj.edges)) {
    for (const e of obj.edges) {
      const item = e as { source?: unknown; target?: unknown; sourceHandle?: unknown };
      if (typeof item.source !== 'string' || typeof item.target !== 'string') continue;
      if (!ids.has(item.source) || !ids.has(item.target) || item.source === item.target) continue;
      edges.push({
        source: item.source,
        target: item.target,
        sourceHandle: typeof item.sourceHandle === 'string' ? item.sourceHandle : undefined,
      });
    }
  }
  // 截断抢救后可能没有 edges（截在 edges 之前）：按节点顺序线性串联兜底，保证可运行
  if (edges.length === 0 && nodes.length >= 2) {
    for (let i = 0; i + 1 < nodes.length; i++) {
      edges.push({ source: nodes[i].id, target: nodes[i + 1].id });
    }
  }

  return {
    name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim().slice(0, 24) : 'AI 生成工作流',
    nodes,
    edges,
  };
}

interface ComposerNode {
  id: string;
  type: string;
  label: string;
  config: Record<string, unknown>;
}

interface ComposerEdge {
  source: string;
  target: string;
  sourceHandle?: string;
}

/** 上游 id → label 映射（供缺省 config 生成 {{label}} 引用） */
function upstreamLabels(nodes: ComposerNode[], edges: ComposerEdge[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const e of edges) {
    const target = nodes.find((n) => n.id === e.target);
    const source = nodes.find((n) => n.id === e.source);
    if (!target || !source) continue;
    map.set(target.id, [...(map.get(target.id) ?? []), source.label]);
  }
  return map;
}

/** 按 BFS 深度分层布局：x 随层深推进，层内纵向均布 */
function layout(nodes: ComposerNode[], edges: ComposerEdge[]): Map<string, { x: number; y: number }> {
  const depth = new Map<string, number>();
  const upstreams = upstreamLabels(nodes, edges);
  const queue = nodes.filter((n) => !(upstreams.get(n.id)?.length ?? 0));
  for (const n of queue) depth.set(n.id, 0);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = depth.get(cur.id) ?? 0;
    for (const e of edges) {
      if (e.source !== cur.id) continue;
      const next = depth.get(e.target);
      if (next === undefined || next < d + 1) {
        depth.set(e.target, d + 1);
        const t = nodes.find((n) => n.id === e.target);
        if (t) queue.push(t);
      }
    }
  }
  // 未入队（成环兜底）：按顺序追加层深
  let fallbackDepth = Math.max(-1, ...depth.values()) + 1;
  for (const n of nodes) {
    if (!depth.has(n.id)) depth.set(n.id, fallbackDepth++);
  }

  const byLayer = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    byLayer.set(d, [...(byLayer.get(d) ?? []), n.id]);
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const [d, ids] of byLayer) {
    ids.forEach((id, i) => {
      pos.set(id, { x: 80 + d * 340, y: 120 + i * 240 });
    });
  }
  return pos;
}

/** 每类节点的 config 缺省值（LLM 给了就透传，缺了用 {{上游label}} 引用兜底） */
function defaultConfig(node: ComposerNode, upstream: string[]): Record<string, unknown> {
  const ref = upstream.length > 0 ? `{{${upstream[0]}}}` : '{{主题输入}}';
  const c = node.config;
  switch (node.type) {
    case 'input':
      return { text: typeof c.text === 'string' && c.text ? c.text : '在此输入主题…' };
    case 'file':
      return { files: Array.isArray(c.files) ? c.files : [] };
    case 'llm':
      return {
        provider: '',
        model: '',
        systemPrompt: typeof c.systemPrompt === 'string' ? c.systemPrompt : '',
        userPrompt: typeof c.userPrompt === 'string' && c.userPrompt ? c.userPrompt : ref,
        temperature: typeof c.temperature === 'number' ? c.temperature : 0.7,
      };
    case 'agent':
      return {
        provider: '',
        model: '',
        systemPrompt: typeof c.systemPrompt === 'string' ? c.systemPrompt : '',
        userPrompt: typeof c.userPrompt === 'string' && c.userPrompt ? c.userPrompt : ref,
        tools: Array.isArray(c.tools) ? c.tools.filter((t): t is string => typeof t === 'string') : [],
        maxIterations: typeof c.maxIterations === 'number' ? c.maxIterations : 6,
      };
    case 'template':
      return { template: typeof c.template === 'string' && c.template ? c.template : `${ref}` };
    case 'image':
      return {
        provider: '',
        model: '',
        prompt: typeof c.prompt === 'string' && c.prompt ? c.prompt : ref,
        size: typeof c.size === 'string' ? c.size : '1024x1024',
        count: typeof c.count === 'number' ? c.count : 2,
      };
    case 'retrieval':
      return {
        kbId: typeof c.kbId === 'string' ? c.kbId : '',
        query: typeof c.query === 'string' && c.query ? c.query : ref,
        topK: typeof c.topK === 'number' ? c.topK : 3,
      };
    case 'condition':
      return { keyword: typeof c.keyword === 'string' ? c.keyword : '', caseSensitive: false };
    case 'output':
      return {};
    default:
      return {};
  }
}

/** LLM 输出 → 可直接载入画布的 WorkflowTemplate（provider/model 留空，由 applyTemplate 回填默认） */
export function toWorkflowTemplate(parsed: {
  name: string;
  nodes: ComposerNode[];
  edges: ComposerEdge[];
}): WorkflowTemplate {
  const upstreams = upstreamLabels(parsed.nodes, parsed.edges);
  const pos = layout(parsed.nodes, parsed.edges);
  return {
    id: 'ai-composed',
    name: parsed.name,
    icon: IconSparkles,
    description: '由「一键创作」根据你的想法生成',
    scenario: '一键创作',
    workflow: {
      version: 1,
      name: parsed.name,
      nodes: parsed.nodes.map((n) => ({
        id: n.id,
        type: n.type as NodeType,
        position: pos.get(n.id) ?? { x: 80, y: 120 },
        data: {
          type: n.type as NodeType,
          label: n.label,
          config: defaultConfig(n, upstreams.get(n.id) ?? []),
        },
      })),
      edges: parsed.edges.map((e, i) => ({
        id: `ce-${i + 1}`,
        source: e.source,
        target: e.target,
        ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
      })),
    },
  };
}
