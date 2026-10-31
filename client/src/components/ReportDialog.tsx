/**
 * 全局举报弹窗宿主：uiStore.reportTarget 非空时渲染（App 挂载一次）。
 * 原因下拉（垃圾信息 / 违法有害 / 侵犯权益 / 其他）+ 可选说明文本域，
 * 提交 POST /api/reports；成功 / 重复举报（409）均 toast 反馈。
 * 样式沿用全局 Modal 体系（border-line / bg-panel，单色零冗余）。
 */
import { useEffect, useState } from 'react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { IconFlag } from './icons';
import { REPORT_REASONS, submitReport } from '../api/moderation';
import { useUiStore } from '../store/uiStore';

export function ReportDialogHost() {
  const target = useUiStore((s) => s.reportTarget);
  const close = useUiStore((s) => s.closeReport);
  const showToast = useUiStore((s) => s.showToast);
  const [reason, setReason] = useState<string>(REPORT_REASONS[0]);
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每次打开重置表单
  useEffect(() => {
    if (target) {
      setReason(REPORT_REASONS[0]);
      setDetail('');
      setError(null);
      setBusy(false);
    }
  }, [target]);

  const submit = async (): Promise<void> => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      await submitReport({ ...target, reason, detail });
      showToast('已提交举报');
      close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setBusy(false);
    }
  };

  return (
    <Modal open={Boolean(target)} onClose={busy ? () => undefined : close} title="提交举报" width="max-w-sm">
      {target && (
        <div className="space-y-3 px-4 pb-1 pt-4">
          <p className="flex items-center gap-1.5 text-xs leading-relaxed text-ink-muted">
            <IconFlag className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
            {target.targetType === 'message' && '举报该消息中的违规内容。'}
            {target.targetType === 'canvas' && '举报该画布中的违规内容。'}
            {target.targetType === 'kbdoc' && '举报该文档中的违规内容。'}
          </p>
          <label className="block">
            <span className="mb-1 block text-xs text-ink-muted">举报原因</span>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-md border border-line bg-base px-2 py-1.5 text-[13px] text-ink outline-none transition-colors focus:border-ink-muted"
            >
              {REPORT_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-ink-muted">补充说明（可选）</span>
            <textarea
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="补充问题描述，便于审核（选填）"
              className="w-full resize-none rounded-md border border-line bg-base px-2 py-1.5 text-[13px] leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-ink-muted"
            />
          </label>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex items-center justify-end gap-2 pb-3 pt-1">
            <Button variant="ghost" size="sm" disabled={busy} onClick={close}>
              取消
            </Button>
            <Button variant="mono" size="sm" disabled={busy} onClick={() => void submit()}>
              {busy ? '提交中…' : '提交举报'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
