/** 滑杆 + 当前值展示 */
import { FieldShell } from './FieldShell';

interface SliderFieldProps {
  label: string;
  description?: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
}

export function SliderField({
  label,
  description,
  value,
  onChange,
  min,
  max,
  step = 1,
}: SliderFieldProps) {
  return (
    <FieldShell label={label} description={description}>
      <div className="flex items-center gap-2">
        <input
          type="range"
          className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-elevated accent-white"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="w-10 shrink-0 rounded bg-elevated px-1 py-0.5 text-center font-mono text-[10px] text-ink">
          {value}
        </span>
      </div>
    </FieldShell>
  );
}
