/** 多行文本输入 */
import { FieldShell, fieldControlClass } from './FieldShell';

interface TextAreaProps {
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}

export function TextArea({
  label,
  description,
  value,
  onChange,
  placeholder,
  rows = 4,
}: TextAreaProps) {
  return (
    <FieldShell label={label} description={description}>
      <textarea
        className={`${fieldControlClass} resize-y leading-relaxed`}
        value={value}
        placeholder={placeholder}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
      />
    </FieldShell>
  );
}
