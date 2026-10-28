/**
 * 左上浮动控件：SVG 徽标（唤起左侧画布抽屉）+ 项目胶囊（名称 + 展开箭头）
 * + 节点计数 / 已保存指示（zustand persist 实时落盘）。
 * 点击箭头弹出二级项目菜单：全部画布（缩略图 + 勾选，点击切换）+ 新建画布项目。
 */
import { useEffect, useRef, useState } from 'react';
import { useCanvasStore } from '../../store/canvasStore';
import { useUiStore } from '../../store/uiStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { CanvasThumb } from './CanvasThumb';
import { IconCheck, IconChevronDown, IconPlus, IconSparkles } from '../icons';

export function TopLeftBar() {
  const name = useCanvasStore((s) => s.name);
  const setName = useCanvasStore((s) => s.setName);
  const nodeCount = useCanvasStore((s) => s.nodes.length);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const showToast = useUiStore((s) => s.showToast);

  const canvases = useWorkspaceStore((s) => s.canvases);
  const activeId = useWorkspaceStore((s) => s.activeId);
  const switchCanvas = useWorkspaceStore((s) => s.switchCanvas);
  const createCanvas = useWorkspaceStore((s) => s.createCanvas);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  /** 点击外部或按 Esc 收起菜单 */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const onCreate = () => {
    createCanvas();
    setOpen(false);
    showToast('已新建空白画布');
  };

  const onSwitch = (id: string) => {
    switchCanvas(id);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="absolute left-4 top-4 z-30 flex items-center gap-2.5">
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          toggleSidebar();
        }}
        title="打开画布侧边栏"
        aria-label="打开画布侧边栏"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-mono text-mono-fg transition-transform hover:scale-105"
      >
        <IconSparkles className="h-4 w-4" />
      </button>

      <div className="relative">
        <div className="flex h-11 items-center rounded-xl border border-line bg-panel pl-3 pr-4 shadow-lg shadow-black/40 backdrop-blur">
          <input
            className="w-36 min-w-0 truncate rounded-md border border-transparent bg-transparent px-1 py-1 text-[15px] font-semibold text-ink outline-none transition-colors placeholder:text-ink-muted hover:border-line focus:border-ink-muted"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="未命名工作流"
            title="单击编辑工作流名称"
          />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={open ? '收起项目菜单' : '展开项目菜单'}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-wash hover:text-ink"
          >
            <IconChevronDown
              className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
            />
          </button>

          <div className="ml-4 flex items-center gap-2.5 text-xs text-ink-muted">
            <span className="whitespace-nowrap">节点 {nodeCount}</span>
            <span className="h-3 w-px bg-line" aria-hidden="true" />
            <span className="whitespace-nowrap" title="更改自动保存到本地">
              已保存
            </span>
          </div>
        </div>

        {open && (
          <div
            role="menu"
            aria-label="项目"
            className="absolute left-0 top-full mt-2 w-80 rounded-[20px] border border-line bg-panel p-2 shadow-2xl shadow-black/60"
          >
            <p className="px-3 pb-1.5 pt-2 text-[11px] tracking-[0.08em] text-ink-muted">项目</p>

            <div className="no-scrollbar max-h-64 space-y-0.5 overflow-y-auto">
              {canvases.map((item) => {
                const isActive = item.id === activeId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    onClick={() => onSwitch(item.id)}
                    className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors ${
                      isActive ? 'bg-wash-strong' : 'hover:bg-wash'
                    }`}
                  >
                    <CanvasThumb />
                    <span
                      className={`min-w-0 flex-1 truncate text-sm ${
                        isActive ? 'font-medium text-ink' : 'text-ink-muted'
                      }`}
                    >
                      {isActive ? name || '未命名工作流' : item.name}
                    </span>
                    {isActive && <IconCheck className="h-4 w-4 shrink-0 text-ink" />}
                  </button>
                );
              })}
            </div>

            <div className="mx-1 my-2 h-px bg-line" />

            <button
              type="button"
              role="menuitem"
              onClick={onCreate}
              className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-sm text-ink transition-colors hover:bg-wash"
            >
              新建画布项目
              <IconPlus className="h-4 w-4 text-ink-muted" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
