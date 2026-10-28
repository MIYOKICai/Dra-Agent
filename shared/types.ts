/**
 * Agent 画布 —— 全项目共享类型定义
 * client 通过 vite alias `@shared` 引用；server 通过 tsconfig include + 相对路径引用。
 */

/* =============== 节点与工作流 =============== */

/** 画布节点类型 */
export type NodeType =
  | 'input'
  | 'file'
  | 'template'
  | 'llm'
  | 'image'
  | 'retrieval'
  | 'condition'
  | 'agent'
  | 'output';

/** 文件上传节点内的文件元信息（正文/原图不落 config，按 id 从服务端按需拉取） */
export interface FileMeta {
  /** 服务端文件 id（上传时由客户端生成、服务端沿用） */
  id: string;
  name: string;
  /** 字节数 */
  size: number;
  /** 类别（决定图标与运行时读取方式） */
  kind: 'pdf' | 'doc' | 'docx' | 'txt' | 'image';
  /** 文本提取状态：pending=解析中 / done / failed（图片恒为 done） */
  extract: 'pending' | 'done' | 'failed';
  /** extract=failed 时的原因 */
  extractError?: string;
}

/** 节点运行状态 */
export type NodeRunStatus =
  | 'idle'
  | 'waiting'
  | 'running'
  | 'success'
  | 'error'
  | 'blocked'
  | 'skipped';

/** Agent 节点的执行步骤记录 */
export interface AgentStep {
  kind: 'thought' | 'tool_call' | 'tool_result' | 'answer';
  content: string;
  /** kind 为 tool_call / tool_result 时对应的工具名 */
  tool?: string;
}

/** 知识库检索命中的片段 */
export interface KBFragment {
  text: string;
  source: string;
  /** 相似度得分 0~1 */
  score: number;
}

/** 问答引用（精简：来源文件 + 相似度得分，不含片段全文） */
export interface KBCitation {
  source: string;
  score: number;
}

/** 知识库问答消息（随库服务端持久化，刷新 / 换浏览器不丢） */
export interface KBQAMessage {
  role: 'user' | 'assistant';
  content: string;
  /** assistant 消息附带的引用 */
  sources?: KBCitation[];
}

/** 节点运行产物 */
export interface NodeOutput {
  text?: string;
  images?: string[];
  fragments?: KBFragment[];
  /** condition 节点的分支判定结果 */
  branch?: 'true' | 'false';
  steps?: AgentStep[];
}

/** 画布节点数据（React Flow node.data） */
export interface NodeData {
  type: NodeType;
  label: string;
  config: Record<string, unknown>;
  status?: NodeRunStatus;
  error?: string;
  output?: NodeOutput;
}

/** 工作流中的节点 */
export interface WorkflowNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  data: NodeData;
}

/** 工作流中的连线 */
export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /** condition 等多出口节点的出口标识 */
  sourceHandle?: string;
}

/** 工作流序列化 JSON（保存 / 加载格式） */
export interface WorkflowJSON {
  version: number;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/* =============== 网关协议（client ↔ server） =============== */

/** OpenAI 兼容的对话消息 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** role=tool 时对应的 tool_call id */
  tool_call_id?: string;
  /** assistant 发起的工具调用 */
  tool_calls?: { id: string; name: string; arguments: string }[];
}

/** 工具风险分级：read=只读直执行；write=写操作需用户授权；danger=高危需二次确认 */
export type ToolRisk = 'read' | 'write' | 'danger';

/** 工具定义（function calling） */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema 形式的参数描述 */
  parameters: Record<string, unknown>;
  /** 风险分级（服务端注册表标注；缺省视为 read） */
  risk?: ToolRisk;
}

/** 对话补全请求（经 server 统一网关转发） */
export interface ChatRequest {
  provider: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  tools?: ToolSchema[];
  /** 视觉输入：随最后一条 user 消息发送的图片（dataURL 或公网 URL），仅视觉模型接受 */
  images?: string[];
  /** 服务端 Agent 模式：ReAct 循环 / 工具风险分级 / 记忆与知识库注入都在 server 执行 */
  agent?: boolean;
  /** 客户端已压缩的历史摘要（服务端增量续摘用） */
  historySummary?: string;
  /** 要求服务端对全量历史重新摘要（而非仅压缩窗口外溢出） */
  refreshSummary?: boolean;
  /** 确认续跑：用户对写 / 高危工具调用的授权决议（非空时进入恢复模式） */
  toolConfirms?: { callId: string; approved: boolean }[];
}

/** 图像生成请求 */
export interface ImageRequest {
  provider: string;
  model: string;
  prompt: string;
  size?: string;
  count?: number;
}

/** 模型能力类别 */
export type ModelKind = 'chat' | 'image' | 'embedding';

export interface ModelInfo {
  id: string;
  name: string;
  kind: ModelKind[];
  /** 是否支持视觉输入（看图）；缺省视为不支持 */
  vision?: boolean;
}

export interface ProviderInfo {
  id: string;
  name: string;
  available: boolean;
  models: ModelInfo[];
}

export interface ModelsResponse {
  providers: ProviderInfo[];
}

/* =============== SSE 事件（server → client，逐行 JSON） =============== */

/** 工具调用描述 */
export interface SSEToolCall {
  id: string;
  name: string;
  arguments: string;
  /** 风险分级（server 按注册表标注；缺省视为 read） */
  risk?: ToolRisk;
}

/** 工作流 / 对话运行过程中的 SSE 事件 */
export type SSEEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_calls'; calls: SSEToolCall[] }
  | { type: 'tool_result'; callId: string; name: string; content: string; ok?: boolean }
  | { type: 'blocked'; reason: string }
  | { type: 'error'; message: string }
  | {
      type: 'done';
      finishReason?: string;
      /** 上游 token 用量（stream_options.include_usage；不可用时缺省） */
      usage?: { promptTokens: number; completionTokens: number };
    }
  /** Agent 过程说明：thought=模型中间轮思考文本；notice=过程提示（知识库命中 / 轮次上限等） */
  | { type: 'agent_step'; kind: 'thought' | 'notice'; content: string }
  /** 知识库自动检索命中（Agent 启动时按用户消息查询） */
  | { type: 'rag_context'; fragments: KBFragment[] }
  /** 写 / 高危工具调用暂停待确认：calls=待确认调用；messages=完整协议数组（确认后原样回传续跑） */
  | { type: 'confirm_required'; calls: SSEToolCall[]; messages: ChatMessage[] }
  /** 长对话压缩完成：summary 为覆盖到当前为止的新摘要 */
  | { type: 'memory_summary'; summary: string };

/* =============== 知识库 =============== */

/** 知识库元信息 */
export interface KBInfo {
  id: string;
  name: string;
  chunkSize: number;
  chunkOverlap: number;
  docCount: number;
  chunkCount: number;
  createdAt: string;
}

/** 知识库检索结果 */
export interface KBSearchResult {
  fragments: KBFragment[];
}

/* =============== 工具执行 =============== */

/** 工具执行结果（server 端注册表执行与 client 网关调用共用） */
export interface ToolExecutionResult {
  /** 是否执行成功（参数解析失败 / 未知工具 / 工具内部异常均为 false） */
  ok: boolean;
  /** ok=true 时的工具输出文本 */
  result?: string;
  /** ok=false 时的错误说明 */
  error?: string;
}

/* =============== 知识库扩展（Task 7 追加） =============== */

/** 知识库内文档元信息 */
export interface KBDocInfo {
  id: string;
  name: string;
  chunkCount: number;
  createdAt: string;
}

/** 知识库检索模式：vector=向量相似度；keyword=关键词（字符 bigram）重合度 */
export type KBMode = 'vector' | 'keyword';

/** 带文档列表与检索模式的知识库信息（/api/kb 系列接口返回 KBInfoEx） */
export interface KBInfoEx extends KBInfo {
  mode: KBMode;
  documents: KBDocInfo[];
}
