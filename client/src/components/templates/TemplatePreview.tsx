/**
 * 模板画布投影：直接用真实的 React Flow 渲染模板工作流——真实节点组件（nodes）
 * + 真实连线（FlowEdge）+ 真实 fitView 算法（padding 0.2，与 CanvasPage 完全一致），
 * 因此卡片封面、全屏展开层与最终画布的取景构图天然一致，展开过渡淡出后
 * 露出的画布与投影像素级同构，观感无缝。
 * demo 模式（落地页 hero / 场景区）：按拓扑分层时序模拟一次完整运行并循环——
 * 节点 waiting→running→success 依次点亮，LLM/模板流式出字、Agent 步骤递进、
 * 检索片段渐次命中、条件节点分流（false 支路挂警戒斜纹）、图像节点骨架屏后出
 * 单色系 SVG 样张、输出节点聚合上游产物；连线在上游完成、下游运行中时流动。
 * 播完停留后整段时间轴倒放回卷（文本退格逐字删除、节点逆序熄灭），再循环。
 * 非演示实例（模板中心封面 / 全屏展开层）保持完全惰性：禁用一切交互仅作展示；
 * 容器尺寸变化时经 ResizeObserver 即时重新 fitView。
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { AgentStep, KBFragment, NodeOutput, NodeRunStatus } from '@shared/types';
import { nodeTypes } from '../../nodes';
import { edgeTypes, defaultEdgeOptions } from '../canvas/FlowEdge';
import type { CanvasEdge, CanvasNode, CanvasNodeData } from '../../store/canvasStore';
import { useUiStore } from '../../store/uiStore';
import type { WorkflowTemplate } from '../../templates';

/* ============================ 演示运行引擎 ============================ */

/** 演示节奏：推进间隔 / 层间间隔 / 播完停留 / 各类型节点运行时长 */
const DEMO_TICK_MS = 120;
const DEMO_LEVEL_GAP_MS = 320;
const DEMO_HOLD_MS = 2400;
const DEMO_DUR: Record<string, number> = {
  input: 700,
  llm: 2600,
  agent: 3400,
  template: 1300,
  retrieval: 1900,
  condition: 800,
  image: 3000,
  output: 1400,
};

/** 输出节点聚合文案里的「已交付 xx」按上游类型取名 */
const DELIVERED_LABEL: Record<string, string> = {
  llm: '文本结果',
  agent: '执行结论',
  template: '提示词',
  retrieval: '检索片段',
  condition: '分流判定',
  image: '图像',
};

/** 演示样张：单色系抽象场景 SVG data URI（模拟图像节点的生成产物） */
function mockImage(): string {
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='1152' height='864'>" +
    "<defs><radialGradient id='g' cx='50%' cy='40%' r='70%'>" +
    "<stop offset='0%' stop-color='#39404e'/>" +
    "<stop offset='55%' stop-color='#191d25'/>" +
    "<stop offset='100%' stop-color='#0a0c10'/>" +
    '</radialGradient></defs>' +
    "<rect width='1152' height='864' fill='url(#g)'/>" +
    "<circle cx='576' cy='340' r='150' fill='none' stroke='#8b93a3' stroke-opacity='0.5' stroke-width='2'/>" +
    "<circle cx='576' cy='340' r='88' fill='#c9ced9' fill-opacity='0.12'/>" +
    "<path d='M140 720 Q576 560 1012 720' stroke='#8b93a3' stroke-opacity='0.35' stroke-width='2' fill='none'/>" +
    "<circle cx='228' cy='210' r='3' fill='#c9ced9' fill-opacity='0.6'/>" +
    "<circle cx='942' cy='168' r='2.5' fill='#c9ced9' fill-opacity='0.5'/>" +
    '</svg>';
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * 节点的演示产物（进度 p∈[0,1] 控制流式露出量，done=完整产物）。
 * 图像 / 条件节点只在完成时给出结果；运行中靠 status 驱动骨架屏与状态灯。
 */
function demoOutput(node: CanvasNode, p: number, done: boolean): NodeOutput | undefined {
  const label = node.data.label;
  switch (node.data.type) {
    case 'llm': {
      const text = `${label}已完成生成：\n\n- 紧扣上游输入组织内容，结构完整；\n- 语言风格与场景设定一致；\n- 结果可直接交由下游引用。`;
      return { text: done ? text : text.slice(0, Math.max(1, Math.ceil(text.length * p))) };
    }
    case 'template': {
      const text = '已按模板生成提示词，并完成上游插值校验。';
      return { text: done ? text : text.slice(0, Math.max(1, Math.ceil(text.length * p))) };
    }
    case 'agent': {
      const steps: AgentStep[] = [
        { kind: 'thought', content: `拆解「${label}」目标，规划执行路径` },
        { kind: 'tool_call', tool: 'webSummary', content: '抓取相关网页并生成摘要' },
        { kind: 'tool_result', tool: 'webSummary', content: '获得 3 段关键信息' },
        { kind: 'answer', content: '已形成结构化结论' },
      ];
      const shown = done ? steps : steps.slice(0, Math.max(1, Math.floor(steps.length * p)));
      const output: NodeOutput = { steps: shown };
      if (done) output.text = `${label}已输出结论：要点清晰、依据充分，可交由下游引用。`;
      return output;
    }
    case 'retrieval': {
      const fragments: KBFragment[] = [
        { source: '知识库 · 工作流指南', score: 0.92, text: '节点按拓扑顺序执行，上游输出经模板插值流入下游。' },
        { source: '知识库 · 提示词规范', score: 0.87, text: '提示词建议明确角色、任务与输出格式三要素。' },
        { source: '知识库 · 图像生成', score: 0.81, text: '图像节点支持按比例占位与多图批量生成。' },
      ];
      return {
        fragments: done
          ? fragments
          : fragments.slice(0, Math.max(1, Math.floor(fragments.length * p))),
      };
    }
    case 'condition':
      return done ? { branch: 'true' } : undefined;
    case 'image':
      return done ? { images: [mockImage()] } : undefined;
    default:
      return undefined; // input 无产物；output 聚合由第二遍单独计算
  }
}

/** 时序槽位：所在层 + 起止时刻（ms，相对一次演示循环起点） */
interface DemoSlot {
  level: number;
  start: number;
  end: number;
}

/** 最长路径分层（模板为 DAG）：同层节点并行运行，层与层之间串行推进 */
function buildDemoSchedule(nodes: CanvasNode[], edges: CanvasEdge[]) {
  const levelById = new Map<string, number>();
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const outs = new Map<string, string[]>();
  for (const e of edges) {
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
    outs.set(e.source, [...(outs.get(e.source) ?? []), e.target]);
  }
  const queue = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    for (const target of outs.get(id) ?? []) {
      levelById.set(target, Math.max(levelById.get(target) ?? 0, (levelById.get(id) ?? 0) + 1));
      const left = (indegree.get(target) ?? 1) - 1;
      indegree.set(target, left);
      if (left === 0) queue.push(target);
    }
  }
  for (const n of nodes) if (!levelById.has(n.id)) levelById.set(n.id, 0);

  const levelStart = new Map<number, number>();
  let cursor = 0;
  for (const level of [...new Set(levelById.values())].sort((a, b) => a - b)) {
    levelStart.set(level, cursor);
    let dur = 0;
    for (const n of nodes) {
      if ((levelById.get(n.id) ?? 0) === level) dur = Math.max(dur, DEMO_DUR[n.data.type] ?? 1200);
    }
    cursor += dur + DEMO_LEVEL_GAP_MS;
  }

  const slots = new Map<string, DemoSlot>();
  for (const n of nodes) {
    const level = levelById.get(n.id) ?? 0;
    const start = levelStart.get(level) ?? 0;
    slots.set(n.id, { level, start, end: start + (DEMO_DUR[n.data.type] ?? 1200) });
  }
  return { slots, cycle: cursor + DEMO_HOLD_MS };
}

/**
 * 演示运行引擎：demo 开启时以固定间隔推进时序（基于墙钟取模，后台节流也不停摆），
 * 返回随时间演化的 nodes / edges；关闭时返回与原实现完全相同的静态数据。
 */
function useDemoRun(template: WorkflowTemplate, demo: boolean) {
  const staticNodes = useMemo<CanvasNode[]>(
    () =>
      template.workflow.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        position: node.position,
        data: node.data as CanvasNodeData,
      })),
    [template]
  );
  const [nodes, setNodes] = useState<CanvasNode[]>(staticNodes);
  const [edges, setEdges] = useState<CanvasEdge[]>(template.workflow.edges as CanvasEdge[]);
  /** 归零基准：不依赖 interval 触发时刻，页面节流后时序也能对齐 */
  const startRef = useRef(0);

  useEffect(() => {
    if (!demo) return;
    const base = staticNodes;
    const baseEdges: CanvasEdge[] = template.workflow.edges;
    const { slots, cycle } = buildDemoSchedule(base, baseEdges);
    // 输出节点的上游（聚合产物用）
    const incoming = new Map<string, string[]>();
    for (const e of baseEdges) {
      incoming.set(e.target, [...(incoming.get(e.target) ?? []), e.source]);
    }
    setNodes(base);
    startRef.current = Date.now();

    const timer = setInterval(() => {
      // 时间轴三段循环：正向运行 → 停留 → 逆放回卷（把正向时间轴倒放，
      // 状态/流式出字/流动连线全为时间的纯函数，倒放即得全部逆动画——
      // 文本按退格逐字删除、步骤与片段倒序消失、图像收回、连线逆向流动）
      const runMs = cycle - DEMO_HOLD_MS;
      const elapsed = (Date.now() - startRef.current) % (cycle + runMs);
      const t = elapsed < cycle ? elapsed : Math.max(0, runMs - (elapsed - cycle));
      const statusById = new Map<string, NodeRunStatus>();

      // 第一遍：各节点按时序推进 status 与流式产物
      const nextNodes = base.map((n) => {
        const slot = slots.get(n.id)!;
        const done = t >= slot.end;
        const status: NodeRunStatus = done
          ? 'success'
          : t >= slot.start
            ? 'running'
            : slot.level === 0
              ? 'idle'
              : 'waiting';
        statusById.set(n.id, status);
        const p = done ? 1 : Math.min(1, Math.max(0, (t - slot.start) / Math.max(1, slot.end - slot.start)));
        return { ...n, data: { ...n.data, status, output: demoOutput(n, p, done) } };
      });

      // 第二遍：输出节点聚合上游产物（运行中先流式文本，完成后附图像与片段）
      for (const n of nextNodes) {
        if (n.data.type !== 'output') continue;
        const slot = slots.get(n.id)!;
        const done = statusById.get(n.id) === 'success';
        const p = done ? 1 : Math.min(1, Math.max(0, (t - slot.start) / Math.max(1, slot.end - slot.start)));
        const ups = (incoming.get(n.id) ?? [])
          .map((id) => base.find((b) => b.id === id))
          .filter((n2): n2 is CanvasNode => Boolean(n2));
        const text = `### 本轮交付\n${ups
          .map((u) => `- ${u.data.label}：已交付${DELIVERED_LABEL[u.data.type] ?? '结果'}`)
          .join('\n')}`;
        n.data = {
          ...n.data,
          output: {
            text: done ? text : text.slice(0, Math.max(1, Math.ceil(text.length * p))),
            ...(done ? { images: ups.flatMap((u) => u.data.output?.images ?? []) } : {}),
            ...(done ? { fragments: ups.flatMap((u) => u.data.output?.fragments ?? []) } : {}),
          },
        };
      }
      setNodes(nextNodes);

      // 连线：上游完成且下游运行中 → 流动虚线；condition 完成 → false 支路挂警戒斜纹
      setEdges(
        baseEdges.map((e) => {
          const sourceStatus = statusById.get(e.source);
          const animated = sourceStatus === 'success' && statusById.get(e.target) === 'running';
          const branchSkipped = sourceStatus === 'success' && e.sourceHandle === 'false';
          const prevSkipped = Boolean((e.data as { branchSkipped?: boolean } | undefined)?.branchSkipped);
          if (Boolean(e.animated) === animated && prevSkipped === branchSkipped) return e;
          return { ...e, animated, data: { ...e.data, branchSkipped } };
        })
      );
    }, DEMO_TICK_MS);
    return () => clearInterval(timer);
  }, [demo, staticNodes, template.workflow.edges]);

  return demo
    ? { nodes, edges }
    : { nodes: staticNodes, edges: template.workflow.edges as CanvasEdge[] };
}

/* ============================== 投影画布 ============================== */

/**
 * 惰性预览画布：fitView 参数与 CanvasPage 对齐（padding 0.2、minZoom 放宽到
 * 0.05 以便小卡片容纳大画布、maxZoom 2 与画布一致），保证同一容器尺寸下
 * 两次 fitView 结果逐像素相同。容器尺寸变化时即时重适配，展开过渡中构图
 * 始终跟随容器收放。
 */
const PreviewFlow = memo(function PreviewFlow({
  template,
  demo,
}: {
  template: WorkflowTemplate;
  demo: boolean;
}) {
  const { fitView } = useReactFlow();
  const hostRef = useRef<HTMLDivElement>(null);
  const theme = useUiStore((s) => s.theme);
  const { nodes, edges } = useDemoRun(template, demo);

  /** 容器尺寸变化（卡片 → 全屏展开）即时重新 fitView，构图跟随收放 */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => void fitView({ padding: 0.2 }));
    observer.observe(host);
    return () => observer.disconnect();
  }, [fitView]);

  return (
    <div ref={hostRef} className="absolute inset-0">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.05}
        maxZoom={2}
        colorMode={theme}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
        panOnDrag={false}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
      />
    </div>
  );
});

export function TemplatePreview({
  template,
  demo = false,
}: {
  template: WorkflowTemplate;
  /** 演示模式：循环模拟一次完整运行（落地页 hero / 场景区使用） */
  demo?: boolean;
}) {
  return (
    <div className="template-preview absolute inset-0 overflow-hidden bg-base">
      {/* 画布同款 24px 点阵底（真实画布的点阵由 StarField 星点绘制，此处为等价近似） */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: 'radial-gradient(var(--border-base) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
      />
      <ReactFlowProvider>
        <PreviewFlow template={template} demo={demo} />
      </ReactFlowProvider>
    </div>
  );
}
