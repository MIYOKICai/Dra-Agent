/** 多选勾选组：每项带说明文案 */
import { FieldShell } from './FieldShell';

export interface CheckboxOption {
  value: string;
  label: string;
  description?: string;
}

interface MultiCheckboxFieldProps {
  label: string;
  description?: string;
  /** 当前选中的 value 集合 */
  value: string[];
  options: CheckboxOption[];
  onChange: (value: string[]) => void;
}

export function MultiCheckboxField({
  label,
  description,
  value,
  options,
  onChange,
}: MultiCheckboxFieldProps) {
  const toggle = (v: string, checked: boolean) => {
    onChange(checked ? [...value, v] : value.filter((item) => item !== v));
  };

  return (
    <FieldShell label={label} description={description}>
      <div className="field-group space-y-1.5 rounded-base border border-line bg-base px-2 py-2">
        {options.map((opt) => {
          const checked = value.includes(opt.value);
          return (
            <label
              key={opt.value}
              className="flex cursor-pointer items-start gap-2 rounded-2 px-1 py-0.5 transition-colors hover:bg-elevated"
            >
              <input
                type="checkbox"
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-white"
                checked={checked}
                onChange={(e) => toggle(opt.value, e.target.checked)}
              />
              <span className="min-w-0">
                <span className="block text-[11px] leading-snug text-ink">{opt.label}</span>
                {opt.description && (
                  <span className="block text-[10px] leading-snug text-ink-muted">
                    {opt.description}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
    </FieldShell>
  );
}
