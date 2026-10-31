/**
 * 首次登录导入向导：登录后检测本地存量（画布 / 创作会话 / 服务商配置快照），
 * 用户确认后批量上传云端——
 * - 画布：POST /api/canvases（经 canvasSync.importLocalCanvases，幂等）
 * - 创作会话：POST /api/sessions + 消息逐条追加（经 uploadAllToCloud，幂等）
 * - 服务商配置快照：GET 合并云端 user-settings 后 PUT（apiKey 不含明文，仅配置轮廓）
 * 完成或跳过都写 localStorage 标记 'agent-import-done'，之后不再提示。
 * 样式沿用全局 Modal（border-line / bg-panel，单色零阴影）。
 */
import { useEffect, useMemo, useState } from 'react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { IconCheck, IconDatabase, IconLayers, IconLoader, IconSparkles } from './icons';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useCreationSessions } from '../lib/creationSessions';
import { useSettingsStore } from '../store/settingsStore';
import { fetchUserSettings, saveUserSettings } from '../api/cloud';
import { importLocalCanvases } from '../lib/canvasSync';
import { safeLocalStorage } from '../store/safeStorage';

export const IMPORT_DONE_KEY = 'agent-import-done';

type Phase = 'confirm' | 'running' | 'done';

/** 单阶段进度（done=total 时该行打勾） */
interface StageProgress {
  label: string;
  done: number;
  total: number;
}

/** 本地待上传的服务商配置快照形状（写入 user-settings.providers） */
interface ProviderSnapshot {
  id: string;
  name: string;
  models: { id: string; name: string; kind: string[] }[];
}

export function ImportWizard({ open, onComplete }: { open: boolean; onComplete: () => void }) {
  const canvases = useWorkspaceStore((s) => s.canvases);
  const sessionCount = useCreationSessions((s) => s.sessions.length);
  const providers = useSettingsStore((s) => s.providers);
  const [phase, setPhase] = useState<Phase>('confirm');
  const [stages, setStages] = useState<StageProgress[]>([]);

  // 打开时重置
  useEffect(() => {
    if (open) {
      setPhase('confirm');
      setStages([]);
    }
  }, [open]);

  const hasAny = canvases.length > 0 || sessionCount > 0 || providers.length > 0;

  const setStage = (label: string, done: number, total: number): void => {
    setStages((prev) => {
      const rest = prev.filter((s) => s.label !== label);
      return [...rest, { label, done, total }];
    });
  };

  const start = async (): Promise<void> => {
    setPhase('running');
    // 1. 画布（空默认画布由 importLocalCanvases 内部跳过）
    await importLocalCanvases((done, total) => setStage('画布', done, Math.max(total, 1)));
    setStage('画布', 1, 1);
    // 2. 创作会话（含消息逐条重建）
    await useCreationSessions.getState().uploadAllToCloud((done, total) =>
      setStage('创作对话', done, Math.max(total, 1))
    );
    setStage('创作对话', 1, 1);
    // 3. 服务商配置快照：合并云端已有数据后覆盖 providers 字段
    setStage('服务商配置', 0, 1);
    try {
      const cloud = await fetchUserSettings().catch(() => ({}) as Record<string, unknown>);
      const snapshot: ProviderSnapshot[] = providers.map((p) => ({
        id: p.id,
        name: p.name,
        models: p.models.map((m) => ({ id: m.id, name: m.name, kind: m.kind })),
      }));
      await saveUserSettings({ ...cloud, providers: snapshot });
    } catch (err) {
      console.warn('[import] 服务商配置快照上传失败（跳过）', err);
    }
    setStage('服务商配置', 1, 1);
    try {
      safeLocalStorage.setItem(IMPORT_DONE_KEY, '1');
    } catch {
      // 存储不可用：本次会话内不再弹（bootRef 兜底）
    }
    setPhase('done');
  };

  const skip = (): void => {
    try {
      safeLocalStorage.setItem(IMPORT_DONE_KEY, '1');
    } catch {
      // 同上
    }
    onComplete();
  };

  const stageRows = useMemo(
    () => [
      { label: '画布', icon: <IconLayers className="h-4 w-4" />, count: canvases.length },
      { label: '创作对话', icon: <IconSparkles className="h-4 w-4" />, count: sessionCount },
      { label: '服务商配置', icon: <IconDatabase className="h-4 w-4" />, count: providers.length },
    ],
    [canvases.length, sessionCount, providers.length]
  );

  return (
    <Modal
      open={open}
      onClose={phase === 'running' ? () => undefined : skip}
      title={phase === 'done' ? '导入完成' : '把本地数据同步到云端'}
      width="max-w-sm"
    >
      <div className="space-y-4 px-4 pb-1 pt-4">
        {phase === 'confirm' && (
          <>
            <p className="text-xs leading-relaxed text-ink-muted">
              检测到本机保存的以下数据。同步到云端后，换设备登录也能继续使用；不同步也不影响本机使用。
            </p>
            <ul className="space-y-1.5">
              {stageRows.map(
                (row) =>
                  row.count > 0 && (
                    <li
                      key={row.label}
                      className="flex items-center gap-2.5 rounded-lg border border-line bg-base px-3 py-2 text-[13px] text-ink"
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-ink-muted">
                        {row.icon}
                      </span>
                      {row.label}
                      <span className="ml-auto tabular-nums text-ink-muted">{row.count} 项</span>
                    </li>
                  )
              )}
            </ul>
            {!hasAny && <p className="text-xs text-ink-muted">没有需要同步的本地数据。</p>}
          </>
        )}
        {(phase === 'running' || phase === 'done') && (
          <ul className="space-y-1.5">
            {stages
              .slice()
              .sort((a, b) => a.label.localeCompare(b.label))
              .map((s) => {
                const finished = s.done >= s.total;
                return (
                  <li
                    key={s.label}
                    className="flex items-center gap-2.5 rounded-lg border border-line bg-base px-3 py-2 text-[13px] text-ink"
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center text-ink-muted">
                      {finished ? (
                        <IconCheck className="h-4 w-4" />
                      ) : (
                        <IconLoader className="h-4 w-4 animate-spin" />
                      )}
                    </span>
                    {s.label}
                    <span className="ml-auto tabular-nums text-ink-muted">
                      {s.done}/{s.total}
                    </span>
                  </li>
                );
              })}
          </ul>
        )}
        {phase === 'done' && (
          <p className="text-xs leading-relaxed text-ink-muted">
            本地数据已上传云端。之后所有修改都会自动同步。
          </p>
        )}
        <div className="flex items-center justify-end gap-2 pb-3">
          {phase === 'confirm' && (
            <>
              <Button variant="ghost" size="sm" onClick={skip}>
                暂不同步
              </Button>
              <Button variant="mono" size="sm" disabled={!hasAny} onClick={() => void start()}>
                开始导入
              </Button>
            </>
          )}
          {phase === 'running' && (
            <Button variant="mono" size="sm" disabled>
              导入中…
            </Button>
          )}
          {phase === 'done' && (
            <Button variant="mono" size="sm" onClick={onComplete}>
              开始使用
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
