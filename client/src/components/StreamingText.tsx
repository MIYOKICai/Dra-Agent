/**
 * 流式文本渲染：文本末尾可追加闪烁光标。
 * 供 NodeShell 输出区（LLM / Agent 的流式文本）使用；
 * 引擎（Task 5）接入后随节点 running 状态自动出现光标动画。
 */
import { memo } from 'react';

interface StreamingTextProps {
  text: string;
  /** 是否处于流式输出中（显示光标） */
  streaming?: boolean;
  className?: string;
}

function StreamingTextInner({ text, streaming = false, className }: StreamingTextProps) {
  return (
    <div
      className={`whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-ink-muted ${
        className ?? ''
      }`}
    >
      {text}
      {streaming && (
        <span className="streaming-cursor text-ink" aria-hidden="true">
          ▍
        </span>
      )}
    </div>
  );
}

export const StreamingText = memo(StreamingTextInner);
