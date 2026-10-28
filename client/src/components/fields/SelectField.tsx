/**
 * 下拉选择：自定义浮层替代原生 select（原生弹层由系统绘制，暗色主题下会露出
 * 白底灰框的「系统样式」，且无法做圆角 / 选中勾 / 悬停反馈）。
 * - 触发钮：default=表单分区样式（复用 fieldControlClass）；chip=面板底部工具条紧凑胶囊
 * - 浮层：createPortal 挂到 body，fixed 定位（避免被右侧面板滚动容器裁切，
 *   也不受面板 transform 过渡影响），按触发器矩形定位，空间不足时向上翻转
 * - 交互：支持鼠标、键盘（↑/↓/Enter/Space/Esc/Tab）、点击外部关闭、滚动/resize 重定位
 * - 主题：沿用暗/亮语义令牌；亮色主题的全局阴影禁用规则同样生效
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { IconCheck, IconChevronDown } from '../icons';
import { FieldShell, fieldControlClass } from './FieldShell';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectFieldProps {
  label: string;
  description?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** chip：label 内联 + 无边框透明底的紧凑胶囊（用于 footer 工具条） */
  variant?: 'default' | 'chip';
}

/** 浮层与触发器间距 / 最大高度 / 行高（用于向上翻转的空间估算） */
const MENU_GAP = 6;
const MENU_MAX_H = 264;
const ROW_H = 32;

let selectSeq = 0;

/** 自定义下拉本体：触发器 + Portal 浮层 */
function SelectPopover({
  value,
  options,
  onChange,
  disabled,
  compact,
  triggerLabel,
  triggerClassName,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  compact: boolean;
  /** chip 变体在触发钮内联显示的字段名 */
  triggerLabel?: ReactNode;
  /** 非紧凑触发钮的自定义外观（提供时整体替换 fieldControlClass 默认样式） */
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [box, setBox] = useState<{ left: number; top: number; width: number; above: boolean } | null>(
    null
  );
  const [listId] = useState(() => `select-list-${(selectSeq += 1)}`);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const firstEnabled = options.findIndex((o) => !o.disabled);

  /** 依据触发器矩形计算浮层位置（右侧溢出时左移，下方空间不足时向上翻转） */
  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const rows = Math.min(Math.max(options.length, 1), 8);
    const menuH = rows * ROW_H + 10;
    const width = Math.min(
      Math.max(rect.width, compact ? 260 : 240),
      Math.min(380, window.innerWidth - 16)
    );
    const above =
      rect.bottom + MENU_GAP + menuH > window.innerHeight - 8 && rect.top > menuH + 8;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    setBox({
      left,
      top: above ? rect.top - MENU_GAP : rect.bottom + MENU_GAP,
      width,
      above,
    });
  }, [options.length, compact]);

  const openMenu = useCallback(() => {
    if (disabled) return;
    setActive(selectedIndex >= 0 ? selectedIndex : firstEnabled);
    place();
    setOpen(true);
  }, [disabled, selectedIndex, firstEnabled, place]);

  const closeMenu = useCallback(() => setOpen(false), []);

  /** 打开期间：点击外部关闭；滚动 / 尺寸变化重定位 */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const reposition = () => place();
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, place]);

  /** 选项 / 尺寸变化时重算（打开状态下） */
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  /** 键盘高亮的选项滚入可视区 */
  useEffect(() => {
    if (!open || active < 0) return;
    const row = menuRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  /** 仅可选项参与键盘循环 */
  const move = (dir: 1 | -1) => {
    const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
    if (enabled.length === 0) return;
    const at = enabled.indexOf(active);
    const next = at === -1 ? (dir === 1 ? 0 : enabled.length - 1) : (at + dir + enabled.length) % enabled.length;
    setActive(enabled[next]);
  };

  const commit = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (open) move(1);
        else openMenu();
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (open) move(-1);
        else openMenu();
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (open) commit(active);
        else openMenu();
        break;
      case 'Escape':
        if (open) {
          event.preventDefault();
          // 阻止冒泡：避免同一 Esc 触发面板关闭 / 退出聚焦
          event.stopPropagation();
          setOpen(false);
        }
        break;
      case 'Tab':
        if (open) setOpen(false);
        break;
    }
  };

  const displayLabel = selected?.label ?? '请选择';
  const ariaLabel = typeof triggerLabel === 'string' ? triggerLabel : undefined;

  return (
    <>
      {compact ? (
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={ariaLabel}
          onClick={() => (open ? closeMenu() : openMenu())}
          onKeyDown={onKeyDown}
          className={`inline-flex max-w-full cursor-pointer items-center gap-1 rounded-8 px-1.5 py-1 transition-colors hover:bg-wash focus-visible:bg-wash disabled:cursor-not-allowed disabled:opacity-50 ${
            open ? 'bg-wash' : ''
          }`}
        >
          {triggerLabel !== undefined && (
            <span className="shrink-0 text-[10px] text-ink-muted">{triggerLabel}</span>
          )}
          <span className="min-w-0 max-w-[9rem] truncate text-xs text-ink">
            {displayLabel}
          </span>
          <IconChevronDown
            className={`h-3 w-3 shrink-0 text-ink-muted transition-transform duration-200 ${
              open ? 'rotate-180' : ''
            }`}
          />
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={ariaLabel}
          onClick={() => (open ? closeMenu() : openMenu())}
          onKeyDown={onKeyDown}
          className={`${triggerClassName ?? fieldControlClass} flex cursor-pointer items-center justify-between gap-2 text-left ${
            open && !triggerClassName ? 'border-ink-muted' : ''
          }`}
        >
          <span className={`min-w-0 flex-1 truncate ${selected ? 'text-ink' : 'text-ink-muted'}`}>
            {displayLabel}
          </span>
          <IconChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-ink-muted transition-transform duration-200 ${
              open ? 'rotate-180' : ''
            }`}
          />
        </button>
      )}

      {open &&
        box &&
        createPortal(
          <div
            ref={menuRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel ?? '选项'}
            style={{
              left: box.left,
              top: box.top,
              width: box.width,
              maxHeight: MENU_MAX_H,
              transform: box.above ? 'translateY(-100%)' : undefined,
            }}
            className="fixed z-[70] animate-fade-in space-y-0.5 overflow-y-auto rounded-xl border border-line bg-elevated p-1 shadow-2xl shadow-black/60"
          >
            {options.length === 0 ? (
              <p className="px-2.5 py-3 text-center text-xs text-ink-muted">暂无可选项</p>
            ) : (
              options.map((option, index) => {
                const isSelected = index === selectedIndex;
                return (
                  <button
                    key={`${option.value}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={option.disabled}
                    data-index={index}
                    title={option.label}
                    tabIndex={-1}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => !option.disabled && setActive(index)}
                    onClick={() => commit(index)}
                    className={`flex h-8 w-full items-center gap-2 rounded-8 px-2.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      isSelected
                        ? 'bg-wash-strong font-medium text-ink'
                        : index === active
                          ? 'bg-wash text-ink'
                          : 'text-ink-muted hover:bg-wash hover:text-ink'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {isSelected && <IconCheck className="h-3.5 w-3.5 shrink-0 text-ink" />}
                  </button>
                );
              })
            )}
          </div>,
          document.body
        )}
    </>
  );
}

export function SelectField({
  label,
  description,
  value,
  options,
  onChange,
  disabled,
  variant = 'default',
}: SelectFieldProps) {
  if (variant === 'chip') {
    return (
      <SelectPopover
        compact
        triggerLabel={label}
        value={value}
        options={options}
        onChange={onChange}
        disabled={disabled}
      />
    );
  }

  return (
    <FieldShell label={label} description={description}>
      <SelectPopover
        compact={false}
        triggerLabel={label}
        value={value}
        options={options}
        onChange={onChange}
        disabled={disabled}
      />
    </FieldShell>
  );
}

/** 独立下拉（无表单标签包装）：供页面内联场景（标题切换 / 胶囊选择器）复用画布下拉浮层样式 */
export function Select({
  value,
  options,
  onChange,
  disabled,
  triggerClassName,
  ariaLabel,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** 触发钮自定义外观（替换默认表单控件样式；箭头由组件内置渲染） */
  triggerClassName?: string;
  ariaLabel?: string;
}) {
  return (
    <SelectPopover
      compact={false}
      triggerLabel={ariaLabel}
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
      triggerClassName={triggerClassName}
    />
  );
}
