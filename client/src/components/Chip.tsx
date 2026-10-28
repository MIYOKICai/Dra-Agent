/**
 * 小徽标 chip：节点正文中的模型 / 工具 / 参数摘要标签。
 */
import type { ReactNode } from 'react';

interface ChipProps {
  children: ReactNode;
  /** primary: 强调（如模型名，墨色单色）；default: 中性灰 */
  tone?: 'default' | 'primary';
  title?: string;
}

export function Chip({ children, tone = 'default', title }: ChipProps) {
  const cls =
    tone === 'primary'
      ? 'bg-wash-strong text-ink'
      : 'bg-elevated text-ink-muted';
  return (
    <span
      title={title}
      className={`inline-flex max-w-full items-center truncate rounded px-1.5 py-0.5 text-[10px] leading-none ${cls}`}
    >
      {children}
    </span>
  );
}
