/**
 * 右下主强调按钮：运行 / 取消 + 拓扑序执行进度（自左下运行胶囊迁入模板中心原位）。
 * 进度口径与旧 Toolbar 一致：终态节点数 / 全部节点数。
 */
import { useCallback } from 'react';
import type { NodeRunStatus } from '@shared/types';
import { useCanvasStore } from '../../store/canvasStore';
import { useRunStore } from '../../store/runStore';
import { IconPlay, IconSquare } from '../icons';

/** 已到达终态的节点状态（用于进度推导） */
const TERMINAL_STATUSES: ReadonlySet<NodeRunStatus> = new Set([
  'success',
  'error',
  'blocked',
  'skipped',
]);

export function BottomRightBar() {
  const nodes = useCanvasStore((s) => s.nodes);
  const isRunning = useRunStore((s) => s.isRunning);

  const nodeCount = nodes.length;
  /** 运行进度：终态节点数 / 全部节点数（简单口径，未按参与子图裁剪） */
  const doneCount = nodes.filter((n) => TERMINAL_STATUSES.has(n.data.status ?? 'idle')).length;

  const onRunClick = useCallback(() => {
    if (isRunning) {
      useRunStore.getState().cancelRun();
      return;
    }
    useRunStore.getState().startAll();
  }, [isRunning]);

  return (
    <div className="absolute bottom-4 right-4 z-10 flex h-11 items-center gap-2">
      {isRunning && (
        <span
          className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-muted"
          title="按拓扑序执行中"
        >
          <span className="h-2.5 w-2.5 animate-spin rounded-full border border-line border-t-ink" />
          {doneCount}/{nodeCount}
        </span>
      )}
      {/* 运行钮：独立钮，高度与左下缩放胶囊一致（h-11） */}
      <button
        type="button"
        disabled={!isRunning && nodeCount === 0}
        onClick={onRunClick}
        title={isRunning ? '取消本次运行' : nodeCount === 0 ? '画布为空，先添加节点' : '按拓扑序运行工作流'}
        className={`flex h-11 items-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          isRunning
            ? 'border border-line bg-panel text-ink hover:bg-wash'
            : 'bg-mono text-mono-fg shadow-lg shadow-black/40 hover:bg-mono-hover'
        }`}
      >
        {isRunning ? <IconSquare className="h-4 w-4" /> : <IconPlay className="h-4 w-4" />}
        {isRunning ? '取消' : '运行'}
      </button>
    </div>
  );
}
