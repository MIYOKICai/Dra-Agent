import type { SSEEvent } from '@shared/types';

export const API_BASE = '/api';

/** 健康检查（走 vite 代理 → server /api/health） */
export async function fetchHealth(): Promise<{ ok: boolean; providers: Record<string, boolean> }> {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) {
    throw new Error(`health check failed: ${res.status}`);
  }
  return res.json();
}

/**
 * 将 SSE 逐行文本解析为共享协议事件对象。
 * 约定：server 端每行发送一个 `data:{...json...}`；非法行返回 null。
 */
export function parseSSELine(line: string): SSEEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) {
    return null;
  }
  try {
    return JSON.parse(trimmed.slice(5).trim()) as SSEEvent;
  } catch {
    return null;
  }
}
