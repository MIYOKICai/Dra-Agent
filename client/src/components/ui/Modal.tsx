/**
 * 全局统一弹窗体系：
 * - Modal：遮罩 + 居中面板 + 标题栏（✕ 关闭），Esc / 点击遮罩关闭；
 *   Portal 挂 body，z-[80] 高于全屏编辑器与下拉浮层（z-[70]）；
 *   样式沿用画布令牌（border-line / bg-panel / rounded-xl / modal-in 动效）。
 * - ConfirmHost：uiStore.showConfirm() 的全局宿主（App 挂载一次），
 *   替代原生 window.confirm 的统一确认弹窗（取消 = ghost，确认 = mono 主按钮）。
 */
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useUiStore } from '../../store/uiStore';
import { Button } from './Button';

export function Modal({
  open,
  onClose,
  title,
  width = 'max-w-md',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** 面板宽度类（默认 max-w-md） */
  width?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex animate-fade-in items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={typeof title === 'string' ? title : '对话框'}
        className={`flex max-h-[85vh] w-full ${width} animate-modal-in flex-col rounded-xl border border-line bg-panel shadow-2xl shadow-black/50`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-line pl-4 pr-2">
          <h2 className="min-w-0 truncate text-sm font-semibold text-ink">{title}</h2>
          <button
            type="button"
            title="关闭（Esc）"
            aria-label="关闭"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-wash hover:text-ink"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body
  );
}

/** 全局确认弹窗宿主：渲染 uiStore 中进行中的确认请求 */
export function ConfirmHost() {
  const confirm = useUiStore((s) => s.confirm);
  const settle = useUiStore((s) => s.settleConfirm);
  if (!confirm) return null;
  return (
    <Modal open onClose={() => settle(false)} title={confirm.title} width="max-w-sm">
      {confirm.message && (
        <p className="px-4 py-4 text-xs leading-relaxed text-ink-muted">{confirm.message}</p>
      )}
      <div className="flex items-center justify-end gap-2 px-4 pb-4 pt-1">
        <Button variant="ghost" size="sm" onClick={() => settle(false)}>
          {confirm.cancelLabel ?? '取消'}
        </Button>
        <Button variant="mono" size="sm" onClick={() => settle(true)}>
          {confirm.confirmLabel ?? (confirm.danger ? '删除' : '确定')}
        </Button>
      </div>
    </Modal>
  );
}
