/**
 * 模板中心预置工作流模板数据（Task 8）。
 * - workflow 为完整可运行的 WorkflowJSON：config 的 prompt 类字段全部填好，
 *   llm/agent/image 的 provider/model 与 retrieval 的 kbId 留空字符串，
 *   由 loader.applyTemplate 在载入时按当前环境智能回填。
 * - 占位符 {{名称}} 按上游节点 label 解析（见 engine/graph.ts interpolate 与执行器 resolveVar），
 *   编写模板时须保证占位符名与上游节点 label 完全一致。
 * - 节点坐标按 80/400/720/1040/1360 从左到右分层，纵向留出分支行距。
 */
import type { WorkflowJSON } from '@shared/types';
import {
  IconBook,
  IconGraduationCap,
  IconMegaphone,
  IconFlask,
  IconImage,
  type IconComponent,
} from '../components/icons';

/** 模板中心卡片与加载器共用的模板元信息 */
export interface WorkflowTemplate {
  id: string;
  name: string;
  /** 卡片主图标（SVG 组件引用） */
  icon: IconComponent;
  description: string;
  /** 使用场景标签 */
  scenario: string;
  workflow: WorkflowJSON;
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  /* =============== 1. 绘本创作助手 =============== */
  {
    id: 'picture-book',
    name: '绘本创作助手',
    icon: IconBook,
    description:
      '输入一个主题，AI 先编写四幕分镜脚本，再把分镜文案组织成绘图指令，自动生成插画，产出图文并茂的绘本雏形。',
    scenario: '儿童教育 / 内容创作',
    workflow: {
      version: 1,
      name: '绘本创作助手',
      nodes: [
        {
          id: 'tb-topic',
          type: 'input',
          position: { x: 80, y: 160 },
          data: {
            type: 'input',
            label: '主题输入',
            config: { text: '比如：一只不会喷火的小龙，想学会和朋友一起玩' },
            status: 'idle',
          },
        },
        {
          id: 'tb-story',
          type: 'llm',
          position: { x: 400, y: 160 },
          data: {
            type: 'llm',
            label: '分镜文案',
            config: {
              provider: '',
              model: '',
              systemPrompt:
                '你是一位专业的儿童绘本分镜师。请根据主题创作一个 4 幕的小故事分镜脚本：每幕以「第X幕：<幕名>」开头，随后用一行文字描述该幕画面（包含角色、动作、场景与氛围）。只输出 4 幕分镜内容，不要输出其他解释。',
              userPrompt: '{{主题输入}}',
              temperature: 0.8,
            },
            status: 'idle',
          },
        },
        {
          id: 'tb-tpl',
          type: 'template',
          position: { x: 720, y: 160 },
          data: {
            type: 'template',
            label: '插画提示词',
            config: { template: '请为以下画面生成插画：\n{{分镜文案}}' },
            status: 'idle',
          },
        },
        {
          id: 'tb-img',
          type: 'image',
          position: { x: 1040, y: 160 },
          data: {
            type: 'image',
            label: '画面生成',
            config: {
              provider: '',
              model: '',
              prompt: '{{插画提示词}}',
              size: '1024x1024',
              count: 2,
            },
            status: 'idle',
          },
        },
        {
          id: 'tb-out',
          type: 'output',
          position: { x: 1360, y: 160 },
          data: { type: 'output', label: '绘本成果', config: {}, status: 'idle' },
        },
      ],
      edges: [
        { id: 'tb-e1', source: 'tb-topic', target: 'tb-story' },
        { id: 'tb-e2', source: 'tb-story', target: 'tb-tpl' },
        { id: 'tb-e3', source: 'tb-tpl', target: 'tb-img' },
        { id: 'tb-e4', source: 'tb-img', target: 'tb-out' },
      ],
    },
  },

  /* =============== 2. 课程知识问答 =============== */
  {
    id: 'kb-qa',
    name: '课程知识问答',
    icon: IconGraduationCap,
    description:
      '把问题先检索到知识库，再由讲师模型仅依据检索资料作答并标注来源；资料不足时明确说明，适合课程答疑与资料速查。',
    scenario: '知识库问答（需先创建知识库）',
    workflow: {
      version: 1,
      name: '课程知识问答',
      nodes: [
        {
          id: 'kq-question',
          type: 'input',
          position: { x: 80, y: 160 },
          data: {
            type: 'input',
            label: '问题输入',
            config: { text: '什么是检索增强生成（RAG）？' },
            status: 'idle',
          },
        },
        {
          id: 'kq-retrieval',
          type: 'retrieval',
          position: { x: 400, y: 160 },
          data: {
            type: 'retrieval',
            label: '知识检索',
            config: { kbId: '', query: '{{问题输入}}', topK: 3 },
            status: 'idle',
          },
        },
        {
          id: 'kq-llm',
          type: 'llm',
          position: { x: 720, y: 160 },
          data: {
            type: 'llm',
            label: '讲师解答',
            config: {
              provider: '',
              model: '',
              systemPrompt:
                '你是一位严谨的课程讲师。只依据用户提供的参考资料回答问题，禁止编造；引用资料时标注来源，格式如（来源：片段1·xxx）。若资料不足以回答，请明确说明「资料中未提及」。',
              userPrompt: '问题：{{问题输入}}\n\n参考资料：\n{{知识检索}}',
              temperature: 0.3,
            },
            status: 'idle',
          },
        },
        {
          id: 'kq-out',
          type: 'output',
          position: { x: 1040, y: 160 },
          data: { type: 'output', label: '问答结果', config: {}, status: 'idle' },
        },
      ],
      edges: [
        { id: 'kq-e1', source: 'kq-question', target: 'kq-retrieval' },
        { id: 'kq-e2', source: 'kq-retrieval', target: 'kq-llm' },
        { id: 'kq-e3', source: 'kq-llm', target: 'kq-out' },
      ],
    },
  },

  /* =============== 3. 营销文案 + 配图 =============== */
  {
    id: 'marketing-copy',
    name: '营销文案 + 配图',
    icon: IconMegaphone,
    description:
      '资深文案先撰写产品卖点文案，条件分支按文案是否包含「科技」自动选择科技海报或生活方式场景图，两条分支汇入同一输出。',
    scenario: '市场推广 / 电商素材',
    workflow: {
      version: 1,
      name: '营销文案 + 配图',
      nodes: [
        {
          id: 'mk-product',
          type: 'input',
          position: { x: 80, y: 200 },
          data: {
            type: 'input',
            label: '产品输入',
            config: { text: '例如：AI 智能降噪耳机 Pro' },
            status: 'idle',
          },
        },
        {
          id: 'mk-copy',
          type: 'llm',
          position: { x: 400, y: 200 },
          data: {
            type: 'llm',
            label: '资深文案',
            config: {
              provider: '',
              model: '',
              systemPrompt:
                '你是一位资深营销文案撰稿人。根据产品信息撰写 150 字以内的中文卖点文案：突出核心卖点与使用场景，语言有感染力，结尾单独一行给出一句 slogan。',
              userPrompt: '产品：{{产品输入}}',
              temperature: 0.7,
            },
            status: 'idle',
          },
        },
        {
          id: 'mk-cond',
          type: 'condition',
          position: { x: 720, y: 200 },
          data: {
            type: 'condition',
            label: '科技判定',
            config: { keyword: '科技', caseSensitive: false },
            status: 'idle',
          },
        },
        {
          id: 'mk-img-tech',
          type: 'image',
          position: { x: 1040, y: 40 },
          data: {
            type: 'image',
            label: '科技海报',
            config: {
              provider: '',
              model: '',
              prompt: '为以下产品文案设计一张科技感海报：深色背景、蓝紫光效、产品居中特写。\n{{资深文案}}',
              size: '1152x864',
              count: 1,
            },
            status: 'idle',
          },
        },
        {
          id: 'mk-img-life',
          type: 'image',
          position: { x: 1040, y: 360 },
          data: {
            type: 'image',
            label: '生活方式图',
            config: {
              provider: '',
              model: '',
              prompt: '为以下产品文案设计一张温馨生活方式场景图：自然光线、居家或户外场景。\n{{资深文案}}',
              size: '1152x864',
              count: 1,
            },
            status: 'idle',
          },
        },
        {
          id: 'mk-out',
          type: 'output',
          position: { x: 1360, y: 200 },
          data: { type: 'output', label: '营销成果', config: {}, status: 'idle' },
        },
      ],
      edges: [
        { id: 'mk-e1', source: 'mk-product', target: 'mk-copy' },
        { id: 'mk-e2', source: 'mk-copy', target: 'mk-cond' },
        { id: 'mk-e3', source: 'mk-cond', target: 'mk-img-tech', sourceHandle: 'true' },
        { id: 'mk-e4', source: 'mk-cond', target: 'mk-img-life', sourceHandle: 'false' },
        { id: 'mk-e5', source: 'mk-img-tech', target: 'mk-out' },
        { id: 'mk-e6', source: 'mk-img-life', target: 'mk-out' },
      ],
    },
  },

  /* =============== 4. 多 Agent 研究助手 =============== */
  {
    id: 'research-agent',
    name: '多 Agent 研究助手',
    icon: IconFlask,
    description:
      '研究员智能体调用网页摘要、时钟与计算器工具多轮收集信息，再由报告撰稿模型把结论整理为结构化研究报告。',
    scenario: '调研分析 / 技术调研',
    workflow: {
      version: 1,
      name: '多 Agent 研究助手',
      nodes: [
        {
          id: 'ra-question',
          type: 'input',
          position: { x: 80, y: 160 },
          data: {
            type: 'input',
            label: '研究问题',
            config: { text: '对比向量检索与关键词检索在 RAG 系统中的优劣' },
            status: 'idle',
          },
        },
        {
          id: 'ra-agent',
          type: 'agent',
          position: { x: 400, y: 160 },
          data: {
            type: 'agent',
            label: '研究员',
            config: {
              provider: '',
              model: '',
              systemPrompt:
                '你是一名严谨的研究员。围绕研究问题多轮收集与推理：需要网页资料时调用 webSummary，需要时间信息时调用 getCurrentTime，需要数值计算时调用 calculator；信息足够后停止调用工具并输出研究结论。',
              userPrompt: '研究问题：{{研究问题}}',
              tools: ['webSummary', 'getCurrentTime', 'calculator'],
              maxIterations: 6,
            },
            status: 'idle',
          },
        },
        {
          id: 'ra-llm',
          type: 'llm',
          position: { x: 720, y: 160 },
          data: {
            type: 'llm',
            label: '报告撰写',
            config: {
              provider: '',
              model: '',
              systemPrompt:
                '你是一名技术报告撰稿人。把研究员的结论整理为结构化中文报告：包含「背景」「要点分析」「结论」「建议」四个小节，使用 Markdown 小标题组织，不要编造研究员结论之外的信息。',
              userPrompt: '研究问题：{{研究问题}}\n\n研究员结论：\n{{研究员}}',
              temperature: 0.4,
            },
            status: 'idle',
          },
        },
        {
          id: 'ra-out',
          type: 'output',
          position: { x: 1040, y: 160 },
          data: { type: 'output', label: '研究报告', config: {}, status: 'idle' },
        },
      ],
      edges: [
        { id: 'ra-e1', source: 'ra-question', target: 'ra-agent' },
        { id: 'ra-e2', source: 'ra-agent', target: 'ra-llm' },
        { id: 'ra-e3', source: 'ra-llm', target: 'ra-out' },
      ],
    },
  },

  /* =============== 5. 图文互译工作流 =============== */
  {
    id: 'text-to-image',
    name: '图文互译工作流',
    icon: IconImage,
    description:
      '输入一句场景描述，先由大模型为画作起名并扩写构图、光线、色调等画面细节，再生成对应图像，实现文字与图像的互译。',
    scenario: '创意设计 / 灵感草图',
    workflow: {
      version: 1,
      name: '图文互译工作流',
      nodes: [
        {
          id: 'ti-scene',
          type: 'input',
          position: { x: 80, y: 160 },
          data: {
            type: 'input',
            label: '场景输入',
            config: { text: '黄昏的海边灯塔，一艘小船驶向远方的地平线' },
            status: 'idle',
          },
        },
        {
          id: 'ti-llm',
          type: 'llm',
          position: { x: 400, y: 160 },
          data: {
            type: 'llm',
            label: '画名与提示词',
            config: {
              provider: '',
              model: '',
              systemPrompt:
                '你是绘画提示词设计师。根据用户描述：第一行输出「画名：《xxx》」；随后输出一段用于图像生成的详细中文画面描述，涵盖构图、光线、色调与艺术风格。',
              userPrompt: '{{场景输入}}',
              temperature: 0.9,
            },
            status: 'idle',
          },
        },
        {
          id: 'ti-img',
          type: 'image',
          position: { x: 720, y: 160 },
          data: {
            type: 'image',
            label: '图像生成',
            config: {
              provider: '',
              model: '',
              prompt: '{{画名与提示词}}',
              size: '1152x864',
              count: 1,
            },
            status: 'idle',
          },
        },
        {
          id: 'ti-out',
          type: 'output',
          position: { x: 1040, y: 160 },
          data: { type: 'output', label: '图文成果', config: {}, status: 'idle' },
        },
      ],
      edges: [
        { id: 'ti-e1', source: 'ti-scene', target: 'ti-llm' },
        { id: 'ti-e2', source: 'ti-llm', target: 'ti-img' },
        { id: 'ti-e3', source: 'ti-img', target: 'ti-out' },
      ],
    },
  },
];
