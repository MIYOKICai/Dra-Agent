/**
 * 按钮外观类名（供 Button 组件与 Link 等非 button 元素共用）。
 * 独立成文件以满足 react-refresh：组件文件只导出组件。
 */
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'mono';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'border border-primary bg-primary text-white shadow-sm shadow-primary/30 hover:bg-primary-hover hover:border-primary-hover',
  secondary: 'border border-line bg-elevated text-ink hover:border-ink-muted',
  danger: 'border border-line bg-elevated text-ink hover:border-ink-muted hover:text-ink',
  ghost: 'border border-transparent bg-transparent text-ink-muted hover:text-ink hover:bg-elevated',
  // 画布墨色主按钮：暗色白底黑字 / 亮色黑底白字（primary 的单色替代，落地页仍用 primary）
  mono: 'border border-mono bg-mono text-mono-fg shadow-sm hover:bg-mono-hover hover:border-mono-hover',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'px-2.5 py-1 text-xs',
  md: 'px-3.5 py-1.5 text-xs',
  lg: 'px-7 py-3 text-sm',
};

const DISABLED_CLASS = 'disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none';

/** 生成按钮外观类名（供 Button 与 Link 等元素共用） */
export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md'): string {
  return `inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-base font-medium leading-none transition-colors ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${DISABLED_CLASS}`;
}
