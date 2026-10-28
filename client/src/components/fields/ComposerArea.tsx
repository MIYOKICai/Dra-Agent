/**
 * 创作台主文本区：无边框、透明底的大面积自由书写 textarea，随内容自动增高；
 * 顶行为字段标签 + 可选变量插入（+ 按钮 → 点击 {{变量名}} 插入光标处，
 * 复用引擎既有的 {{节点名}} 插值语法），右下角字符计数（配置了 maxLength 且超限时转橙色警示）。
 */
import { useEffect, useRef, useState } from 'react';
import { IconPlus } from '../icons';

interface ComposerAreaProps {
  /** 字段标签（小字展示 + aria-label） */
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** 面板是否处于展开态（展开时文本区更高） */
  expanded?: boolean;
  /** 可插入的上游变量名；为空时不渲染 + 按钮 */
  variables?: string[];
  /** 字符上限；缺省只显示当前字数 */
  maxLength?: number;
}

export function ComposerArea({
  label,
  description,
  value,
  onChange,
  placeholder,
  expanded = false,
  variables,
  maxLength,
}: ComposerAreaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const over = maxLength !== undefined && value.length > maxLength;

  /* 自动增高：内容或展开态变化时重算高度（先置 auto 取 scrollHeight） */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value, expanded]);

  /** 把 {{变量名}} 插到光标处（无选区光标时追加末尾），随后恢复焦点与光标 */
  const insertVariable = (name: string) => {
    const snippet = `{{${name}}}`;
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    onChange(value.slice(0, start) + snippet + value.slice(end));
    setMenuOpen(false);
    const caret = start + snippet.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  return (
    <div>
      {/* 顶行：字段标签 + 变量插入（无上游变量时不渲染 + 按钮） */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-ink-muted">{label}</span>
        {variables && variables.length > 0 && (
          <div className="relative">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-ink-muted transition-colors hover:bg-wash hover:text-ink"
              title="插入上游节点输出变量"
              aria-label="插入变量"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <IconPlus className="h-3 w-3" />
              变量
            </button>
            {menuOpen && (
              <>
                {/* 全屏透明遮罩：点击空白处关闭 */}
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                {/* 右对齐锚定 + 限制最大宽度：按钮在面板右缘，向左展开不会越出区块 */}
                <div className="no-scrollbar absolute right-0 top-full z-20 mt-1 max-h-40 w-max min-w-[11rem] max-w-[18rem] space-y-0.5 overflow-y-auto rounded-[14px] border border-line bg-elevated p-1.5 shadow-lg shadow-black/40">
                  {variables.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className="block w-full truncate rounded-lg px-2 py-1.5 text-left font-mono text-[11px] text-ink transition-colors hover:bg-wash-strong"
                      onClick={() => insertVariable(name)}
                    >
                      {`{{${name}}}`}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <textarea
        ref={ref}
        aria-label={label}
        className={`mt-1 w-full resize-none overflow-y-auto no-scrollbar rounded-base border border-line px-2.5 py-2.5 text-[13px] leading-relaxed text-ink outline-none transition-[background-color,border-color,min-height] duration-300 placeholder:text-ink-muted ${
          expanded ? 'min-h-[13rem]' : 'min-h-[7rem]'
        } max-h-[26rem]`}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {/* 底部行：右下角字符计数 */}
      <div className="mt-0.5 flex items-center justify-end px-0.5">
        <span
          className={`shrink-0 text-[10px] tabular-nums ${
            over ? 'text-orange-400' : 'text-ink-muted'
          }`}
        >
          {maxLength !== undefined ? `${value.length}/${maxLength}` : value.length} 字符
        </span>
      </div>
      {description && <p className="mt-1 text-[10px] leading-snug text-ink-muted">{description}</p>}
    </div>
  );
}
