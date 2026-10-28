/**
 * 工作流图纯函数模块：拓扑排序、上游映射、模板插值、条件判定、产物规约。
 * 全部为无副作用纯函数（只依赖入参），便于单测（scripts/engine.test.ts）。
 * 执行器（executor.ts）在其上做调度；节点/连线以最小结构传入，不依赖 React Flow 类型。
 */
import type { NodeOutput } from '@shared/types';

/* =============== 图结构 =============== */

/** 图节点的最小结构 */
export interface TopoNode {
  id: string;
}

/** 图连线的最小结构 */
export interface TopoEdge {
  source: string;
  target: string;
}

export interface TopoResult {
  /** 拓扑序节点 id 列表（无环时覆盖全部节点；有环时只含已弹出部分） */
  order: string[];
  /** 存在环时为 'cycle' */
  error?: 'cycle';
}

/**
 * Kahn 算法拓扑排序。
 * - 忽略引用了不存在节点的悬挂边
 * - 返回 order 与节点数不一致（即有环）时 error='cycle'
 */
export function topoSort(nodes: readonly TopoNode[], edges: readonly TopoEdge[]): TopoResult {
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    indegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }
  for (const edge of edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue;
    adjacency.get(edge.source)!.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  const queue: string[] = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const rest = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, rest);
      if (rest === 0) queue.push(next);
    }
  }
  return order.length === nodes.length ? { order } : { order, error: 'cycle' };
}

/** 每个节点的直接上游 id 列表（按边顺序、去重；无上游为空数组） */
export function upstreamMap(nodes: readonly TopoNode[], edges: readonly TopoEdge[]): Map<string, string[]> {
  const ids = new Set(nodes.map((n) => n.id));
  const map = new Map<string, string[]>();
  for (const node of nodes) map.set(node.id, []);
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    const list = map.get(edge.target)!;
    if (!list.includes(edge.source)) list.push(edge.source);
  }
  return map;
}

/* =============== 模板插值 =============== */

/**
 * 占位符：{{名称}}，名称前后允许空白；花括号内不允许再嵌花括号，
 * 因此外层字面花括号（如 {{{name}}}）会被保留、只解析最内层占位符；
 * 替换结果不会被二次扫描（防止注入出新占位符）。
 */
const PLACEHOLDER_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export interface InterpolateResult {
  /** 替换后的文本；缺失变量替换为空字符串 */
  text: string;
  /** 解析不到值的变量名（去重，按首次出现顺序） */
  missing: string[];
}

/**
 * 模板插值：把 {{名称}} 用 resolve(名称) 的返回值替换。
 * resolve 返回 undefined 视为缺失（计入 missing，占位符替换为空串）；空字符串视为已提供。
 */
export function interpolate(
  template: string,
  resolve: (name: string) => string | undefined
): InterpolateResult {
  const missing: string[] = [];
  const text = template.replace(PLACEHOLDER_RE, (_raw, name: string) => {
    const value = resolve(name);
    if (value === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return '';
    }
    return value;
  });
  return { text, missing };
}

/* =============== 条件判定 =============== */

/**
 * 条件分支判定：text 中包含 keyword 判 true，否则 false。
 * keyword 为空（含纯空白）时默认 true（无条件放行 true 分支）。
 * caseSensitive=false 时按不区分大小写匹配。
 */
export function evaluateCondition(keyword: string, caseSensitive: boolean, text: string): 'true' | 'false' {
  const key = keyword.trim();
  if (!key) return 'true';
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? key : key.toLowerCase();
  return haystack.includes(needle) ? 'true' : 'false';
}

/* =============== 产物规约 =============== */

/** 把节点产物规约为文本与图片（文本取 output.text；图片取 output.images），缺失字段兜底为空 */
export function collectOutput(output: NodeOutput | undefined): { text: string; images: string[] } {
  const images = output?.images;
  return {
    text: typeof output?.text === 'string' ? output.text : '',
    images: Array.isArray(images) ? images.filter((item): item is string => typeof item === 'string') : [],
  };
}
