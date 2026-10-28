/** 单行文本输入 */
import { FieldShell, fieldControlClass } from './FieldShell';

interface TextFieldProps {
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function TextField({ label, description, value, onChange, placeholder }: TextFieldProps) {
  return (
    <FieldShell label={label} description={description}>
      <input
        type="text"
        className={fieldControlClass}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </FieldShell>
  );
}
