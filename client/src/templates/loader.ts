/**
 * 模板加载器（Task 8）：把预置模板实例化到当前画布。
 * - llm/agent/image 节点按能力（chat / image）与优先级从 settingsStore 回填 provider/model
 * - retrieval 节点回填 kbStore 中的第一个知识库 id（无库则留空，运行时检索节点会给出明确报错）
 * - 全部节点重置 idle 并清空历史产物；画布非空时先经全局确认弹窗；载入后 toast 反馈
 * - applyTemplateAnimated：AI 一键生成专用——按位置从左到右逐节点装配（入场动画 + 标题打字机），
 *   连线在两端节点就位后随之出现；中途切换画布自动中止
 */
import type { ModelKind, ProviderInfo, WorkflowJSON } from '@shared/types';
import { useCanvasStore, type CanvasNodeData, DEFAULT_WORKFLOW_NAME } from '../store/canvasStore';
import { useKBStore } from '../store/kbStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { useWorkspaceStore } from '../store/workspaceStore';
import type { WorkflowTemplate } from './index';

/** 对话类节点（llm / agent）的服务商回填优先级，末位 mock 兜底 */
const CHAT_PROVIDER_ORDER = ['deepseek', 'ark', 'zhipu', 'custom', 'mock'];

/** 图像节点（image）的服务商回填优先级，末位 mock 兜底 */
const IMAGE_PROVIDER_ORDER = ['ark', 'zhipu', 'mock'];

/** 逐节点装配步进间隔（ms）：节点从左到右依次点亮的节奏 */
const ENTER_STEP_MS = 280;

/**
 * 按「优先级顺序 → available → 含目标能力模型」选出第一个可用服务商，
 * model 取该服务商下第一个具备目标能力的模型 id；找不到返回空串（由运行时校验兜底提示）。
 */
function pickProviderModel(
  providers: ProviderInfo[],
  order: string[],
  kind: ModelKind
): { provider: string; model: string } {
  for (const preferred of order) {
    const provider = providers.find((p) => p.id === preferred);
    if (!provider || !provider.available) continue;
    const model = provider.models.find((m) => m.kind.includes(kind));
    if (model) return { provider: provider.id, model: model.id };
  }
  return { provider: '', model: '' };
}

/** 模板 → 可载入画布的 workflow：深拷贝 + 重置状态 + 回填 provider / model / kbId */
function prepareWorkflow(template: WorkflowTemplate): WorkflowJSON {
  // 深拷贝，避免修改模板常量数据
  const workflow = JSON.parse(JSON.stringify(template.workflow)) as typeof template.workflow;

  const providers = useSettingsStore.getState().providers;
  const firstKBId = useKBStore.getState().kbs[0]?.id ?? '';

  for (const node of workflow.nodes) {
    node.data.status = 'idle';
    delete node.data.error;
    delete node.data.output;

    const config = node.data.config;
    if (node.type === 'llm' || node.type === 'agent') {
      const picked = pickProviderModel(providers, CHAT_PROVIDER_ORDER, 'chat');
      config.provider = picked.provider;
      config.model = picked.model;
    } else if (node.type === 'image') {
      const picked = pickProviderModel(providers, IMAGE_PROVIDER_ORDER, 'image');
      config.provider = picked.provider;
      config.model = picked.model;
    } else if (node.type === 'retrieval' && !config.kbId) {
      config.kbId = firstKBId;
    }
  }
  return workflow;
}

/** 载入模板到画布：回填模型与知识库 → loadWorkflow → toast；返回是否真正载入 */
export async function applyTemplate(template: WorkflowTemplate): Promise<boolean> {
  const { showToast, showConfirm } = useUiStore.getState();
  const canvas = useCanvasStore.getState();

  // 画布已有内容时先经全局确认弹窗确认替换
  if (
    canvas.nodes.length > 0 &&
    !(await showConfirm({
      title: '载入模板',
      message: '载入模板将替换当前画布的全部节点与连线，确定继续？',
      confirmLabel: '替换画布',
      danger: true,
    }))
  ) {
    return false;
  }

  const workflow = prepareWorkflow(template);
  canvas.loadWorkflow(workflow);

  const missingModel = workflow.nodes.some(
    (n) => (n.type === 'llm' || n.type === 'agent' || n.type === 'image') && !n.data.config.provider
  );
  const notes: string[] = [];
  if (missingModel) notes.push('未匹配到可用模型服务商，请在节点配置中手动选择');
  if (hasEmptyKB(workflow)) notes.push('尚未创建知识库，请先在工具栏创建并重新载入');
  showToast(`已新建画布并载入模板：${template.name}${notes.length > 0 ? `（${notes.join('；')}）` : ''}`);
  return true;
}

/** 是否存在未选知识库的 retrieval 节点（提示语用） */
function hasEmptyKB(workflow: WorkflowJSON): boolean {
  return workflow.nodes.some((n) => n.type === 'retrieval' && !n.data.config.kbId);
}

/**
 * 模板中心专用：每次使用模板都新建一块画布来应用——
 * 当前画布先行落盘回清单，切到全新空画布后载入模板（空画布不会触发替换确认），
 * 并把清单条目改名为模板名（侧边栏即刻可见）；不触碰任何已有画布内容。
 */
export async function applyTemplateToNewCanvas(template: WorkflowTemplate): Promise<boolean> {
  const id = useWorkspaceStore.getState().createCanvas();
  const ok = await applyTemplate(template);
  if (ok) useWorkspaceStore.getState().renameCanvas(id, template.name);
  return ok;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 各类节点参与「打字写入」的正文 config 字段（装配时逐字写入，模拟打字机） */
const TYPEABLE_FIELDS: Record<string, string[]> = {
  input: ['text'],
  template: ['template'],
  llm: ['userPrompt'],
  agent: ['userPrompt'],
  image: ['prompt'],
  condition: ['keyword'],
  retrieval: ['query'],
};

/**
 * 动画式装配（AI 一键生成专用）：画布须为空（调用方先 createCanvas）。
 * 节点按位置从左到右（x 升序，同列按 y）逐个添加：登记入场标记 → addRawNode →
 * 等待入场动画结束（节点就位）→ 追加两端均已就位的连线 → onNodeSettled 回调
 * （调用方重测把手，避免入场动画期间测量错位导致连线不贴点）→ onProgress 回调
 * （调用方逐帧取景，保证动画始终可见）→ 下一节点；NodeShell 据入场标记播入场
 * 动画 + 标题打字机，随后正文按 TYPEABLE_FIELDS 逐字写入。
 * 中途用户切换画布立即中止（避免节点写入错误画布）；结束时回调 onDone（收尾 fitView / toast）。
 */
export async function applyTemplateAnimated(
  template: WorkflowTemplate,
  opts: {
    onDone?: () => void;
    /** 单个节点入场动画结束后回调（id）——调用方借此重测该节点把手位置 */
    onNodeSettled?: (id: string) => void;
    /** 每步装配后回调——调用方借此 fitView 保持动画始终在视野内 */
    onProgress?: () => void;
  } = {}
): Promise<boolean> {
  const canvas = useCanvasStore.getState();
  const workflow = prepareWorkflow(template);

  canvas.clearAll();
  canvas.setName(workflow.name || DEFAULT_WORKFLOW_NAME);
  // 提前登记全部入场标记：节点 addRawNode 挂载时 NodeShell 立即可读到标记并播动画
  canvas.beginNodeEnter(workflow.nodes.map((n) => n.id));

  const targetCanvasId = useWorkspaceStore.getState().activeId;
  // 从左到右：x 升序，同列自上而下
  const sorted = [...workflow.nodes].sort(
    (a, b) => a.position.x - b.position.x || a.position.y - b.position.y
  );
  const added = new Set<string>();
  const pendingEdges = workflow.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
  }));
  /** 装配中止检查：用户已切走画布（返回 true 表示需中止） */
  const aborted = () => useWorkspaceStore.getState().activeId !== targetCanvasId;

  for (let idx = 0; idx < sorted.length; idx++) {
    const node = sorted[idx];
    // 中途切换画布：hydrate 已替换节点数组，继续写入会污染目标画布，直接中止
    if (aborted()) return false;
    canvas.addRawNode({
      id: node.id,
      type: node.type,
      position: node.position,
      data: node.data as CanvasNodeData,
    });
    added.add(node.id);
    // 节点一出现就取景（跟随镜头先动），入场动画与取景动画并行更连贯
    opts.onProgress?.();
    // 等入场动画播完（节点就位），连线与把手重测都在「就位」后进行，
    // 避免动画中途测量导致连线端点不贴节点
    await sleep(ENTER_STEP_MS);
    if (aborted()) return false;
    opts.onNodeSettled?.(node.id);
    for (let i = pendingEdges.length - 1; i >= 0; i--) {
      const e = pendingEdges[i];
      if (added.has(e.source) && added.has(e.target)) {
        canvas.addRawEdge(e);
        pendingEdges.splice(i, 1);
      }
    }
    // 末节点不单独取景：随后 onDone 的收尾 fitView 负责最终取景，
    // 两次连续 fitView（不同时长）互相打断会产生一次明显的顿挫
    if (idx < sorted.length - 1) opts.onProgress?.();

    // 正文打字机：把 config 里的正文逐字写入节点（长内容自动加速，~0.9s 打完）
    const fields = TYPEABLE_FIELDS[node.type] ?? [];
    const rawConfig = (node.data as { config?: Record<string, unknown> }).config ?? {};
    const contents = fields.map((f) => (typeof rawConfig[f] === 'string' ? (rawConfig[f] as string) : ''));
    const total = Math.max(0, ...contents.map((c) => c.length));
    if (total > 0) {
      const charsPerTick = Math.max(1, Math.ceil(total / 110));
      for (let cut = charsPerTick; cut <= total + charsPerTick; cut += charsPerTick) {
        if (aborted()) return false;
        const end = Math.min(cut, total);
        const config = { ...rawConfig };
        fields.forEach((f, idx) => {
          config[f] = contents[idx].slice(0, end);
        });
        canvas.updateNodeData(node.id, { config });
        await sleep(8);
      }
    }
  }

  opts.onDone?.();
  return true;
}
