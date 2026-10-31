/**
 * 内容治理 API：用户举报（POST /api/reports）。
 * - 目标由服务端校验存在并反查归属；同一用户对同一目标重复举报返回 409
 * - reason 为下拉选项原文（垃圾信息 / 违法有害 / 侵犯权益 / 其他），detail 可选
 */
import { API_BASE } from './client';
import { authedFetch, readError } from './gateway';

export type ReportTargetType = 'message' | 'canvas' | 'kbdoc';

/** 举报弹窗目标（不含 reason / detail，由弹窗表单补充） */
export interface ReportTarget {
  targetType: ReportTargetType;
  targetId: string;
}

export interface ReportInput extends ReportTarget {
  reason: string;
  detail?: string;
}

/** 举报原因固定选项（与举报弹窗下拉一致） */
export const REPORT_REASONS = ['垃圾信息', '违法有害', '侵犯权益', '其他'] as const;

/** POST /api/reports：提交举报 → 202 { id, status: 'pending' }；重复举报 409 */
export async function submitReport(input: ReportInput, signal?: AbortSignal): Promise<void> {
  const res = await authedFetch(`${API_BASE}/reports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, ...(input.detail?.trim() ? { detail: input.detail.trim() } : {}) }),
    signal,
  });
  if (!res.ok) {
    throw new Error(await readError(res, '提交举报失败'));
  }
}
