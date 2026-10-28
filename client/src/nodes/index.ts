/**
 * React Flow nodeTypes 映射：键为 NodeType（与 RF node.type 一致）。
 * 每类节点一个组件（React.memo），共享 NodeShell 外壳与各自正文。
 */
import type { ComponentType } from 'react';
import type { NodeType } from '@shared/types';
import type { NodeProps } from '@xyflow/react';
import { InputNode } from './InputNode';
import { FileNode } from './FileNode';
import { TemplateNode } from './TemplateNode';
import { LLMNode } from './LLMNode';
import { ImageNode } from './ImageNode';
import { RetrievalNode } from './RetrievalNode';
import { ConditionNode } from './ConditionNode';
import { AgentNode } from './AgentNode';
import { OutputNode } from './OutputNode';
import type { CanvasNode } from '../store/canvasStore';

export const nodeTypes: Record<NodeType, ComponentType<NodeProps<CanvasNode>>> = {
  input: InputNode,
  file: FileNode,
  template: TemplateNode,
  llm: LLMNode,
  image: ImageNode,
  retrieval: RetrievalNode,
  condition: ConditionNode,
  agent: AgentNode,
  output: OutputNode,
};
