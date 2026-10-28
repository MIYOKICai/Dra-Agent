/**
 * 文件上传节点：拖入或点击上传 PDF / Word / TXT / 图片。
 * - config.files 只存 FileMeta 元信息（localStorage 友好），正文 / 原图按 id 从服务端按需拉取
 * - 客户端预生成 id（服务端沿用），上传期间在列表尾部显示 optimistic pending 项
 * - 图片在本会话内用 objectURL 显示缩略图（刷新后回退为图标，原图运行时才拉取）
 * - 运行时（executor）：文档输出提取文本，图片输出原图 dataURL，供下游 {{节点名}} 引用
 */
import { memo, useEffect, useRef, useState, type DragEvent } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { FileMeta } from '@shared/types';
import { NodeShell } from './NodeShell';
import { readFileConfig } from './nodeConfigs';
import { deleteNodeFile, uploadNodeFile } from '../api/gateway';
import { useCanvasStore, type CanvasNode } from '../store/canvasStore';
import { useUiStore } from '../store/uiStore';
import {
  IconFileText,
  IconImage,
  IconLoader,
  IconTrash,
  IconUpload,
} from '../components/icons';

/** 单文件大小上限（与 server /api/files 一致） */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** 扩展名 → kind（与 server files.ts 的 detectKind 口径一致） */
function detectKind(name: string): FileMeta['kind'] | null {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.doc') return 'doc';
  if (ext === '.docx') return 'docx';
  if (ext === '.txt' || ext === '.md' || ext === '.markdown') return 'txt';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico'].includes(ext)) {
    return 'image';
  }
  return null;
}

/** kind 徽标文案 */
const KIND_LABELS: Record<FileMeta['kind'], string> = {
  pdf: 'PDF',
  doc: 'DOC',
  docx: 'DOCX',
  txt: 'TXT',
  image: 'IMG',
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function FileNodeInner({ id, data, selected }: NodeProps<CanvasNode>) {
  const config = readFileConfig(data.config);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 本会话内图片 objectURL（key = FileMeta.id）；刷新后丢失，回退为图标 */
  const urlsRef = useRef(new Map<string, string>());
  const [dragOver, setDragOver] = useState(false);

  /** 卸载时回收全部缩略图 objectURL */
  useEffect(() => {
    const urls = urlsRef.current;
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  /** 基于最新 store 状态更新 files（异步回包不覆盖并发修改） */
  const patchFiles = (updater: (files: FileMeta[]) => FileMeta[]): void => {
    const { nodes, updateNodeConfig } = useCanvasStore.getState();
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    updateNodeConfig(id, { files: updater(readFileConfig(node.data.config).files) });
  };

  const handleFiles = async (list: FileList | File[]): Promise<void> => {
    for (const file of Array.from(list)) {
      const kind = detectKind(file.name);
      if (!kind) {
        useUiStore.getState().showToast(`「${file.name}」格式不支持：仅支持 PDF / Word / TXT / 图片`);
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        useUiStore.getState().showToast(`「${file.name}」超过 20MB 上限`);
        continue;
      }
      // 客户端预生成 id → optimistic 占位 → 上传（服务端沿用同一 id）
      const fid = crypto.randomUUID();
      if (kind === 'image') {
        try {
          urlsRef.current.set(fid, URL.createObjectURL(file));
        } catch {
          // objectURL 创建失败不阻塞上传，回退为图标
        }
      }
      patchFiles((fs) => [
        ...fs,
        { id: fid, name: file.name, size: file.size, kind, extract: 'pending' },
      ]);
      try {
        const meta = await uploadNodeFile(file, fid);
        patchFiles((fs) => fs.map((f) => (f.id === fid ? meta : f)));
      } catch (err) {
        // 上传失败：移除占位项并回收缩略图
        const url = urlsRef.current.get(fid);
        if (url) {
          URL.revokeObjectURL(url);
          urlsRef.current.delete(fid);
        }
        patchFiles((fs) => fs.filter((f) => f.id !== fid));
        useUiStore.getState().showToast(`「${file.name}」上传失败：${errorMessage(err)}`);
      }
    }
  };

  const removeFile = (meta: FileMeta): void => {
    patchFiles((fs) => fs.filter((f) => f.id !== meta.id));
    const url = urlsRef.current.get(meta.id);
    if (url) {
      URL.revokeObjectURL(url);
      urlsRef.current.delete(meta.id);
    }
    // 服务端清理静默失败（文件可能已不存在）
    void deleteNodeFile(meta.id);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) void handleFiles(e.dataTransfer.files);
  };

  return (
    <NodeShell id={id} data={data} selected={selected}>
      <div className="space-y-1.5 px-2.5 pb-2.5 pt-1.5">
        {/* 拖放区：虚线框，dragover 高亮 */}
        <div
          role="button"
          tabIndex={0}
          className={`nodrag nowheel flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed px-3 py-3 transition-colors ${
            dragOver
              ? 'border-ink bg-wash-strong'
              : 'border-line bg-base hover:border-ink-muted hover:bg-wash-faint'
          }`}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOver(true);
          }}
          onDragEnter={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOver(true);
          }}
          onDragLeave={(e) => {
            // 仅当指针真正离开拖放区（而非移入子元素）时取消高亮
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
          }}
          onDrop={onDrop}
        >
          <IconUpload className="h-4 w-4 text-ink-muted" />
          <span className="text-[11px] leading-none text-ink">拖入文件，或点击上传</span>
          <span className="text-[9px] leading-none text-ink-muted">
            PDF · Word · TXT · 图片（≤20MB）
          </span>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.doc,.docx,.txt,.md,image/*"
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) void handleFiles(e.target.files);
            e.target.value = '';
          }}
        />

        {/* 文件列表 */}
        {config.files.length > 0 && (
          <ul className="nowheel no-scrollbar max-h-36 space-y-1 overflow-y-auto">
            {config.files.map((f) => {
              const thumb = f.kind === 'image' ? urlsRef.current.get(f.id) : undefined;
              return (
                <li
                  key={f.id}
                  className="flex items-center gap-1.5 rounded-lg border border-line bg-base px-1.5 py-1"
                >
                  {/* 缩略图 / 类型图标 */}
                  {thumb ? (
                    <img
                      src={thumb}
                      alt={f.name}
                      className="nodrag h-7 w-7 shrink-0 rounded-md border border-line object-cover"
                    />
                  ) : f.kind === 'image' ? (
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-elevated">
                      <IconImage className="h-3.5 w-3.5 text-ink-muted" />
                    </span>
                  ) : (
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-elevated">
                      <IconFileText className="h-3.5 w-3.5 text-ink-muted" />
                    </span>
                  )}

                  {/* 名称 + 元信息 */}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] leading-tight text-ink" title={f.name}>
                      {f.name}
                    </p>
                    <p className="flex items-center gap-1 text-[9px] leading-tight text-ink-muted">
                      <span className="rounded bg-wash-strong px-1 font-mono">{KIND_LABELS[f.kind]}</span>
                      <span>{formatBytes(f.size)}</span>
                      {f.extract === 'failed' && (
                        <span title={f.extractError ?? '解析失败'} className="text-ink">
                          解析失败
                        </span>
                      )}
                    </p>
                  </div>

                  {/* 状态 / 删除 */}
                  {f.extract === 'pending' ? (
                    <IconLoader className="h-3.5 w-3.5 shrink-0 animate-spin text-ink-muted" />
                  ) : (
                    <button
                      type="button"
                      className="nodrag flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-muted opacity-0 transition-opacity hover:bg-wash hover:text-ink focus:opacity-100 group-hover:opacity-100"
                      title="删除文件"
                      onClick={() => removeFile(f)}
                    >
                      <IconTrash className="h-3 w-3" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* 引用提示 */}
        <p className="text-[10px] leading-snug text-ink-muted">
          运行时输出解析文本 / 图片，作为{' '}
          <code className="rounded bg-elevated px-1 font-mono text-ink">{`{{${data.label}}}`}</code>{' '}
          供下游引用
        </p>
      </div>
    </NodeShell>
  );
}

export const FileNode = memo(FileNodeInner);
