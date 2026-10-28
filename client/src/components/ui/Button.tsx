/**
 * 统一按钮体系：primary（主操作）/ secondary（次操作）/ danger（危险）/ ghost（幽灵）
 * / mono（画布墨色主按钮，白底黑字）。
 * 尺寸 sm（工具栏/面板内）、md（常规）、lg（落地页 CTA）。
 * 外观类名见 buttonStyles.ts（Link 等元素复用同一套）。
 */
import type { ButtonHTMLAttributes } from 'react';
import { buttonClass, type ButtonSize, type ButtonVariant } from './buttonStyles';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant = 'secondary', size = 'md', className = '', type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={`${buttonClass(variant, size)} ${className}`} {...rest} />;
}
