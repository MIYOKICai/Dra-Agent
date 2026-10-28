/**
 * 画布节点右键菜单：从此节点运行/重跑、删除节点。
 * 渲染为 fixed 覆盖层：点击空白处 / 再次右键 / Esc 关闭；运行中禁用运行项。
 */
import { useEffect } from 'react';
import { useCanvasStore } from '../store/canvasStore';
import { useRunStore } from '../store/runStore';
import { IconPlay, IconTrash } from './icons';

export interface NodeMenuState {
  x: number;
  y: number;
  nodeId: string;
}

interface NodeContextMenuProps {
  menu: NodeMenuState | null;
  onClose: () => void;
}

const itemBase = 'w-full rounded-md px-2.5 py-1.5 text-left text-xs transition-colors';

export function NodeContextMenu({ menu, onClose }: NodeContextMenuProps) {
  const isRunning = useRunStore((s) => s.isRunning);
  const node = useCanvasStore((s) => (menu ? s.nodes.find((n) => n.id === menu.nodeId) : undefined));

  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, onClose]);

  if (!menu || !node) return null;

  const runLabel = node.data.output ? '从此节点重跑' : '从此节点运行';

  return (
    // 全屏透明遮罩：点击空白处 / 右键空白处关闭
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        className="absolute min-w-[150px] rounded-base border border-line bg-elevated p-1 shadow-lg shadow-black/40"
        style={{ left: menu.x, top: menu.y }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          disabled={isRunning}
          title={isRunning ? '运行中，请先取消当前运行' : undefined}
          className={`${itemBase} flex items-center gap-1.5 ${
            isRunning ? 'cursor-not-allowed text-ink-muted' : 'text-ink hover:bg-wash-strong'
          }`}
          onClick={() => {
            onClose();
            useRunStore.getState().rerunFrom(menu.nodeId);
          }}
        >
          <IconPlay className="h-3 w-3 shrink-0" />
          {runLabel}
        </button>
        <button
          type="button"
          className={`${itemBase} flex items-center gap-1.5 text-ink hover:bg-wash-strong`}
          onClick={() => {
            onClose();
            useCanvasStore.getState().removeNode(menu.nodeId);
          }}
        >
          <IconTrash className="h-3 w-3 shrink-0" />
          删除节点
        </button>
      </div>
    </div>
  );
}
