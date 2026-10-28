/**
 * 节点注册表：八类节点的静态定义（名称 / SVG 图标 / 颜色 / 句柄配置）。
 * 图标引用 icons.tsx 的线性 SVG 组件，颜色为 Tailwind 文本色类（墨色单色系，按灰度亮度区分类型）。
 */
import type { NodeType } from '@shared/types';
import {
  IconType,
  IconFileText,
  IconBot,
  IconImage,
  IconSearch,
  IconGitBranch,
  IconSparkles,
  IconFlag,
  IconUpload,
  type IconComponent,
} from '../components/icons';

export interface SourceHandleDef {
  id: string;
  label: string;
}

export interface NodeDef {
  label: string;
  icon: IconComponent;
  /** Tailwind 文本色类，用于图标 / 徽标 */
  color: string;
  description: string;
  hasTargetHandle: boolean;
  sourceHandles: SourceHandleDef[];
}

export const NODE_DEFS: Record<NodeType, NodeDef> = {
  input: {
    label: '输入节点',
    icon: IconType,
    color: 'text-ink-muted',
    description: '工作流起点，提供用户输入',
    hasTargetHandle: false,
    sourceHandles: [{ id: 'out', label: '输出' }],
  },
  file: {
    label: '文件上传',
    icon: IconUpload,
    color: 'text-ink-muted',
    description: '拖入 PDF / Word / TXT / 图片，输出解析文本',
    hasTargetHandle: false,
    sourceHandles: [{ id: 'out', label: '输出' }],
  },
  template: {
    label: '提示词模板',
    icon: IconFileText,
    color: 'text-ink-muted',
    description: '组织并渲染提示词模板',
    hasTargetHandle: true,
    sourceHandles: [{ id: 'out', label: '输出' }],
  },
  llm: {
    label: '大模型调用',
    icon: IconBot,
    color: 'text-ink',
    description: '调用大模型生成回答',
    hasTargetHandle: true,
    sourceHandles: [{ id: 'out', label: '输出' }],
  },
  image: {
    label: '图像生成',
    icon: IconImage,
    color: 'text-ink-muted',
    description: '根据提示词生成图像',
    hasTargetHandle: true,
    sourceHandles: [{ id: 'out', label: '输出' }],
  },
  retrieval: {
    label: '知识检索',
    icon: IconSearch,
    color: 'text-ink-muted',
    description: '从知识库检索相关片段',
    hasTargetHandle: true,
    sourceHandles: [{ id: 'out', label: '输出' }],
  },
  condition: {
    label: '条件分支',
    icon: IconGitBranch,
    color: 'text-ink-muted',
    description: '按条件将流程分流执行',
    hasTargetHandle: true,
    sourceHandles: [
      { id: 'true', label: 'true' },
      { id: 'false', label: 'false' },
    ],
  },
  agent: {
    label: '智能体',
    icon: IconSparkles,
    color: 'text-ink',
    description: '具备工具调用能力的 Agent',
    hasTargetHandle: true,
    sourceHandles: [{ id: 'out', label: '输出' }],
  },
  output: {
    label: '输出节点',
    icon: IconFlag,
    color: 'text-ink',
    description: '工作流终点，呈现最终结果',
    hasTargetHandle: true,
    sourceHandles: [],
  },
};

export const NODE_TYPES = Object.keys(NODE_DEFS) as NodeType[];

export function isNodeType(value: unknown): value is NodeType {
  return typeof value === 'string' && value in NODE_DEFS;
}

/** 常见 config 键的中文展示名 */
const CONFIG_KEY_LABELS: Record<string, string> = {
  provider: '提供方',
  model: '模型',
  prompt: '提示词',
  template: '模板',
  systemPrompt: '系统提示',
  topK: 'Top K',
  kbName: '知识库',
  kbId: '知识库',
  expression: '条件',
  tools: '工具',
  inputType: '输入类型',
  value: '输入值',
};

/** 从 config 中提取最多两行可读摘要（字符串 / 数字 / 布尔字段） */
export function summarizeConfig(config: Record<string, unknown>): string[] {
  return Object.entries(config)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .slice(0, 2)
    .map(([k, v]) => {
      const key = CONFIG_KEY_LABELS[k] ?? k;
      const text = String(v);
      return `${key}: ${text.length > 20 ? `${text.slice(0, 20)}…` : text}`;
    });
}
