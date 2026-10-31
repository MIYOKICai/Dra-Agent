/**
 * 云数据启动编排：登录后（CloudGate 触发）一次性启动三类用户数据的云端同步——
 * 画布（canvasSync）、创作会话（creationSessions.hydrateFromCloud）、
 * 用户设置（settingsStore.loadUserSettings）。全部幂等，失败互不阻塞。
 */
import { resetCanvasSync, startCanvasSync } from './canvasSync';
import { resetSessionsCloudSync, useCreationSessions } from './creationSessions';
import { useSettingsStore } from '../store/settingsStore';

/** 登录 / 换账号后的云同步入口（含首次登录导入向导完成后的触发） */
export async function bootstrapCloudData(): Promise<void> {
  await Promise.allSettled([
    startCanvasSync(),
    useCreationSessions.getState().hydrateFromCloud(),
    useSettingsStore.getState().loadUserSettings(),
  ]);
}

/** 登出 / 会话失效时重置各同步层的「已启动」标记（换账号可重新拉取） */
export function resetCloudSync(): void {
  resetCanvasSync();
  resetSessionsCloudSync();
}
