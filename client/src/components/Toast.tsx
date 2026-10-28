/**
 * 右上角轻提示：显示 uiStore 中最近一条 toast，2 秒自动消失。
 */
import { useEffect } from 'react';
import { useUiStore } from '../store/uiStore';

export function Toast() {
  const toast = useUiStore((s) => s.toast);
  const clearToast = useUiStore((s) => s.clearToast);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(clearToast, 2000);
    return () => window.clearTimeout(timer);
  }, [toast, clearToast]);

  if (!toast) return null;

  return (
    <div
      key={toast.id}
      role="status"
      className="fixed right-4 top-16 z-50 max-w-xs animate-toast-in rounded-base border border-line bg-elevated px-3 py-2 text-xs text-ink shadow-lg shadow-black/40"
    >
      {toast.message}
    </div>
  );
}
