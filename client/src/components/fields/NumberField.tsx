/** 数字输入：写入前夹取到 [min, max]，空输入不改动 */
import { FieldShell, fieldControlClass } from './FieldShell';

interface NumberFieldProps {
  label: string;
  description?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

export function NumberField({
  label,
  description,
  value,
  onChange,
  min,
  max,
  step = 1,
}: NumberFieldProps) {
  const commit = (raw: string) => {
    if (raw === '') return; // 空输入保留原值
    let n = Number(raw);
    if (Number.isNaN(n)) return;
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    onChange(n);
  };

  return (
    <FieldShell label={label} description={description}>
      <input
        type="number"
        className={fieldControlClass}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => commit(e.target.value)}
      />
    </FieldShell>
  );
}
