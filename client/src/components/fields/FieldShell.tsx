/**
 * 表单字段公共外壳：label + 控件 + description 的统一排版。
 */
import type { ReactNode } from 'react';

/** 输入控件通用样式（input / textarea / select 共用） */
export const fieldControlClass =
  'w-full rounded-base border border-line bg-base px-2 py-1.5 text-xs text-ink ' +
  'outline-none transition-colors placeholder:text-ink-muted focus:border-ink-muted ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

interface FieldShellProps {
  label: string;
  description?: string;
  children: ReactNode;
}

export function FieldShell({ label, description, children }: FieldShellProps) {
  return (
    <div className="mt-3 first:mt-0">
      <span className="text-xs text-ink-muted">{label}</span>
      <div className="mt-1">{children}</div>
      {description && (
        <p className="mt-1 text-[10px] leading-snug text-ink-muted">{description}</p>
      )}
    </div>
  );
}

/** 分区之间的 1px 发丝分隔线（composer 式面板的分隔语言） */
export function FieldRule({ className = '' }: { className?: string }) {
  return <div className={`h-px w-full bg-line ${className}`} />;
}
