/**
 * 工作流执行器：按拓扑序调度节点（就绪即并发、分支并行）、变量插值、失败隔离与取消。
 * - 状态/产物通过 canvasStore.updateNodeData 写回，NodeShell 自动呈现
 * - 边动画通过 canvasStore.setEdgeAnimated 控制运行中的"流动"视觉
 * - 前置校验失败只 toast，不改任何节点状态
 * 取消：signal 贯穿每个节点执行；中止后未完成节点置 idle，静默退出。
 */
import type {
  AgentStep,
  ChatMessage,
  ChatRequest,
  NodeData,
  NodeOutput,
  NodeRunStatus,
  SSEToolCall,
  ToolSchema,
} from '@shared/types';
import { executeTool as callTool, fetchNodeFileRaw, fetchNodeFileText, generateImage, listTools, searchKB, streamChat } from '../api/gateway';
import {
  readAgentConfig,
  readConditionConfig,
  readImageConfig,
  readInputConfig,
  readLLMConfig,
  readRetrievalConfig,
  readTemplateConfig,
  readFileConfig,
} from '../nodes/nodeConfigs';
import { useCanvasStore, type CanvasEdge, type CanvasNode } from '../store/canvasStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { collectOutput, evaluateCondition, interpolate, topoSort, upstreamMap } from './graph';

/** 轻提示（执行器内多处使用） */
const toast = (message: string): void => useUiStore.getState().showToast(message);

/* =============== 类型 =============== */

/** 节点在本次运行中的调度状态（store 中只落 waiting/running/终态） */
type SchedState = 'pending' | 'ready' | 'running' | 'success' | 'error' | 'blocked' | 'skipped';

/** 单个节点执行结果 */
interface ExecResult {
  status: 'success' | 'error' | 'blocked' | 'cancelled';
  output?: NodeOutput;
  /** status=error 时的错误说明（写入 node.data.error 展示） */
  error?: string;
}

/** 单节点执行依赖：取消信号、变量解析、状态写回、缺失变量提示、上游文本（提示词回退用） */
interface ExecContext {
  signal: AbortSignal;
  resolveVar: (name: string) => string | undefined;
  updateNode: (id: string, patch: Partial<NodeData>) => void;
  warnMissing: (label: string, missing: string[]) => void;
  /** 直接上游产物文本（按边顺序拼接，去除空白段）；LLM/Agent 未填提示词时回退为提问 */
  upstreamText: () => string;
  /** 上游（祖先）产物中的图片（dataURL / http URL，去重限量）；LLM/Agent 视觉输入 */
  collectImages: () => string[];
}

/** 单次请求最多携带的图片数与单图 dataURL 字符上限（防止请求体过大） */
const MAX_VISION_IMAGES = 6;
const MAX_IMAGE_DATA_CHARS = 6_000_000;

/** 全图视图（含未参与节点）：条件/输出节点的产物汇总与变量解析需要 */
interface GraphView {
  nodeById: Map<string, CanvasNode>;
  directParents: Map<string, string[]>;
  ancestorsOf: (id: string) => Set<string>;
  /** 全图拓扑序位置（聚合输出排序用） */
  baseIndex: Map<string, number>;
  /** 节点当前有效产物：运行期优先，其次未参与节点的旧产物 */
  getOutput: (id: string) => NodeOutput | undefined;
}

export interface RunSummary {
  cancelled: boolean;
  success: number;
  failed: number;
  blocked: number;
  skipped: number;
}

export type RunLifecycleEvent =
  | { type: 'node-start'; nodeId: string }
  | { type: 'node-finish'; nodeId: string; status: NodeRunStatus }
  | { type: 'end'; summary: RunSummary };

export interface RunOptions {
  mode: 'all' | 'from';
  /** mode=from 时的起点节点 id（含其下游参与执行，上游复用已有产物） */
  fromNodeId?: string;
  signal: AbortSignal;
  onEvent?: (event: RunLifecycleEvent) => void;
}

const EMPTY_SUMMARY: RunSummary = { cancelled: false, success: 0, failed: 0, blocked: 0, skipped: 0 };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/* =============== 入口 =============== */

/**
 * 执行工作流。流程：校验 → 初始化状态 → 拓扑调度（就绪并发） → 收尾统计。
 * nodes/edges 为调用瞬间的快照；运行中途的画布编辑不影响本次执行。
 */
export async function runWorkflow(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  opts: RunOptions
): Promise<RunSummary> {
  const { mode, signal } = opts;
  const updateNode = (id: string, patch: Partial<NodeData>): void =>
    useCanvasStore.getState().updateNodeData(id, patch);
  const setEdgeAnimated = (edgeId: string, animated: boolean): void =>
    useCanvasStore.getState().setEdgeAnimated(edgeId, animated);
  const markEdgeSkipped = (edgeId: string): void =>
    useCanvasStore.getState().setEdgeBranchSkipped(edgeId, true);

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  if (nodes.length === 0) {
    toast('画布为空，无可执行的工作流');
    return { ...EMPTY_SUMMARY };
  }

  /* ---- 参与节点集合：mode=all 全部；mode=from 起点及其全部下游 ---- */
  let participating: Set<string>;
  if (mode === 'from') {
    if (!opts.fromNodeId || !nodeById.has(opts.fromNodeId)) {
      toast('未找到目标节点，无法运行');
      return { ...EMPTY_SUMMARY };
    }
    participating = new Set<string>([opts.fromNodeId]);
    const queue = [opts.fromNodeId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of edges) {
        if (edge.source !== current || participating.has(edge.target) || !nodeById.has(edge.target)) continue;
        participating.add(edge.target);
        queue.push(edge.target);
      }
    }
  } else {
    participating = new Set(nodes.map((n) => n.id));
  }

  const subNodes = nodes.filter((n) => participating.has(n.id));
  const subEdges = edges.filter((e) => participating.has(e.source) && participating.has(e.target));

  /* ---- 前置校验（失败逐条提示并中止，不改节点状态） ---- */
  const topo = topoSort(subNodes, subEdges);
  if (topo.error === 'cycle') {
    toast('无法执行：工作流存在环');
    return { ...EMPTY_SUMMARY };
  }

  const providers = useSettingsStore.getState().providers;
  const validationErrors: string[] = [];
  const validationWarnings: string[] = [];

  const checkProvider = (providerId: string, label: string): void => {
    if (providerId === 'mock') return;
    const info = providers.find((p) => p.id === providerId);
    if (info && !info.available) {
      validationErrors.push(`「${label}」服务商「${info.name}」未配置密钥`);
    }
  };

  for (const node of subNodes) {
    const { type, label, config } = node.data;
    if (type === 'llm' || type === 'agent') {
      const c = type === 'llm' ? readLLMConfig(config) : readAgentConfig(config);
      if (!c.provider) validationErrors.push(`「${label}」未选择服务商`);
      else checkProvider(c.provider, label);
      if (!c.model) validationErrors.push(`「${label}」未选择模型`);
      // 提示词为空不在此拦截：运行期会自动回退为上游内容，仍为空才阻塞并给出指引
    } else if (type === 'image') {
      const c = readImageConfig(config);
      if (!c.provider) validationErrors.push(`「${label}」未选择服务商`);
      else checkProvider(c.provider, label);
      if (!c.model) validationErrors.push(`「${label}」未选择模型`);
      if (!c.prompt.trim()) validationErrors.push(`「${label}」未填写图像提示词`);
    } else if (type === 'input') {
      if (!readInputConfig(config).text.trim()) {
        validationWarnings.push(`「${label}」输入文本为空，将按空文本执行`);
      }
    }
  }
  for (const warning of validationWarnings) toast(warning);
  if (validationErrors.length > 0) {
    toast(validationErrors.join('；'));
    return { ...EMPTY_SUMMARY };
  }

  /* ---- 全图辅助结构（变量解析 / output 节点聚合用，含未参与节点） ---- */
  const directParents = upstreamMap(nodes, edges);
  const fullTopo = topoSort(nodes, edges);
  const baseOrder = fullTopo.error === 'cycle' ? nodes.map((n) => n.id) : fullTopo.order;
  const baseIndex = new Map(baseOrder.map((id, i) => [id, i] as const));

  const ancestorsCache = new Map<string, Set<string>>();
  const ancestorsOf = (id: string): Set<string> => {
    const cached = ancestorsCache.get(id);
    if (cached) return cached;
    const result = new Set<string>();
    const stack = [...(directParents.get(id) ?? [])];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (result.has(current)) continue;
      result.add(current);
      for (const parent of directParents.get(current) ?? []) {
        if (!result.has(parent)) stack.push(parent);
      }
    }
    ancestorsCache.set(id, result);
    return result;
  };

  /* ---- 初始化：参与节点全部置 waiting 并清空上一轮产物/错误；清除上一轮的分支未触发边标记 ---- */
  useCanvasStore.getState().clearBranchSkipped();
  for (const id of participating) {
    updateNode(id, { status: 'waiting', error: undefined, output: undefined });
  }

  /* ---- 运行期产物与完成顺序 ----
   * 变量解析优先读运行期产物；未参与节点（mode=from 时的上游）读快照旧产物。
   * 完成顺序：旧产物按全图拓扑序位（更早），本轮完成按计数器递增。 */
  const runtimeOutput = new Map<string, NodeOutput>();
  const completedSeq = new Map<string, number>();
  for (const node of nodes) {
    if (participating.has(node.id)) continue;
    const out = node.data.output;
    if (out && (out.text !== undefined || (out.images && out.images.length > 0))) {
      completedSeq.set(node.id, baseIndex.get(node.id) ?? 0);
    }
  }
  let completionCounter = nodes.length + 1;

  const getOutput = (id: string): NodeOutput | undefined => {
    const runtime = runtimeOutput.get(id);
    if (runtime) return runtime;
    if (participating.has(id)) return undefined; // 本轮已重置，快照旧产物作废
    return nodeById.get(id)?.data.output;
  };

  const graphView: GraphView = { nodeById, directParents, ancestorsOf, baseIndex, getOutput };

  /** 按 label 解析变量：限定当前节点的祖先集合，同名取最先完成者，只读已完成产物 */
  const resolveVar = (nodeId: string, name: string): string | undefined => {
    let bestSeq = Number.POSITIVE_INFINITY;
    let bestText: string | undefined;
    for (const ancId of ancestorsOf(nodeId)) {
      if (nodeById.get(ancId)?.data.label !== name) continue;
      const seq = completedSeq.get(ancId);
      if (seq === undefined) continue;
      const out = getOutput(ancId);
      if (!out || typeof out.text !== 'string') continue;
      if (seq < bestSeq) {
        bestSeq = seq;
        bestText = out.text;
      }
    }
    return bestText;
  };

  const warnMissing = (label: string, missing: string[]): void => {
    if (missing.length === 0) return;
    toast(`「${label}」未找到变量来源：${missing.join('、')}（已留空继续）`);
  };

  /* ---- 调度结构（只覆盖参与子图） ---- */
  const childEdges = new Map<string, CanvasEdge[]>();
  const incomingEdges = new Map<string, CanvasEdge[]>();
  const indegree = new Map<string, number>();
  for (const id of participating) indegree.set(id, 0);
  for (const edge of subEdges) {
    if (!childEdges.has(edge.source)) childEdges.set(edge.source, []);
    childEdges.get(edge.source)!.push(edge);
    if (!incomingEdges.has(edge.target)) incomingEdges.set(edge.target, []);
    incomingEdges.get(edge.target)!.push(edge);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  const state = new Map<string, SchedState>();
  for (const id of participating) state.set(id, 'pending');
  const readyQueue: string[] = [];
  for (const id of topo.order) {
    if ((indegree.get(id) ?? 0) === 0) {
      state.set(id, 'ready');
      readyQueue.push(id);
    }
  }

  const summary: RunSummary = { cancelled: false, success: 0, failed: 0, blocked: 0, skipped: 0 };
  const runPromises = new Set<Promise<void>>();
  let runningCount = 0;

  /** 上游成功送达：入度归零且仍未终态时进入就绪队列 */
  const deliver = (targetId: string): void => {
    if (state.get(targetId) !== 'pending') return;
    const rest = (indegree.get(targetId) ?? 1) - 1;
    indegree.set(targetId, rest);
    if (rest <= 0) {
      state.set(targetId, 'ready');
      readyQueue.push(targetId);
    }
  };

  /** 各节点已「死」的入边数（分支跳过或上游失败，用于多父节点的废弃判定） */
  const skippedIn = new Map<string, number>();

  /**
   * 沿一条「死」边级联（逐边推进，替代旧的整子树废弃）：
   * - mark=true 时给边打「分支未触发」标记（FlowEdge 渲染警戒纹 + 标签），
   *   上游失败级联不打该标记（失败不是分支选择）；
   * - 目标是 output：聚合器豁免，仅递减入度，等其余分支聚合；
   * - 目标已在运行 / 已终态：不动；
   * - 目标仍有活跃上游（死入边数 < 总入边数）：按送达处理，保持 pending，
   *   让健康分支照常驱动它——「命中分支 + 跳过分支」同时汇入的节点（如图片）不被误伤；
   * - 全部上游都是死边：整支废弃，置 skipped 并沿其出边继续级联。
   */
  const cascadeDead = (edge: CanvasEdge, mark: boolean): void => {
    if (mark) markEdgeSkipped(edge.id);
    const target = edge.target;
    if (nodeById.get(target)?.data.type === 'output') {
      deliver(target);
      return;
    }
    if (state.get(target) !== 'pending') return; // 已就绪 / 运行 / 已终态：不受影响
    const total = (incomingEdges.get(target) ?? []).length;
    const dead = (skippedIn.get(target) ?? 0) + 1;
    skippedIn.set(target, dead);
    if (dead < total) {
      deliver(target);
      return;
    }
    state.set(target, 'skipped');
    summary.skipped += 1;
    updateNode(target, { status: 'skipped', error: undefined, output: undefined });
    for (const child of childEdges.get(target) ?? []) cascadeDead(child, mark);
  };

  /* ---- 单节点执行：状态写回 + 统计 + 下游解析 ---- */
  const runOne = async (id: string): Promise<void> => {
    const node = nodeById.get(id)!;
    for (const edge of incomingEdges.get(id) ?? []) setEdgeAnimated(edge.id, true);
    opts.onEvent?.({ type: 'node-start', nodeId: id });

    const ctx: ExecContext = {
      signal,
      resolveVar: (name) => resolveVar(id, name),
      updateNode,
      warnMissing,
      upstreamText: () => {
        const parts: string[] = [];
        for (const parentId of directParents.get(id) ?? []) {
          const out = graphView.getOutput(parentId);
          if (!out) continue;
          const text = collectOutput(out).text;
          if (text.trim()) parts.push(text);
        }
        return parts.join('\n');
      },
      collectImages: () => {
        const urls: string[] = [];
        const ancIds = [...graphView.ancestorsOf(id)];
        for (const ancId of ancIds) {
          const out = graphView.getOutput(ancId);
          for (const url of out?.images ?? []) {
            if (
              typeof url === 'string' &&
              (url.startsWith('data:image/') || url.startsWith('http://') || url.startsWith('https://')) &&
              !urls.includes(url) &&
              url.length <= MAX_IMAGE_DATA_CHARS
            ) {
              urls.push(url);
            }
          }
        }
        return urls.slice(0, MAX_VISION_IMAGES);
      },
    };
    const result = await execNode(node, ctx, graphView).catch((err: unknown): ExecResult => {
      if (signal.aborted || isAbortError(err)) return { status: 'cancelled' };
      return { status: 'error', error: errorMessage(err) };
    });

    for (const edge of incomingEdges.get(id) ?? []) setEdgeAnimated(edge.id, false);

    if (result.status === 'cancelled') {
      // 静默取消：本节点回到 idle；下游保持 pending，由收尾统一置 idle
      state.set(id, 'pending');
      updateNode(id, { status: 'idle', error: undefined });
      return;
    }

    updateNode(id, {
      status: result.status,
      output: result.output,
      error: result.status === 'error' ? result.error : undefined,
    });
    if (result.output) runtimeOutput.set(id, result.output);
    opts.onEvent?.({ type: 'node-finish', nodeId: id, status: result.status });

    if (result.status === 'success') {
      completedSeq.set(id, completionCounter);
      completionCounter += 1;
      summary.success += 1;
      if (node.data.type === 'condition') {
        const branch = result.output?.branch ?? 'true';
        for (const edge of childEdges.get(id) ?? []) {
          // 无 sourceHandle 的出边视为始终放行；不匹配侧沿边级联跳过，
          // 沿途边打"分支未触发"标记（FlowEdge 渲染警戒纹 + 标签），
          // 命中分支汇入的下游节点不会被误伤
          if (!edge.sourceHandle || edge.sourceHandle === branch) deliver(edge.target);
          else cascadeDead(edge, true);
        }
      } else {
        for (const edge of childEdges.get(id) ?? []) deliver(edge.target);
      }
    } else {
      if (result.status === 'error') summary.failed += 1;
      else summary.blocked += 1;
      // 失败隔离：error/blocked 的全部直接下游沿边级联 skipped（不打分支标记），
      // 其他分支不受影响。多父节点若另有健康分支汇入则照常调度。
      // output 聚合节点豁免：只要有一个分支成功就应汇总部分结果，
      // 聚合时空产物会被自然跳过（见 execNode case 'output'）
      for (const edge of childEdges.get(id) ?? []) {
        cascadeDead(edge, false);
      }
    }
  };

  /* ---- 主循环：每批取全部就绪节点并发执行（Promise.allSettled 语义） ---- */
  for (;;) {
    if (signal.aborted) break;
    const batch = readyQueue.splice(0).filter((id) => state.get(id) === 'ready');
    if (batch.length === 0 && runningCount === 0) break;
    for (const id of batch) {
      state.set(id, 'running');
      // 节点数据同步置 running：NodeShell 由此点亮"运行中"呼吸灯/描边、
      // 图像节点占位区播骨架屏（此前只写内部调度状态，节点视觉永远停在 waiting）
      updateNode(id, { status: 'running' });
      runningCount += 1;
      const promise = runOne(id)
        .catch(() => undefined) // runOne 内部已兜底，防御意外异常中断整个调度
        .finally(() => {
          runningCount -= 1;
          runPromises.delete(promise);
        });
      runPromises.add(promise);
    }
    if (runPromises.size > 0) await Promise.allSettled([...runPromises]);
  }
  if (runPromises.size > 0) await Promise.allSettled([...runPromises]);

  /* ---- 收尾：复位边动画；取消时未完成节点置 idle ---- */
  useCanvasStore.getState().resetEdgeAnimation();
  // 取消运行：清除本轮"分支未触发"边标记，回到无标记状态
  if (signal.aborted) useCanvasStore.getState().clearBranchSkipped();
  if (signal.aborted) {
    summary.cancelled = true;
    for (const id of participating) {
      const st = state.get(id);
      if (st === 'pending' || st === 'ready' || st === 'running') {
        updateNode(id, { status: 'idle', error: undefined });
      }
    }
    toast('运行已取消');
  } else {
    toast(`运行完成：成功 ${summary.success} / 失败 ${summary.failed} / 拦截 ${summary.blocked}`);
  }
  opts.onEvent?.({ type: 'end', summary });
  return summary;
}

/* =============== 单节点执行语义 =============== */

async function execNode(node: CanvasNode, ctx: ExecContext, graph: GraphView): Promise<ExecResult> {
  switch (node.data.type) {
    case 'input':
      return { status: 'success', output: { text: readInputConfig(node.data.config).text } };

    case 'file':
      return runFileNode(node, ctx);

    case 'template': {
      const config = readTemplateConfig(node.data.config);
      const { text, missing } = interpolate(config.template, ctx.resolveVar);
      ctx.warnMissing(node.data.label, missing);
      return { status: 'success', output: { text } };
    }

    case 'llm':
      return runLLMNode(node, ctx);

    case 'agent':
      return runAgentNode(node, ctx);

    case 'image':
      return runImageNode(node, ctx);

    case 'retrieval':
      return runRetrievalNode(node, ctx, graph);

    case 'condition': {
      const config = readConditionConfig(node.data.config);
      // 上游文本摘要：直接上游 output.text 按边顺序拼接
      const parts: string[] = [];
      for (const parentId of graph.directParents.get(node.id) ?? []) {
        const text = collectOutput(graph.getOutput(parentId)).text;
        if (text.trim()) parts.push(text);
      }
      const upstreamText = parts.join('\n');
      const branch = evaluateCondition(config.keyword, config.caseSensitive, upstreamText);
      return { status: 'success', output: { text: upstreamText, branch } };
    }

    case 'output': {
      // 汇总全部祖先产物：文本按拓扑顺序拼接（带来源标题），图片全量聚合
      const ancestorIds = [...graph.ancestorsOf(node.id)].sort(
        (a, b) => (graph.baseIndex.get(a) ?? 0) - (graph.baseIndex.get(b) ?? 0)
      );
      const texts: string[] = [];
      const images: string[] = [];
      for (const ancId of ancestorIds) {
        const out = graph.getOutput(ancId);
        if (!out) continue;
        const { text, images: ancImages } = collectOutput(out);
        if (text.trim()) texts.push(`【${graph.nodeById.get(ancId)?.data.label ?? ancId}】\n${text}`);
        images.push(...ancImages);
      }
      if (texts.length === 0 && images.length === 0) return { status: 'success' };
      return { status: 'success', output: { text: texts.join('\n\n'), images } };
    }
  }
}

/** LLM 节点：流式累积 + 50ms 节流写回；blocked/error 事件转为对应终态 */
async function runLLMNode(node: CanvasNode, ctx: ExecContext): Promise<ExecResult> {
  const config = readLLMConfig(node.data.config);
  const { text: userText, missing } = interpolate(config.userPrompt, ctx.resolveVar);
  ctx.warnMissing(node.data.label, missing);

  // 未填写提示词时的回退：直接把上游产物文本作为提问（最常见的「输入→LLM→输出」
  // 链路无需手写模板即可跑通）；仍为空则阻塞并给出操作指引，避免拿空提示词问出废答案
  let promptText = userText;
  if (!promptText.trim()) {
    promptText = ctx.upstreamText();
    if (promptText.trim()) {
      toast(`「${node.data.label}」未填写提示词，已将上游内容直接作为提问`);
    } else {
      return {
        status: 'blocked',
        error: '未填写用户提示词，且没有上游内容可作提问；请在右侧配置面板填写并用「+ 插入 {{变量}}」引用上游',
      };
    }
  }

  const upstreamImages = ctx.collectImages();
  const request: ChatRequest = {
    provider: config.provider,
    model: config.model,
    messages: [
      { role: 'system', content: config.systemPrompt },
      { role: 'user', content: promptText },
    ],
    temperature: config.temperature,
    ...(upstreamImages.length > 0 ? { images: upstreamImages } : {}),
  };

  let acc = '';
  let blockedReason: string | null = null;
  let errorMsg: string | null = null;
  let lastFlush = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flushNow = (): void => {
    timer = null;
    lastFlush = Date.now();
    ctx.updateNode(node.id, { output: { text: acc } });
  };
  const scheduleFlush = (): void => {
    if (timer !== null) return;
    timer = setTimeout(flushNow, Math.max(0, 50 - (Date.now() - lastFlush)));
  };

  await streamChat(
    request,
    {
      onEvent: (event) => {
        if (event.type === 'delta') {
          acc += event.text;
          scheduleFlush();
        } else if (event.type === 'blocked') {
          blockedReason = event.reason;
        } else if (event.type === 'error') {
          errorMsg = event.message;
        }
      },
    },
    ctx.signal
  );
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }

  if (ctx.signal.aborted) return { status: 'cancelled' };
  if (errorMsg) {
    return { status: 'error', error: errorMsg, output: acc ? { text: acc } : undefined };
  }
  if (blockedReason !== null) {
    const text = acc ? `${acc}\n\n[已拦截] ${blockedReason}` : `[已拦截] ${blockedReason}`;
    return { status: 'blocked', output: { text } };
  }
  flushNow();
  return { status: 'success', output: { text: acc } };
}

/** 按字符数截断（不截断代理对），超长补省略号 */
function clipChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/**
 * Agent 节点：多轮 function calling 循环。
 * 每轮 streamChat（带 tools）→ 收到 tool_calls 则记录时间线、逐个执行服务端工具、
 * 把 assistant(tool_calls)+tool 消息回填后进入下一轮；finishReason=stop 时成功收尾。
 * steps 时间线实时写回 output.steps（思考/调用/结果/回答），文本走 50ms 节流。
 */
async function runAgentNode(node: CanvasNode, ctx: ExecContext): Promise<ExecResult> {
  const config = readAgentConfig(node.data.config);
  const { text: userText, missing } = interpolate(config.userPrompt, ctx.resolveVar);
  ctx.warnMissing(node.data.label, missing);

  // 与 LLM 节点同款回退：未填提示词时把上游产物文本作为任务；仍为空则阻塞
  let promptText = userText;
  if (!promptText.trim()) {
    promptText = ctx.upstreamText();
    if (promptText.trim()) {
      toast(`「${node.data.label}」未填写提示词，已将上游内容直接作为任务`);
    } else {
      return {
        status: 'blocked',
        error: '未填写任务提示词，且没有上游内容可作任务；请在右侧配置面板填写并用「+ 插入 {{变量}}」引用上游',
      };
    }
  }

  /* 上游图片（视觉输入）：整个工具循环各轮共用同一份 */
  const agentImages = ctx.collectImages();

  /* ---- 工具集：以服务端注册表为唯一来源，按配置勾选的名称过滤 ---- */
  let tools: ToolSchema[] = [];
  if (config.tools.length > 0) {
    try {
      const registry = await listTools(ctx.signal);
      if (ctx.signal.aborted) return { status: 'cancelled' };
      const selected = new Set(config.tools);
      tools = registry.filter((tool) => selected.has(tool.name));
    } catch (err) {
      if (ctx.signal.aborted || isAbortError(err)) return { status: 'cancelled' };
      return { status: 'error', error: `获取工具列表失败：${errorMessage(err)}` };
    }
  }

  // ReAct 执行规范：把选中工具的语义摘要注入 system——模型仅靠 JSON Schema 往往掌握不好
  // 「什么时候该调用、返回什么、何时停止」；落地避坑：工具描述要在提示词里写清用途与时机
  const toolDigest =
    tools.length > 0
      ? [
          '',
          '',
          '可用工具（仅按 JSON Schema 传参）：',
          ...tools.map((t) => `- ${t.name}：${t.description}`),
          '执行规范（ReAct：思考 → 行动 → 观察 → 再思考）：',
          `1. 每轮先用一句话说明思考，再决定调用工具还是给出最终回答；`,
          `2. 需要外部信息 / 计算 / 检索时才调用工具，依据返回结果继续推理；`,
          `3. 信息足够后立即停止调用工具，输出最终回答；`,
          `4. 严禁编造工具未返回的数据；工具执行失败时说明原因或改用其他方案，不要假装成功；`,
          `5. 全程最多 ${config.maxIterations} 轮，务必在轮次耗尽前收敛。`,
        ].join('\n')
      : '';
  const messages: ChatMessage[] = [
    { role: 'system', content: `${config.systemPrompt.trim() || '你是一个严谨的智能助手。'}${toolDigest}` },
    { role: 'user', content: promptText },
  ];

  const steps: AgentStep[] = [];
  let currentText: string | undefined; // 当前展示文本（每轮 delta 重置）
  let blockedReason: string | null = null;
  let errorMsg: string | null = null;
  let lastFlush = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flushNow = (): void => {
    timer = null;
    lastFlush = Date.now();
    ctx.updateNode(node.id, { output: { text: currentText, steps: [...steps] } });
  };
  /** 时间线事件（思考/工具调用/结果）立即写回，让节点输出区实时生长 */
  const flushStepsNow = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    flushNow();
  };
  const scheduleFlush = (): void => {
    if (timer !== null) return;
    timer = setTimeout(flushNow, Math.max(0, 50 - (Date.now() - lastFlush)));
  };

  for (let round = 1; round <= config.maxIterations; round += 1) {
    if (ctx.signal.aborted) return { status: 'cancelled' };

    steps.push({ kind: 'thought', content: `第 ${round} 轮思考中…` });
    flushStepsNow();

    let roundAcc = '';
    let calls: SSEToolCall[] = [];
    let doneSeen = false;
    lastFlush = 0;
    timer = null;

    await streamChat(
      {
        provider: config.provider,
        model: config.model,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        ...(agentImages.length > 0 ? { images: agentImages } : {}),
      },
      {
        onEvent: (event) => {
          if (event.type === 'delta') {
            roundAcc += event.text;
            currentText = roundAcc;
            scheduleFlush();
          } else if (event.type === 'tool_calls') {
            calls = event.calls;
          } else if (event.type === 'blocked') {
            blockedReason = event.reason;
          } else if (event.type === 'error') {
            errorMsg = event.message;
          } else if (event.type === 'done') {
            doneSeen = true;
          }
        },
      },
      ctx.signal
    );
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }

    if (ctx.signal.aborted) return { status: 'cancelled' };
    if (errorMsg) {
      return { status: 'error', error: errorMsg, output: { text: currentText, steps: [...steps] } };
    }
    if (blockedReason !== null) {
      const text = currentText
        ? `${currentText}\n\n[已拦截] ${blockedReason}`
        : `[已拦截] ${blockedReason}`;
      return { status: 'blocked', output: { text, steps: [...steps] } };
    }
    currentText = roundAcc;
    flushStepsNow();

    /* ---- 本轮请求了工具：记录调用 → 逐个执行 → 回填消息进入下一轮 ---- */
    if (calls.length > 0) {
      messages.push({
        role: 'assistant',
        content: roundAcc,
        tool_calls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
      });
      for (const call of calls) {
        steps.push({
          kind: 'tool_call',
          tool: call.name,
          content: `${call.name}(${clipChars(call.arguments.trim() || '{}', 80)})`,
        });
        flushStepsNow();

        const result = await callTool(call.name, call.arguments, ctx.signal);
        if (ctx.signal.aborted) return { status: 'cancelled' };
        const content = result.ok ? (result.result ?? '') : `工具执行失败：${result.error ?? '未知错误'}`;
        steps.push({ kind: 'tool_result', tool: call.name, content: clipChars(content, 500) });
        flushStepsNow();
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
      continue;
    }

    /* ---- 无工具调用：done 即收尾（含 stop / length 等）；未 done 视为流意外中断 ---- */
    if (doneSeen) {
      steps.push({ kind: 'answer', content: clipChars(currentText ?? '', 500) });
      flushStepsNow();
      return { status: 'success', output: { text: currentText ?? '', steps: [...steps] } };
    }
    return {
      status: 'error',
      error: '对话流意外中断（未收到 done 事件）',
      output: { text: currentText, steps: [...steps] },
    };
  }

  // 防死循环兜底：明确轮次与排查建议；阶段性文本仍随 output 返回供用户排查
  return {
    status: 'error',
    error: `已达到最大迭代次数（${config.maxIterations} 轮）仍未收敛：可调大节点「最大迭代数」、精简任务，或检查工具是否持续失败`,
    output: { text: currentText, steps: [...steps] },
  };
}

/** 图像生成：插值 prompt → generateImage → output.images */
async function runImageNode(node: CanvasNode, ctx: ExecContext): Promise<ExecResult> {
  const config = readImageConfig(node.data.config);
  const { text: prompt, missing } = interpolate(config.prompt, ctx.resolveVar);
  ctx.warnMissing(node.data.label, missing);
  try {
    const images = await generateImage(
      { provider: config.provider, model: config.model, prompt, size: config.size, count: config.count },
      ctx.signal
    );
    if (ctx.signal.aborted) return { status: 'cancelled' };
    // 空结果必须显式失败：服务商限流/安全过滤可能返回 200 + 空数组，
    // 若静默按成功处理，节点会以"灰色占位"状态蒙混过关，用户无从排查
    if (images.length === 0) {
      return { status: 'error', error: '图像生成返回空结果（可能被服务商限流或安全过滤拦截）' };
    }
    return { status: 'success', output: { images } };
  } catch (err) {
    if (ctx.signal.aborted || isAbortError(err)) return { status: 'cancelled' };
    return { status: 'error', error: errorMessage(err) };
  }
}

/**
 * 知识检索节点：query = 配置查询语句插值（留空则用直接上游文本拼接）
 * → searchKB(kbId, query, topK) → output.fragments 与供下游 LLM 引用的 output.text。
 * 检索结果为空属正常成功（fragments 空 + text 提示语）；未选库 / 空查询 / 接口失败为 error。
 */
async function runRetrievalNode(node: CanvasNode, ctx: ExecContext, graph: GraphView): Promise<ExecResult> {
  const config = readRetrievalConfig(node.data.config);
  if (!config.kbId) {
    return { status: 'error', error: '未选择知识库：请在节点配置中选择，或先在工具栏创建知识库' };
  }

  let query: string;
  if (config.query.trim()) {
    const { text, missing } = interpolate(config.query, ctx.resolveVar);
    ctx.warnMissing(node.data.label, missing);
    query = text;
  } else {
    // 查询语句留空：使用直接上游 output.text 按边顺序拼接
    const parts: string[] = [];
    for (const parentId of graph.directParents.get(node.id) ?? []) {
      const text = collectOutput(graph.getOutput(parentId)).text;
      if (text.trim()) parts.push(text);
    }
    query = parts.join('\n');
  }
  if (!query.trim()) {
    return { status: 'error', error: '检索内容为空：请填写查询语句，或连接有输出的上游节点' };
  }

  try {
    const { fragments } = await searchKB(config.kbId, query, config.topK, ctx.signal);
    if (ctx.signal.aborted) return { status: 'cancelled' };
    const text =
      fragments.length === 0
        ? '（未检索到相关内容）'
        : fragments
            .map(
              (f, i) =>
                `[片段${i + 1}·来源${f.source}·得分${f.score.toFixed(2)}]\n${f.text.trim()}`
            )
            .join('\n\n');
    return { status: 'success', output: { fragments, text } };
  } catch (err) {
    if (ctx.signal.aborted || isAbortError(err)) return { status: 'cancelled' };
    return { status: 'error', error: `知识库检索失败：${errorMessage(err)}` };
  }
}

/** Blob → dataURL（图片节点输出用，ImageGrid / 下游聚合均按 dataURL 消费） */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('图片数据读取失败'));
    reader.readAsDataURL(blob);
  });
}

/** 图片扩展名 → MIME（与 server files.ts IMAGE_MIME_BY_EXT 口径一致） */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
};

/**
 * 上传图片文件 → dataURL，并强制 data:image/ 前缀。
 * 服务端 raw 接口若对图片返回 application/octet-stream（旧版本行为），
 * FileReader 会产出 data:application/octet-stream 前缀，视觉链路
 * （collectImages / 服务端 visionImages 均按 data:image/ 过滤）会静默丢弃，
 * 模型看不到图。按文件扩展名归一化 MIME 兜底。
 */
async function imageBlobToDataUrl(blob: Blob, name: string): Promise<string> {
  const dataUrl = await blobToDataUrl(blob);
  if (dataUrl.startsWith('data:image/')) return dataUrl;
  const dot = name.lastIndexOf('.');
  const mime = (dot >= 0 ? IMAGE_MIME_BY_EXT[name.slice(dot).toLowerCase()] : undefined) ?? 'image/png';
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return `data:${mime};base64,${base64}`;
}

/**
 * 文件上传节点：按 kind 读取服务端文件——文档拉取提取文本、图片拉取原图转 dataURL。
 * 单个文件失败（解析失败 / 读取失败）以 [提示] 行呈现不阻塞其余文件；
 * 全部失败或未上传文件才 error。输出 text + images 供下游 {{节点名}} 引用。
 */
async function runFileNode(node: CanvasNode, ctx: ExecContext): Promise<ExecResult> {
  const { files } = readFileConfig(node.data.config);
  if (files.length === 0) {
    return {
      status: 'error',
      error: '尚未上传文件：拖入或点击节点上传 PDF / Word / TXT / 图片',
    };
  }

  const texts: string[] = [];
  const images: string[] = [];
  const notes: string[] = [];
  for (const f of files) {
    if (f.kind === 'image') {
      try {
        const blob = await fetchNodeFileRaw(f.id, ctx.signal);
        if (ctx.signal.aborted) return { status: 'cancelled' };
        images.push(await imageBlobToDataUrl(blob, f.name));
        texts.push(`【图片：${f.name}】`);
      } catch (err) {
        if (ctx.signal.aborted || isAbortError(err)) return { status: 'cancelled' };
        notes.push(`图片 ${f.name} 读取失败：${errorMessage(err)}`);
      }
    } else {
      if (f.extract === 'failed') {
        notes.push(`文档 ${f.name} 解析失败：${f.extractError ?? '未能提取到文本'}`);
        continue;
      }
      try {
        const text = await fetchNodeFileText(f.id, ctx.signal);
        if (ctx.signal.aborted) return { status: 'cancelled' };
        texts.push(`【${f.name}】\n${text}`);
      } catch (err) {
        if (ctx.signal.aborted || isAbortError(err)) return { status: 'cancelled' };
        notes.push(`文档 ${f.name} 读取失败：${errorMessage(err)}`);
      }
    }
  }

  if (texts.length === 0 && images.length === 0) {
    return { status: 'error', error: notes.join('；') || '所有文件均无法读取' };
  }
  const text = notes.length > 0 ? [...texts, `[提示] ${notes.join('；')}`].join('\n\n') : texts.join('\n\n');
  return {
    status: 'success',
    output: { text, ...(images.length > 0 ? { images } : {}) },
  };
}
