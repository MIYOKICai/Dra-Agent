/** 配置表单组件统一 props */
import type { CanvasNodeData } from '../../store/canvasStore';

export interface NodeConfigFormProps {
  /** 节点 id（updateNodeConfig 用） */
  id: string;
  data: CanvasNodeData;
  /** 面板是否处于展开态（展开时主文本区更高） */
  expanded?: boolean;
  /** 当前节点的上游（祖先）变量名，供主文本区 + 按钮插入 {{变量}} */
  variables?: string[];
}
