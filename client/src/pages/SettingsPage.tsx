/**
 * 设置页（/settings）：模型服务商可视化管理。
 * - 服务商卡片：改名 / API Key / Base URL / 模型清单增删改 / 默认对话·绘图·向量模型
 * - 「测试连通」按服务商探测（复用 /api/test），结果内联展示
 * - 新建自定义服务商（OpenAI 兼容）；非内置服务商可删除
 * - 保存即时写盘（服务端 data/settings.json）并刷新全局模型清单（下拉即时可用）
 * 布局与知识库页一致：左侧边栏 + 右侧滚动内容列。
 */
import { useEffect, useState } from 'react';
import type { ModelInfo, ModelKind } from '@shared/types';
import {
  createProvider,
  deleteProvider,
  fetchProviderSettings,
  testProvider,
  updateProvider,
  type ProviderPatch,
  type ProviderSettingsItem,
  type TestProviderResult,
} from '../api/gateway';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { ProjectSidebar } from '../components/canvas/ProjectSidebar';
import { Select } from '../components/fields/SelectField';
import { Button } from '../components/ui/Button';
import { IconCheck, IconPlus, IconSettings, IconTrash, IconX } from '../components/icons';

/** 模型能力徽标（与全局墨色单色系一致，随主题反相） */
const KIND_META: Record<ModelKind, { label: string; cls: string }> = {
  chat: { label: '对话', cls: 'bg-wash-strong text-ink' },
  image: { label: '图像', cls: 'bg-wash text-ink-muted' },
  embedding: { label: '向量', cls: 'bg-wash-faint text-ink-muted' },
};

/** 能力徽标统一外观（与 KindChips 同尺寸：h-6 胶囊） */
const KIND_BADGE = 'rounded-md px-2 py-1 text-[10px] font-medium leading-none';

const ALL_KINDS: ModelKind[] = ['chat', 'image', 'embedding'];

/** 能力类型切换 chips：点选叠加，再点取消 */
function KindChips({ value, onChange }: { value: ModelKind[]; onChange: (v: ModelKind[]) => void }) {
  return (
    <span className="flex shrink-0 gap-1">
      {ALL_KINDS.map((k) => {
        const on = value.includes(k);
        return (
          <button
            key={k}
            type="button"
            title={`${on ? '移除' : '添加'}「${KIND_META[k].label}」能力`}
            onClick={() => onChange(on ? value.filter((x) => x !== k) : [...value, k])}
            className={`rounded-md px-2 py-1 text-[10px] font-medium leading-none transition-colors ${
              on
                ? 'bg-mono text-mono-fg'
                : 'border border-line bg-base text-ink-muted hover:border-ink-muted hover:text-ink'
            }`}
          >
            {KIND_META[k].label}
          </button>
        );
      })}
    </span>
  );
}

/** 表单输入统一外观（与默认模型下拉触发钮共用，保证同行等高） */
const FIELD =
  'min-w-0 flex-1 rounded-lg border border-line bg-base px-3 py-2 text-xs text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-ink-muted';

/** 表单字段行：标签右对齐 + 内容（默认模型下拉也复用此行，保证全卡栅格一致） */
function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-right text-[11px] leading-none text-ink-muted">{label}</span>
      {children}
    </label>
  );
}

/** 卡头状态徽标：圆点 + 文案（on=墨点，off=线点） */
function StatusPill({ tone, label, title }: { tone: 'on' | 'off'; label: string; title?: string }) {
  return (
    <span
      title={title}
      className="flex shrink-0 items-center gap-1.5 rounded-full bg-wash px-2 py-1 text-[10px] leading-none text-ink-muted"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone === 'on' ? 'bg-mono' : 'bg-line'}`} />
      {label}
    </span>
  );
}

/** 卡头右上操作：测试连通 + 删除（等高 h-7 图标钮，与胶囊按钮对齐） */
function HeaderActions({
  testing,
  onTest,
  canDelete,
  onDelete,
  providerName,
}: {
  testing: boolean;
  onTest: () => void;
  canDelete: boolean;
  onDelete: () => void;
  providerName: string;
}) {
  return (
    <span className="ml-auto flex items-center gap-1.5">
      <Button variant="ghost" size="sm" className="h-7 px-2.5" disabled={testing} onClick={onTest}>
        {testing ? '测试中…' : '测试连通'}
      </Button>
      {canDelete && (
        <button
          type="button"
          title={`删除服务商 ${providerName}`}
          aria-label={`删除服务商 ${providerName}`}
          onClick={onDelete}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-wash hover:text-ink"
        >
          <IconTrash className="h-3.5 w-3.5" />
        </button>
      )}
    </span>
  );
}

/** 单个服务商编辑卡：mock（演示模式）只读展示 */
function ProviderCard({
  provider,
  onSaved,
  onDeleted,
}: {
  provider: ProviderSettingsItem;
  onSaved: (p: ProviderSettingsItem) => void;
  onDeleted: (id: string) => void;
}) {
  const showToast = useUiStore((s) => s.showToast);
  const showConfirm = useUiStore((s) => s.showConfirm);
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [chatModel, setChatModel] = useState(provider.chatModel ?? '');
  const [imageModel, setImageModel] = useState(provider.imageModel ?? '');
  const [embeddingModel, setEmbeddingModel] = useState(provider.embeddingModel ?? '');
  const [models, setModels] = useState<ModelInfo[]>(provider.models);
  const [newModelId, setNewModelId] = useState('');
  const [newModelKinds, setNewModelKinds] = useState<ModelKind[]>(['chat']);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<{ testing: boolean; result?: TestProviderResult }>({
    testing: false,
  });

  /** 保存成功返回新视图 / 全局刷新时同步草稿 */
  useEffect(() => {
    setName(provider.name);
    setBaseUrl(provider.baseUrl);
    setApiKey('');
    setChatModel(provider.chatModel ?? '');
    setImageModel(provider.imageModel ?? '');
    setEmbeddingModel(provider.embeddingModel ?? '');
    setModels(provider.models);
  }, [provider]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const patch: ProviderPatch = {
        name,
        baseUrl,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        chatModel: chatModel || null,
        imageModel: imageModel || null,
        embeddingModel: embeddingModel || null,
        models,
      };
      const updated = await updateProvider(provider.id, patch);
      onSaved(updated);
      void useSettingsStore.getState().refetch(); // 全局模型下拉即时刷新
      showToast('已保存，配置即时生效');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const onTest = async () => {
    if (test.testing) return;
    setTest({ testing: true });
    const result = await testProvider(provider.id);
    setTest({ testing: false, result });
  };

  const onDelete = async () => {
    if (
      !(await showConfirm({
        title: `删除服务商「${provider.name}」`,
        message: '删除后使用该服务商的节点将无法继续调用。',
        confirmLabel: '删除',
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await deleteProvider(provider.id);
      onDeleted(provider.id);
      void useSettingsStore.getState().refetch();
      showToast('已删除服务商');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '删除失败');
    }
  };

  const addModel = () => {
    const id = newModelId.trim();
    if (!id || models.some((m) => m.id === id)) return;
    setModels([...models, { id, name: id, kind: newModelKinds.length > 0 ? newModelKinds : ['chat'] }]);
    setNewModelId('');
  };

  /** 模型下拉选项：按能力过滤 + 清除项 */
  const defaultOptions = (kind: ModelKind) => [
    { value: '', label: '（未设置）' },
    ...models.filter((m) => m.kind.includes(kind)).map((m) => ({ value: m.id, label: m.id })),
  ];

  return (
    <section className="rounded-2xl border border-line bg-panel p-5">
      {/* 卡头：名称 / id / 密钥状态 / 测试 / 删除 */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={30}
          aria-label="服务商名称"
          className="-ml-1.5 w-40 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm font-semibold text-ink outline-none transition-colors hover:border-line focus:border-ink-muted"
        />
        {provider.id === 'mock' ? (
          <StatusPill
            tone="on"
            label="演示模式"
            title="mock 服务商无需任何密钥，始终可用"
          />
        ) : provider.apiKeyMasked ? (
          <StatusPill tone="on" label="已配置密钥" title={`已配置密钥：${provider.apiKeyMasked}`} />
        ) : (
          <StatusPill tone="off" label="未配置密钥" />
        )}
        <span className="rounded-md bg-wash px-1.5 py-1 font-mono text-[10px] leading-none text-ink-muted">
          {provider.id}
        </span>
        <HeaderActions
          testing={test.testing}
          onTest={() => void onTest()}
          canDelete={!provider.builtin}
          onDelete={() => void onDelete()}
          providerName={provider.name}
        />
      </div>

      {/* 连通性测试结果：内联状态条（成功 ✓ + 延迟 / 失败 ✗ + 原因） */}
      {test.result && (
        <div
          className={`mt-3 flex items-center gap-2 rounded-lg border border-line bg-base px-3 py-2 text-[11px] ${
            test.result.ok ? 'text-ink' : 'text-ink-muted'
          }`}
        >
          {test.result.ok ? (
            <IconCheck className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <IconX className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">
            {test.result.ok
              ? `连接正常 · 延迟 ${test.result.latencyMs ?? '—'}ms`
              : `连接失败：${test.result.error ?? '未知错误'}`}
          </span>
        </div>
      )}

      {/* mock 只读：仅展示模型清单 */}
      {provider.id === 'mock' ? (
        <div className="mt-4">
          <p className="text-[11px] font-medium leading-none text-ink-muted">
            模型清单 · {models.length}
          </p>
          <ul className="mt-2 space-y-1.5">
            {models.map((m) => (
              <li
                key={m.id}
                className="flex items-center gap-2 rounded-lg border border-line bg-base px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-xs text-ink">{m.name}</span>
                <span className="flex shrink-0 gap-1">
                  {m.kind.map((kind) => (
                    <span key={kind} className={`${KIND_BADGE} ${KIND_META[kind].cls}`}>
                      {KIND_META[kind].label}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          {/* 连接与密钥 + 默认模型（同一栅格：标签列 w-16 右对齐） */}
          <div className="mt-4 space-y-2.5">
            <FieldRow label="API Key">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={provider.apiKeyMasked ?? '未配置，输入以设置'}
                autoComplete="off"
                className={FIELD}
              />
            </FieldRow>
            <FieldRow label="Base URL">
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://…（OpenAI 兼容地址）"
                className={FIELD}
              />
            </FieldRow>
            {(['chat', 'image', 'embedding'] as ModelKind[]).map((kind) =>
              models.some((m) => m.kind.includes(kind)) ? (
                <FieldRow key={kind} label={`默认${KIND_META[kind].label}`}>
                  <Select
                    ariaLabel={`默认${KIND_META[kind].label}模型`}
                    value={kind === 'chat' ? chatModel : kind === 'image' ? imageModel : embeddingModel}
                    options={defaultOptions(kind)}
                    onChange={(v) =>
                      kind === 'chat'
                        ? setChatModel(v)
                        : kind === 'image'
                          ? setImageModel(v)
                          : setEmbeddingModel(v)
                    }
                    triggerClassName={FIELD}
                  />
                </FieldRow>
              ) : null
            )}
          </div>

          {/* 模型清单：行内编辑 id + 能力切换 + 移除 */}
          <div className="mt-4">
            <p className="text-[11px] font-medium leading-none text-ink-muted">
              模型清单 · {models.length}
            </p>
            {models.length === 0 ? (
              <p className="mt-2 rounded-lg border border-dashed border-line px-3 py-2 text-[11px] text-ink-muted">
                暂无模型，请在下方输入 id 添加
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {models.map((m, i) => (
                  <li
                    key={m.id}
                    className="flex items-center gap-2 rounded-lg border border-line bg-base px-2 py-1.5"
                  >
                    <input
                      value={m.id}
                      onChange={(e) =>
                        setModels(models.map((x, xi) => (xi === i ? { ...x, id: e.target.value } : x)))
                      }
                      aria-label="模型 id"
                      className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-xs text-ink outline-none transition-colors hover:border-line focus:border-ink-muted"
                    />
                    <KindChips
                      value={m.kind}
                      onChange={(kinds) =>
                        setModels(
                          models.map((x, xi) =>
                            xi === i
                              ? { ...x, kind: kinds.length > 0 ? kinds : x.kind }
                              : x
                          )
                        )
                      }
                    />
                    <button
                      type="button"
                      title="移除模型"
                      aria-label={`移除模型 ${m.id}`}
                      onClick={() => setModels(models.filter((_, xi) => xi !== i))}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-wash hover:text-ink"
                    >
                      <IconTrash className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* 新增模型：输入 + 能力 + 添加（与清单行同高对齐） */}
            <div className="mt-1.5 flex items-center gap-2">
              <input
                value={newModelId}
                onChange={(e) => setNewModelId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addModel();
                }}
                placeholder="新模型 id（Enter 添加）"
                className={FIELD}
              />
              <KindChips value={newModelKinds} onChange={setNewModelKinds} />
              <button
                type="button"
                onClick={addModel}
                title="添加模型"
                aria-label="添加模型"
                className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg bg-wash text-ink-muted transition-colors hover:bg-wash-strong hover:text-ink"
              >
                <IconPlus className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* 保存：发丝线分隔，主操作靠右 */}
          <div className="mt-5 flex items-center justify-end border-t border-line pt-3.5">
            <Button variant="mono" size="sm" disabled={saving} onClick={() => void save()}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

/** 新建自定义服务商卡（OpenAI 兼容接入） */
function CreateCard({ onCreated }: { onCreated: (p: ProviderSettingsItem) => void }) {
  const showToast = useUiStore((s) => s.showToast);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [modelId, setModelId] = useState('');
  const [modelKinds, setModelKinds] = useState<ModelKind[]>(['chat']);
  const [creating, setCreating] = useState(false);

  const create = async () => {
    if (creating) return;
    if (!name.trim() || !baseUrl.trim()) {
      showToast('名称与 Base URL 为必填项');
      return;
    }
    setCreating(true);
    try {
      const models: ModelInfo[] = modelId.trim()
        ? [{ id: modelId.trim(), name: modelId.trim(), kind: modelKinds.length > 0 ? modelKinds : ['chat'] }]
        : [];
      const created = await createProvider({ name, baseUrl, apiKey: apiKey.trim() || undefined, models });
      onCreated(created);
      void useSettingsStore.getState().refetch();
      setOpen(false);
      setName('');
      setBaseUrl('');
      setApiKey('');
      setModelId('');
      showToast('已新建服务商');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '新建失败');
    } finally {
      setCreating(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line bg-panel px-4 py-4 text-sm text-ink-muted transition-colors hover:border-ink-muted hover:text-ink"
      >
        <IconPlus className="h-4 w-4" />
        新建自定义服务商（OpenAI 兼容）
      </button>
    );
  }
  return (
    <section className="rounded-2xl border border-line bg-panel p-5">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-ink">新建自定义服务商</h3>
        <span className="rounded-md bg-wash px-1.5 py-1 font-mono text-[10px] leading-none text-ink-muted">
          OpenAI 兼容
        </span>
        <span className="ml-auto">
          <Button variant="ghost" size="sm" className="h-7 px-2.5" onClick={() => setOpen(false)}>
            取消
          </Button>
        </span>
      </div>
      <div className="mt-4 space-y-2.5">
        <FieldRow label="名称">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={30}
            placeholder="例如 SiliconFlow"
            className={FIELD}
            autoFocus
          />
        </FieldRow>
        <FieldRow label="Base URL">
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://…（OpenAI 兼容地址）"
            className={FIELD}
          />
        </FieldRow>
        <FieldRow label="API Key">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="可稍后在卡片中填写"
            autoComplete="off"
            className={FIELD}
          />
        </FieldRow>
        <FieldRow label="首个模型">
          <input
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            placeholder="模型 id（可留空稍后添加）"
            className={FIELD}
          />
          <KindChips value={modelKinds} onChange={setModelKinds} />
        </FieldRow>
      </div>
      <div className="mt-5 flex items-center justify-end border-t border-line pt-3.5">
        <Button variant="mono" size="sm" disabled={creating} onClick={() => void create()}>
          {creating ? '创建中…' : '创建'}
        </Button>
      </div>
    </section>
  );
}

export function SettingsPage() {
  const [items, setItems] = useState<ProviderSettingsItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setItems(await fetchProviderSettings());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-base text-ink">
      <ProjectSidebar />
      <main className="no-scrollbar min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-10">
          {/* 页头：与知识库页同款图标瓦片 + 标题副标 */}
          <header className="flex items-center gap-3.5 border-b border-line pb-6">
            <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-line bg-wash-strong">
              <IconSettings className="h-6 w-6 text-ink" />
            </span>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold leading-tight text-ink">设置</h1>
              <p className="mt-0.5 text-xs text-ink-muted">
                模型服务商管理 · 修改保存后即时生效（API Key 仅存于服务端本地文件）
              </p>
            </div>
          </header>

          {items === null && !error && (
            <div className="mt-6 space-y-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-36 animate-pulse rounded-2xl border border-line bg-panel" />
              ))}
            </div>
          )}
          {error && (
            <div className="mt-6 flex flex-col items-center gap-3 rounded-2xl border border-line bg-panel px-4 py-10 text-center">
              <p className="text-xs text-ink-muted">设置加载失败：{error}</p>
              <Button variant="secondary" size="sm" onClick={() => void load()}>
                重试
              </Button>
            </div>
          )}
          {items && (
            <>
              <p className="mb-3 mt-6 text-xs font-medium text-ink-muted">
                模型服务商 · {items.length}
              </p>
              <div className="space-y-4">
                {items.map((p) => (
                  <ProviderCard
                    key={p.id}
                    provider={p}
                    onSaved={(updated) =>
                      setItems((cur) => cur?.map((x) => (x.id === updated.id ? updated : x)) ?? null)
                    }
                    onDeleted={(id) => setItems((cur) => cur?.filter((x) => x.id !== id) ?? null)}
                  />
                ))}
                <CreateCard
                  onCreated={(created) => setItems((cur) => [...(cur ?? []), created])}
                />
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
