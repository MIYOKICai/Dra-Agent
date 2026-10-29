/**
 * 八类节点的 config 类型定义、默认值与读取函数。
 * 节点正文组件与配置面板表单共用同一读取函数，保证取值口径一致。
 * 均带默认值兜底：config 可能来自 localStorage / 导入 JSON，字段可缺失。
 */
import type { FileMeta } from '@shared/types';
import { cfg, cfgClamped, cfgStringArray } from '../utils/cfg';

/* =============== config 类型 =============== */

export interface InputNodeConfig {
  text: string;
}

export interface TemplateNodeConfig {
  template: string;
}

export interface LLMNodeConfig {
  provider: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** 0 ~ 2 */
  temperature: number;
}

export interface ImageNodeConfig {
  provider: string;
  model: string;
  prompt: string;
  size: string;
  /** 1 ~ 4 */
  count: number;
}

export interface ConditionNodeConfig {
  keyword: string;
  caseSensitive: boolean;
}

export interface RetrievalNodeConfig {
  kbId: string;
  query: string;
  /** 1 ~ 10 */
  topK: number;
}

export interface AgentNodeConfig {
  provider: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  tools: string[];
  /** 1 ~ 10 */
  maxIterations: number;
}

/** 文件上传节点：仅存文件元信息，正文 / 原图按 id 从服务端按需拉取 */
export interface FileNodeConfig {
  files: FileMeta[];
}

/** output 节点无配置项 */

/* =============== 常量与默认值 =============== */

export const LLM_DEFAULTS: LLMNodeConfig = {
  provider: '',
  model: '',
  systemPrompt: '你是一个乐于助人的 AI 助手。',
  userPrompt: '',
  temperature: 0.7,
};

/** 图像尺寸白名单（与 server /api/image 校验一致） */
export const IMAGE_SIZES = [
  '512x512',
  '768x768',
  '1024x1024',
  '864x1152',
  '1152x864',
  '1440x720',
] as const;

export const IMAGE_DEFAULTS: ImageNodeConfig = {
  provider: '',
  model: '',
  prompt: '',
  size: '1024x1024',
  count: 1,
};

export const CONDITION_DEFAULTS: ConditionNodeConfig = {
  keyword: '',
  caseSensitive: false,
};

export const RETRIEVAL_DEFAULTS: RetrievalNodeConfig = {
  kbId: '',
  query: '',
  topK: 3,
};

/** Agent 固定工具清单（value 与服务端内置工具注册表 server/src/tools.ts 名称一致） */
export const AGENT_TOOLS = [
  {
    value: 'getCurrentTime',
    label: 'getCurrentTime · 当前时间',
    description: '获取当前日期时间与星期（Asia/Shanghai 时区）',
  },
  {
    value: 'calculator',
    label: 'calculator · 计算器',
    description: '计算数学表达式，支持四则、幂运算与括号',
  },
  {
    value: 'webSummary',
    label: 'webSummary · 网页摘要',
    description: '抓取网页内容并返回标题与正文摘要',
  },
  {
    value: 'searchKnowledge',
    label: 'searchKnowledge · 知识检索',
    description: '在知识库中检索相关文档片段',
  },
  {
    value: 'saveKnowledge',
    label: 'saveKnowledge · 保存知识',
    description: '把内容保存为知识库文档（写操作，需用户确认）',
  },
  {
    value: 'deleteKnowledgeDoc',
    label: 'deleteKnowledgeDoc · 删除知识文档',
    description: '按名称删除知识库文档（高危，需用户确认）',
  },
  {
    value: 'readTextFile',
    label: 'readTextFile · 读取文件',
    description: '读取本地文本文件内容（相对路径以用户主目录为基准）',
  },
  {
    value: 'writeTextFile',
    label: 'writeTextFile · 写入文件',
    description: '写入/追加文本到本地文件，自动创建父目录（写操作，需用户确认）',
  },
  {
    value: 'listDirectory',
    label: 'listDirectory · 列出目录',
    description: '列出文件夹内容：名称、类型、大小与修改时间',
  },
  {
    value: 'createDirectory',
    label: 'createDirectory · 创建文件夹',
    description: '递归创建文件夹（写操作，需用户确认）',
  },
  {
    value: 'deletePath',
    label: 'deletePath · 删除文件/文件夹',
    description: '删除文件或整个文件夹，不可恢复（高危，需用户确认）',
  },
  {
    value: 'movePath',
    label: 'movePath · 移动/重命名',
    description: '移动或重命名文件/文件夹，拒绝覆盖同名目标（写操作，需用户确认）',
  },
  {
    value: 'copyPath',
    label: 'copyPath · 复制',
    description: '复制文件或整个文件夹，拒绝覆盖同名目标（写操作，需用户确认）',
  },
  {
    value: 'searchFiles',
    label: 'searchFiles · 搜索文件',
    description: '按通配符（* ?）在目录中递归搜索文件名',
  },
  {
    value: 'runCommand',
    label: 'runCommand · 执行命令',
    description: '执行 PowerShell / cmd / sh 命令并返回输出；开窗口命令以可见窗口启动（高危，需用户确认）',
  },
  {
    value: 'openPath',
    label: 'openPath · 打开文件/网址',
    description: '用系统默认程序打开文件、文件夹、网页或按应用名启动（如 cmd；写操作，需用户确认）',
  },
  {
    value: 'getSystemInfo',
    label: 'getSystemInfo · 系统信息',
    description: '获取操作系统、CPU、内存、目录等环境信息',
  },
  {
    value: 'readClipboard',
    label: 'readClipboard · 读取剪贴板',
    description: '读取系统剪贴板中的文本内容',
  },
  {
    value: 'writeClipboard',
    label: 'writeClipboard · 写入剪贴板',
    description: '把文本写入系统剪贴板（写操作，需用户确认）',
  },
] as const;

export const AGENT_DEFAULTS: AgentNodeConfig = {
  provider: '',
  model: '',
  systemPrompt:
    '你是 ReAct 智能体：先用一句话说明思考，再按需调用工具获取外部信息或执行桌面操作（时间 / 计算 / 网页 / 知识库 / 文件与文件夹 / 命令行），依据观察结果继续推理；信息足够后停止调用工具并给出最终回答。严禁编造工具未返回的数据；工具失败时说明原因或改用其他方案。',
  userPrompt: '',
  tools: [],
  maxIterations: 5,
};

/* =============== 读取函数 =============== */

export function readInputConfig(config: Record<string, unknown> | undefined): InputNodeConfig {
  return { text: cfg(config, 'text', '') };
}

export function readTemplateConfig(config: Record<string, unknown> | undefined): TemplateNodeConfig {
  return { template: cfg(config, 'template', '') };
}

export function readLLMConfig(config: Record<string, unknown> | undefined): LLMNodeConfig {
  return {
    provider: cfg(config, 'provider', LLM_DEFAULTS.provider),
    model: cfg(config, 'model', LLM_DEFAULTS.model),
    systemPrompt: cfg(config, 'systemPrompt', LLM_DEFAULTS.systemPrompt),
    userPrompt: cfg(config, 'userPrompt', LLM_DEFAULTS.userPrompt),
    temperature: cfgClamped(config, 'temperature', LLM_DEFAULTS.temperature, 0, 2),
  };
}

export function readImageConfig(config: Record<string, unknown> | undefined): ImageNodeConfig {
  return {
    provider: cfg(config, 'provider', IMAGE_DEFAULTS.provider),
    model: cfg(config, 'model', IMAGE_DEFAULTS.model),
    prompt: cfg(config, 'prompt', IMAGE_DEFAULTS.prompt),
    size: cfg(config, 'size', IMAGE_DEFAULTS.size),
    count: cfgClamped(config, 'count', IMAGE_DEFAULTS.count, 1, 4),
  };
}

export function readConditionConfig(config: Record<string, unknown> | undefined): ConditionNodeConfig {
  return {
    keyword: cfg(config, 'keyword', CONDITION_DEFAULTS.keyword),
    caseSensitive: cfg(config, 'caseSensitive', CONDITION_DEFAULTS.caseSensitive),
  };
}

export function readRetrievalConfig(config: Record<string, unknown> | undefined): RetrievalNodeConfig {
  return {
    kbId: cfg(config, 'kbId', RETRIEVAL_DEFAULTS.kbId),
    query: cfg(config, 'query', RETRIEVAL_DEFAULTS.query),
    topK: cfgClamped(config, 'topK', RETRIEVAL_DEFAULTS.topK, 1, 10),
  };
}

export function readAgentConfig(config: Record<string, unknown> | undefined): AgentNodeConfig {
  return {
    provider: cfg(config, 'provider', AGENT_DEFAULTS.provider),
    model: cfg(config, 'model', AGENT_DEFAULTS.model),
    systemPrompt: cfg(config, 'systemPrompt', AGENT_DEFAULTS.systemPrompt),
    userPrompt: cfg(config, 'userPrompt', AGENT_DEFAULTS.userPrompt),
    tools: cfgStringArray(config, 'tools', AGENT_DEFAULTS.tools),
    maxIterations: cfgClamped(config, 'maxIterations', AGENT_DEFAULTS.maxIterations, 1, 10),
  };
}

/** FileMeta 类型守卫：localStorage / 导入 JSON 可能携带脏数据，逐字段校验后过滤 */
function isFileMeta(v: unknown): v is FileMeta {
  if (!v || typeof v !== 'object') return false;
  const f = v as Partial<FileMeta>;
  return (
    typeof f.id === 'string' &&
    f.id.length > 0 &&
    typeof f.name === 'string' &&
    typeof f.size === 'number' &&
    (f.kind === 'pdf' || f.kind === 'doc' || f.kind === 'docx' || f.kind === 'txt' || f.kind === 'image') &&
    (f.extract === 'pending' || f.extract === 'done' || f.extract === 'failed')
  );
}

export function readFileConfig(config: Record<string, unknown> | undefined): FileNodeConfig {
  const raw = config?.files;
  return {
    files: Array.isArray(raw)
      ? raw.filter((item): item is FileMeta => isFileMeta(item))
      : [],
  };
}
