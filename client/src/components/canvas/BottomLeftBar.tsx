/**
 * 左下浮动控件：功能胶囊 [模式 | 主题 | 更多]。
 * 更多下拉含 导入 JSON / 导出 JSON / 清空画布。
 * 导入 / 导出 / 清空逻辑自旧 Toolbar 迁入，行为保持一致。
 * （原位于右上角，现与缩放胶囊对调位置；更多菜单改为向上弹出并左对齐）
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { WorkflowJSON } from '@shared/types';
import {
  validateWorkflowJSON,
  DEFAULT_WORKFLOW_NAME,
  useCanvasStore,
} from '../../store/canvasStore';
import { useUiStore } from '../../store/uiStore';
import {
  IconCursor,
  IconDownload,
  IconMoon,
  IconMore,
  IconMove,
  IconSun,
  IconTrash,
  IconUpload,
} from '../icons';

export function BottomLeftBar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showToast = useUiStore((s) => s.showToast);
  const showConfirm = useUiStore((s) => s.showConfirm);
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  /** 画布交互模式：drag=拖动平移（默认）/ select=左键框选 */
  const canvasMode = useUiStore((s) => s.canvasMode);
  const setCanvasMode = useUiStore((s) => s.setCanvasMode);

  /** 更多菜单：点击外部 / Esc 关闭 */
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const onImportClick = () => {
    setMenuOpen(false);
    fileInputRef.current?.click();
  };

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // 重置 input，保证同一文件可重复导入
    event.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      const error = validateWorkflowJSON(parsed);
      if (error) {
        showToast(`导入失败：${error}`);
        return;
      }
      useCanvasStore.getState().loadWorkflow(parsed as WorkflowJSON);
      showToast(`已导入「${(parsed as WorkflowJSON).name || DEFAULT_WORKFLOW_NAME}」`);
    } catch {
      showToast('导入失败：无法解析 JSON 文件');
    }
  };

  const onExport = () => {
    setMenuOpen(false);
    const json = useCanvasStore.getState().exportWorkflow();
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${json.name || DEFAULT_WORKFLOW_NAME}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    showToast('已导出工作流 JSON');
  };

  const onClear = async () => {
    setMenuOpen(false);
    if (
      !(await showConfirm({
        title: '清空画布',
        message: '所有节点与连线将被移除，且无法撤销。',
        confirmLabel: '清空',
        danger: true,
      }))
    ) {
      return;
    }
    useCanvasStore.getState().clearAll();
    showToast('画布已清空');
  };

  const iconBtn =
    'flex h-9 w-9 shrink-0 items-center justify-center rounded-8 text-ink-muted transition-colors hover:bg-wash hover:text-ink';

  /** 模式按钮：激活态不挂基础 hover 类（同特异性下 hover:bg-wash 会排在 hover:bg-mono 后致选中色被洗淡） */
  const modeBtn = (active: boolean) =>
    active
      ? 'flex h-9 w-9 shrink-0 items-center justify-center rounded-8 bg-mono text-mono-fg transition-colors'
      : iconBtn;

  return (
    <div className="absolute bottom-4 left-4 z-10 flex items-center gap-2">
      {/* 功能胶囊 */}
      <div className="flex h-11 items-center gap-0.5 rounded-xl border border-line bg-panel p-1 shadow-lg shadow-black/40 backdrop-blur">
        <button
          type="button"
          className={modeBtn(canvasMode === 'select')}
          onClick={() => setCanvasMode('select')}
          title="选择模式：左键拖拽框选节点"
        >
          <IconCursor className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={modeBtn(canvasMode === 'drag')}
          onClick={() => setCanvasMode('drag')}
          title="拖动模式：左键拖拽移动画布"
        >
          <IconMove className="h-4 w-4" />
        </button>
        <span className="h-4 w-px bg-line" />
        <button
          type="button"
          className={iconBtn}
          onClick={toggleTheme}
          title="切换黑白主题"
        >
          {theme === 'dark' ? <IconSun className="h-4 w-4" /> : <IconMoon className="h-4 w-4" />}
        </button>
        <div ref={menuRef} className="relative">
          <button
            type="button"
            className={`${iconBtn} ${menuOpen ? 'bg-wash-strong text-ink' : ''}`}
            onClick={() => setMenuOpen((v) => !v)}
            title="更多操作"
          >
            <IconMore className="h-4 w-4" />
          </button>

          {menuOpen && (
            <div className="absolute bottom-full left-0 mb-2 w-44 rounded-xl border border-line bg-elevated p-1 shadow-xl shadow-black/50">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-8 px-2.5 py-2 text-left text-xs text-ink transition-colors hover:bg-wash"
                onClick={onImportClick}
              >
                <IconUpload className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                导入 JSON
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-8 px-2.5 py-2 text-left text-xs text-ink transition-colors hover:bg-wash"
                onClick={onExport}
              >
                <IconDownload className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                导出 JSON
              </button>
              <div className="my-1 h-px bg-line" />
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-8 px-2.5 py-2 text-left text-xs text-ink-muted transition-colors hover:bg-wash-strong hover:text-ink"
                onClick={() => void onClear()}
              >
                <IconTrash className="h-3.5 w-3.5 shrink-0" />
                清空画布
              </button>
            </div>
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={onFileChange}
      />
    </div>
  );
}
