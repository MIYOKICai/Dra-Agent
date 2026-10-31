/**
 * 封禁服务：admin 路由与后续治理流程（Task 6）共用的封禁 / 解封原语。
 * - 封禁统一递增 token_version：该用户所有已签发 access token 立即失效
 *   （requireAuth 核对 token_version，旧 token 一律 401）
 * - 解封只清封禁字段，不动 token_version（存量 token 重新可用；如需全端下线另行递增）
 */
import { getDb } from './db/connection';

/** 封禁结果：ok=false 表示用户不存在 */
export interface BanOutcome {
  ok: boolean;
  /** 永久封禁为 null */
  bannedUntil: string | null;
}

/** 封禁用户：days=null 永久封禁，否则 N 天后到期（requireAuth 对到期封禁自动解封放行） */
export function banUser(userId: string, reason: string, days: number | null): BanOutcome {
  const bannedUntil =
    days === null ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const info = getDb()
    .prepare(
      `UPDATE users SET banned = 1, ban_reason = ?, banned_until = ?,
         token_version = token_version + 1, updated_at = ? WHERE id = ?`
    )
    .run(reason, bannedUntil, new Date().toISOString(), userId);
  return { ok: info.changes > 0, bannedUntil };
}

/** 解除封禁：清空封禁字段；token_version 不变，重新登录即可 */
export function unbanUser(userId: string): boolean {
  const info = getDb()
    .prepare(
      'UPDATE users SET banned = 0, ban_reason = NULL, banned_until = NULL, updated_at = ? WHERE id = ?'
    )
    .run(new Date().toISOString(), userId);
  return info.changes > 0;
}
