/** 输出节点配置：无配置项，说明展示内容 */
import type { NodeConfigFormProps } from './types';

export function OutputConfig({ data }: NodeConfigFormProps) {
  return (
    <div className="rounded-base border border-dashed border-line bg-elevated/60 px-3 py-4 text-center">
      <p className="text-xs leading-relaxed text-ink-muted">
        输出节点无需配置。
        <br />
        运行后在此节点分节展示最终文本（Markdown）、图片画廊与检索片段。
      </p>
      <p className="mt-1 text-[10px] text-ink-muted">当前状态：{data.status ?? 'idle'}</p>
    </div>
  );
}
