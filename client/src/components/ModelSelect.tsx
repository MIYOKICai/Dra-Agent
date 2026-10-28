/**
 * 服务商 / 模型两级下拉：按能力类别（chat / image）过滤模型清单。
 * 数据来自 settingsStore（CanvasPage 挂载时拉取）；
 * 未配置密钥的服务商（available=false）直接不展示，mock 演示服务商恒可用。
 * variant=chip 时渲染为 footer 工具条的紧凑下拉胶囊（label 内联、无边框）。
 */
import { useSettingsStore } from '../store/settingsStore';
import { SelectField, type SelectOption } from './fields';

interface ModelSelectProps {
  kind: 'chat' | 'image';
  provider: string;
  model: string;
  /** 变更回调（切换 provider 时会附带清空 model） */
  onChange: (patch: { provider?: string; model?: string }) => void;
  /** default：分区内常规两行下拉；chip：footer 紧凑胶囊 */
  variant?: 'default' | 'chip';
}

export function ModelSelect({ kind, provider, model, onChange, variant = 'default' }: ModelSelectProps) {
  const providers = useSettingsStore((s) => s.providers);
  const loading = useSettingsStore((s) => s.loading);
  const error = useSettingsStore((s) => s.error);
  const refetch = useSettingsStore((s) => s.refetch);

  // 只列出「具备该能力模型且已配置密钥」的服务商；未配置密钥的不展示（mock 恒可用）
  const candidates = providers.filter(
    (p) => p.available && p.models.some((m) => m.kind.includes(kind))
  );
  const current = candidates.find((p) => p.id === provider);
  const models = (current?.models ?? []).filter((m) => m.kind.includes(kind));

  const providerOptions: SelectOption[] = [
    {
      value: '',
      label: loading ? '加载模型清单中…' : '请选择服务商',
      disabled: false,
    },
    ...candidates.map((p) => ({
      value: p.id,
      label: p.name,
      disabled: false,
    })),
  ];
  // 当前 provider 不在清单中（清单加载失败 / 历史数据）时保留显示
  if (provider && !candidates.some((p) => p.id === provider)) {
    providerOptions.push({ value: provider, label: `${provider}（不在清单中）`, disabled: false });
  }

  const modelOptions: SelectOption[] = [
    { value: '', label: '请选择模型', disabled: false },
    ...models.map((m) => ({ value: m.id, label: m.name, disabled: false })),
  ];
  if (model && !models.some((m) => m.id === model)) {
    modelOptions.push({ value: model, label: `${model}（不在清单中）`, disabled: false });
  }

  // 清单首次加载中：shimmer 骨架占位（避免布局跳动）
  if (loading && providers.length === 0) {
    if (variant === 'chip') {
      return (
        <div aria-hidden="true" className="flex items-center gap-1.5">
          <div className="skeleton h-6 w-24" />
          <div className="skeleton h-6 w-28" />
        </div>
      );
    }
    return (
      <div aria-hidden="true" className="mt-3 space-y-3 first:mt-0">
        {['服务商', '模型'].map((label) => (
          <div key={label}>
            <div className="skeleton h-3 w-12" />
            <div className="skeleton mt-1 h-[30px] w-full" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={variant === 'chip' ? 'flex flex-wrap items-center gap-1' : undefined}>
      <SelectField
        variant={variant}
        label="服务商"
        description="仅显示已配置 API Key 的服务商（mock 演示服务商始终可用）"
        value={provider}
        options={providerOptions}
        onChange={(v) => onChange({ provider: v, model: '' })}
      />
      <SelectField
        variant={variant}
        label="模型"
        value={model}
        options={modelOptions}
        onChange={(v) => onChange({ model: v })}
        disabled={!provider}
      />
      {error && (
        <p className="mt-1.5 flex items-center gap-2 text-[10px] text-ink-muted">
          <span>模型清单加载失败：{error}</span>
          <button
            type="button"
            className="rounded border border-line px-1.5 py-0.5 transition-colors hover:border-ink-muted hover:text-ink"
            onClick={() => void refetch()}
          >
            重试
          </button>
        </p>
      )}
    </div>
  );
}
