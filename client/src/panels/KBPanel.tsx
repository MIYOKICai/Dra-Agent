/**
 * 知识库管理面板：Toolbar「📚 知识库」按钮打开的右侧 360px 抽屉，
 * 固定在画布右上（right-4，画布无右侧常驻面板），可关闭。
 * 功能：列表（模式徽标 向量/关键词）/ 新建 / 删除 / 展开文档列表 /
 * 上传 .txt/.md（FileReader 语义读文本，逐个 addDocument）/ 删除文档 / 重建向量。
 * 全部操作经 guard() 统一处理 busy 状态、refetch 与 toast 反馈。
 */
import { useRef, useState, type ChangeEvent } from 'react';
import type { KBInfoEx } from '@shared/types';
import { addDocument, createKB, deleteDocument, deleteKB, rebuildKB } from '../api/gateway';
import { useKBStore } from '../store/kbStore';
import { useUiStore } from '../store/uiStore';
import { Button } from '../components/ui/Button';

const inputCls =
  'w-full rounded-base border border-line bg-base px-2 py-1.5 text-xs text-ink outline-none transition-colors focus:border-ink-muted';

/** 单个文档 / 请求体上限（与 server 端校验一致） */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function KBPanel() {
  const open = useKBStore((s) => s.panelOpen);
  const setPanelOpen = useKBStore((s) => s.setPanelOpen);
  const kbs = useKBStore((s) => s.kbs);
  const loading = useKBStore((s) => s.loading);
  const error = useKBStore((s) => s.error);
  const refetch = useKBStore((s) => s.refetch);
  const showToast = useUiStore((s) => s.showToast);
  const showConfirm = useUiStore((s) => s.showConfirm);

  const [newName, setNewName] = useState('');
  const [chunkSize, setChunkSize] = useState(500);
  const [chunkOverlap, setChunkOverlap] = useState(50);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<string | null>(null);

  /** 统一操作包装：busy 互斥 → 执行 → refetch → toast（成功/失败） */
  const guard = async (action: () => Promise<string>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const message = await action();
      await refetch();
      showToast(message);
    } catch (err) {
      showToast(`操作失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const onCreate = () =>
    guard(async () => {
      const kb = await createKB({
        name: newName.trim(),
        chunkSize,
        chunkOverlap,
      });
      setNewName('');
      setExpandedId(kb.id);
      return `已创建知识库「${kb.name}」`;
    });

  const onDeleteKB = async (kb: KBInfoEx) => {
    if (
      !(await showConfirm({
        title: '删除知识库',
        message: `「${kb.name}」的全部文档与索引将被移除，无法恢复。`,
        confirmLabel: '删除',
        danger: true,
      }))
    ) {
      return;
    }
    void guard(async () => {
      await deleteKB(kb.id);
      if (expandedId === kb.id) setExpandedId(null);
      return `已删除知识库「${kb.name}」`;
    });
  };

  const onRebuild = (kb: KBInfoEx) =>
    guard(async () => {
      const updated = await rebuildKB(kb.id);
      return `已重建「${updated.name}」向量：${updated.mode === 'vector' ? '向量' : '关键词'}模式，${updated.chunkCount} 块`;
    });

  const onUploadClick = (kbId: string) => {
    uploadTargetRef.current = kbId;
    fileInputRef.current?.click();
  };

  const onFilesChange = (event: ChangeEvent<HTMLInputElement>) => {
    const kbId = uploadTargetRef.current;
    const files = Array.from(event.target.files ?? []);
    event.target.value = ''; // 重置 input，保证同一文件可重复选择
    uploadTargetRef.current = null;
    if (!kbId || files.length === 0) return;
    void guard(async () => {
      let okCount = 0;
      for (const file of files) {
        if (file.size > MAX_FILE_BYTES) {
          showToast(`「${file.name}」超过 2MB，已跳过`);
          continue;
        }
        const content = await file.text();
        if (!content.trim()) {
          showToast(`「${file.name}」内容为空，已跳过`);
          continue;
        }
        const docName = file.name.replace(/\.(txt|md)$/i, '') || file.name;
        await addDocument(kbId, { name: docName, content });
        okCount += 1;
      }
      return okCount > 0 ? `已上传 ${okCount} 个文档` : '没有文档被上传';
    });
  };

  const onDeleteDoc = async (kb: KBInfoEx, docId: string, docName: string) => {
    if (
      !(await showConfirm({
        title: '删除文档',
        message: `确定删除「${docName}」？`,
        confirmLabel: '删除',
        danger: true,
      }))
    ) {
      return;
    }
    void guard(async () => {
      await deleteDocument(kb.id, docId);
      return `已删除文档「${docName}」`;
    });
  };

  if (!open) return null;

  return (
    <aside className="fixed bottom-16 right-4 top-16 z-30 flex w-[360px] animate-slide-in-right flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl">
      {/* 头部 */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="text-sm font-semibold">📚 知识库</h2>
        <Button variant="ghost" size="sm" className="!rounded-2" onClick={() => setPanelOpen(false)} title="关闭面板">
          ✕ 关闭
        </Button>
      </div>

      {/* 新建表单 */}
      <div className="shrink-0 border-b border-line p-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          新建知识库
        </h3>
        <input
          className={`mt-2 ${inputCls}`}
          placeholder="知识库名称，例如：产品文档库"
          value={newName}
          maxLength={50}
          onChange={(e) => setNewName(e.target.value)}
        />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="text-[11px] text-ink-muted">
            分块大小（100~2000）
            <input
              type="number"
              className={`mt-1 ${inputCls}`}
              value={chunkSize}
              min={100}
              max={2000}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isNaN(n)) setChunkSize(Math.min(2000, Math.max(100, Math.round(n))));
              }}
            />
          </label>
          <label className="text-[11px] text-ink-muted">
            分块重叠（0~200）
            <input
              type="number"
              className={`mt-1 ${inputCls}`}
              value={chunkOverlap}
              min={0}
              max={200}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isNaN(n)) setChunkOverlap(Math.min(200, Math.max(0, Math.round(n))));
              }}
            />
          </label>
        </div>
        <Button
          variant={busy || !newName.trim() ? 'secondary' : 'mono'}
          size="sm"
          className="mt-2 w-full"
          disabled={busy || !newName.trim()}
          onClick={onCreate}
        >
          ＋ 创建知识库
        </Button>
      </div>

      {/* 列表 */}
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
        {error && (
          <p className="mb-2 rounded-base border border-line bg-wash px-2 py-1.5 text-[11px] text-ink-muted">
            {error}
          </p>
        )}
        {loading && <p className="text-xs text-ink-muted">加载中…</p>}
        {!loading && kbs.length === 0 && !error && (
          <p className="rounded-base border border-dashed border-line px-3 py-4 text-center text-[11px] leading-relaxed text-ink-muted">
            暂无知识库，先在上方创建一个，再上传 .txt / .md 文档
          </p>
        )}
        {kbs.map((kb) => {
          const expanded = expandedId === kb.id;
          return (
            <div key={kb.id} className="mb-2 rounded-base border border-line bg-elevated">
              <div className="flex items-center gap-2 p-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-xs font-medium hover:text-ink"
                  title={expanded ? '收起文档列表' : '展开文档列表'}
                  onClick={() => setExpandedId(expanded ? null : kb.id)}
                >
                  {expanded ? '▾' : '▸'} {kb.name}
                </button>
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] leading-none ${
                    kb.mode === 'vector' ? 'bg-wash-strong text-ink' : 'bg-wash text-ink-muted'
                  }`}
                  title={
                    kb.mode === 'vector' ? '向量相似度检索' : '关键词（bigram）重合度检索'
                  }
                >
                  {kb.mode === 'vector' ? '向量' : '关键词'}
                </span>
              </div>
              <div className="px-2 pb-2 text-[11px] leading-relaxed text-ink-muted">
                文档 {kb.docCount} · 分块 {kb.chunkCount} · 切片 {kb.chunkSize}/{kb.chunkOverlap}
              </div>

              {expanded && (
                <div className="border-t border-line p-2">
                  {kb.documents.length === 0 && (
                    <p className="py-1 text-[11px] text-ink-muted">暂无文档，点击下方按钮上传</p>
                  )}
                  {kb.documents.map((doc) => (
                    <div
                      key={doc.id}
                      className="flex items-center gap-2 rounded px-1 py-1 hover:bg-base"
                    >
                      <span className="min-w-0 flex-1 truncate text-[11px]" title={doc.name}>
                        📄 {doc.name}
                      </span>
                      <span className="shrink-0 text-[10px] text-ink-muted">
                        {doc.chunkCount} 块
                      </span>
                      <button
                        type="button"
                        className="shrink-0 text-[10px] text-ink-muted transition-colors hover:text-ink"
                        title="删除该文档"
                        disabled={busy}
                        onClick={() => void onDeleteDoc(kb, doc.id, doc.name)}
                      >
                        删除
                      </button>
                    </div>
                  ))}
                  <div className="mt-2 flex items-center gap-1.5">
                    <Button variant="secondary" size="sm" className="!rounded-2" disabled={busy} onClick={() => onUploadClick(kb.id)}>
                      ⬆ 上传 .txt/.md
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="!rounded-2"
                      disabled={busy}
                      onClick={() => onRebuild(kb)}
                      title="用当前可用的向量化服务商重算全部片段向量"
                    >
                      ⟳ 重建向量
                    </Button>
                    <span className="flex-1" />
                    <Button variant="danger" size="sm" className="!rounded-2" disabled={busy} onClick={() => void onDeleteKB(kb)}>
                      删除库
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.md,text/plain,text/markdown"
        multiple
        className="hidden"
        onChange={onFilesChange}
      />
    </aside>
  );
}
