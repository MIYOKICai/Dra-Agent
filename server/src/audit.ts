/**
 * 审计日志辅助：管理员与内容治理动作统一落 audit_logs 表。
 * - writeAudit(actorId, targetId, action, detail, req)：req 可省（无 HTTP 上下文的场景，如定时任务）
 * - ip 取 x-forwarded-for 首段（反代场景），否则 socket.remoteAddress；ua 取 user-agent
 * - 写入失败仅告警，不阻断主流程（审计是旁路，不应让业务请求 500）
 */
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { getDb } from './db/connection';

/** 解析客户端 IP：x-forwarded-for 首段 → socket.remoteAddress → null */
function clientIp(req?: Request): string | null {
  const xff = req?.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  return req?.socket.remoteAddress ?? null;
}

/** 写入一条审计日志（同步落库） */
export function writeAudit(
  actorId: string | null,
  targetId: string | null,
  action: string,
  detail: string | null,
  req?: Request
): void {
  try {
    getDb()
      .prepare(
        'INSERT INTO audit_logs (id, actor_id, target_id, action, detail, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        randomUUID(),
        actorId,
        targetId,
        action,
        detail,
        clientIp(req),
        typeof req?.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null
      );
  } catch (err) {
    console.error('[dra-agent-audit] 审计日志写入失败:', err);
  }
}
