/** 八类节点配置表单统一出口（ConfigPanel 按 data.type 分发）：
 * FORMS = 主体表单；FOOTERS = 参数条 chip；TAIL_CHIPS = 底部操作行剩余参数 chip */
import type { ComponentType } from 'react';
import type { NodeType } from '@shared/types';
import { InputConfig } from './InputConfig';
import { FileConfig } from './FileConfig';
import { TemplateConfig } from './TemplateConfig';
import { LLMConfig, LLMFooter, LLMTailChips } from './LLMConfig';
import { ImageConfig, ImageFooter } from './ImageConfig';
import { ConditionConfig, ConditionFooter } from './ConditionConfig';
import { RetrievalConfig, RetrievalFooter } from './RetrievalConfig';
import { AgentConfig, AgentFooter, AgentTailChips } from './AgentConfig';
import { OutputConfig } from './OutputConfig';
import type { NodeConfigFormProps } from './types';

export const CONFIG_FORMS: Record<NodeType, ComponentType<NodeConfigFormProps>> = {
  input: InputConfig,
  file: FileConfig,
  template: TemplateConfig,
  llm: LLMConfig,
  image: ImageConfig,
  condition: ConditionConfig,
  retrieval: RetrievalConfig,
  agent: AgentConfig,
  output: OutputConfig,
};

/** 参数条（该节点最常用参数的紧凑 chip）；未注册的类型不渲染参数条 */
export const CONFIG_FOOTERS: Partial<Record<NodeType, ComponentType<NodeConfigFormProps>>> = {
  llm: LLMFooter,
  agent: AgentFooter,
  image: ImageFooter,
  retrieval: RetrievalFooter,
  condition: ConditionFooter,
};

/** 底部操作行左侧剩余参数 chip（如 LLM 温度）；未注册的类型左侧留空 */
export const CONFIG_TAIL_CHIPS: Partial<Record<NodeType, ComponentType<NodeConfigFormProps>>> = {
  llm: LLMTailChips,
  agent: AgentTailChips,
};

export type { NodeConfigFormProps };
