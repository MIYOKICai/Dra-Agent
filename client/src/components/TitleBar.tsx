/**
 * 自定义标题栏（仅 Electron 环境渲染）：无边框窗口的自绘顶栏。
 * - 全宽 40px 透明顶栏，与页面背景融为一体（浏览器直接打开时不渲染）；
 *   挂载时给 <html> 加 .has-titlebar，页面内容经 CSS 整体下移让位，不再重叠
 * - 整条顶栏为窗口拖动区（双击最大化/还原），按钮 no-drag
 * - 按钮：全屏切换 / 最小化 / 最大化还原 / 关闭（关闭悬停红色），QQ NT 式细线条
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { useUiStore } from '../store/uiStore';
import { IconMoon, IconSun } from './icons';

/** preload.cjs 经 contextBridge 暴露的窗口控制 API */
interface DraWindowApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<boolean>;
  close(): Promise<void>;
  toggleFullscreen(): Promise<boolean>;
  isFullscreen(): Promise<boolean>;
  onWindowStateChange(cb: (state: { maximized: boolean; fullscreen: boolean }) => void): () => void;
}

declare global {
  interface Window {
    draWindow?: DraWindowApi;
  }
}

const dragRegion = { WebkitAppRegion: 'drag' } as CSSProperties;
const noDragRegion = { WebkitAppRegion: 'no-drag' } as CSSProperties;

/** 细线条系统按钮图标（1.2px 描边，QQ NT 风格） */
function ControlIcon({ kind }: { kind: 'min' | 'max' | 'restore' | 'close' | 'enter-full' | 'exit-full' }) {
  const common = 'h-3 w-3';
  switch (kind) {
    case 'min':
      return (
        <svg viewBox="0 0 12 12" className={common} aria-hidden>
          <path d="M1.5 6h9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case 'max':
      return (
        <svg viewBox="0 0 12 12" className={common} aria-hidden>
          <rect x="2" y="2" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" fill="none" />
        </svg>
      );
    case 'restore':
      return (
        <svg viewBox="0 0 12 12" className={common} aria-hidden>
          <rect x="1.8" y="3.6" width="6.6" height="6.6" rx="1" stroke="currentColor" strokeWidth="1.2" fill="none" />
          <path d="M4 3.4V2.8a1 1 0 0 1 1-1h4.2a1 1 0 0 1 1 1V7a1 1 0 0 1-1 1h-.6" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </svg>
      );
    case 'close':
      return (
        <svg viewBox="0 0 12 12" className={common} aria-hidden>
          <path d="M2.2 2.2l7.6 7.6M9.8 2.2l-7.6 7.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case 'enter-full':
      return (
        <svg viewBox="0 0 12 12" className={common} aria-hidden>
          <path d="M7.2 1.6h3.2v3.2M1.6 7.2v3.2h3.2M10.4 1.6L6.6 5.4M1.6 10.4l3.8-3.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      );
    case 'exit-full':
      return (
        <svg viewBox="0 0 12 12" className={common} aria-hidden>
          <path d="M10.4 4.8H7.2V1.6M1.6 7.2h3.2v3.2M7.2 4.8l3.2-3.2M4.8 7.2L1.6 10.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      );
  }
}

/** 系统按钮：统一 hover 态；close 悬停红底白字 */
function SysBtn({
  kind,
  label,
  danger,
  onClick,
}: {
  kind: 'min' | 'max' | 'restore' | 'close' | 'enter-full' | 'exit-full';
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`flex h-10 w-11 items-center justify-center text-ink-muted transition-colors ${
        danger ? 'hover:bg-red-500 hover:text-white' : 'hover:bg-wash hover:text-ink'
      }`}
    >
      <ControlIcon kind={kind} />
    </button>
  );
}

export function TitleBar() {
  const api = window.draWindow;
  const [state, setState] = useState({ maximized: false, fullscreen: false });
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);

  useEffect(() => {
    if (!api) return;
    // 桌面无边框模式：通知全局 CSS 让页面内容整体下移 40px，避免与顶栏按钮重叠
    document.documentElement.classList.add('has-titlebar');
    const off = api.onWindowStateChange(setState);
    void api.isFullscreen().then((fullscreen) => setState((s) => ({ ...s, fullscreen })));
    return () => {
      document.documentElement.classList.remove('has-titlebar');
      off();
    };
  }, [api]);

  if (!api) return null;

  const toggleMaximize = () => void api.toggleMaximize();

  return (
    <div
      className="fixed left-0 right-0 top-0 z-[10000] flex h-10 items-stretch"
      style={dragRegion}
      onDoubleClick={toggleMaximize}
    >
      {/* 控制按钮组（右侧；no-drag 保证点得动） */}
      <div className="ml-auto flex items-stretch" style={noDragRegion}>
        {/* 主题切换（昼夜图标随当前主题反相） */}
        <button
          type="button"
          title={theme === 'dark' ? '切换到白天模式' : '切换到黑夜模式'}
          aria-label={theme === 'dark' ? '切换到白天模式' : '切换到黑夜模式'}
          onClick={toggleTheme}
          className="flex h-10 w-11 items-center justify-center text-ink-muted transition-colors hover:bg-wash hover:text-ink"
        >
          {theme === 'dark' ? <IconSun className="h-3.5 w-3.5" /> : <IconMoon className="h-3.5 w-3.5" />}
        </button>
        {/* 分隔线（主题切换与系统控制组之间的细竖线） */}
        <div className="my-3 w-px self-center bg-line" />
        <SysBtn
          kind={state.fullscreen ? 'exit-full' : 'enter-full'}
          label={state.fullscreen ? '退出全屏' : '全屏'}
          onClick={() => void api.toggleFullscreen()}
        />
        {/* 分隔线（截图样式：控制组之间的细竖线） */}
        <div className="my-3 w-px self-center bg-line" />
        <SysBtn kind="min" label="最小化" onClick={() => void api.minimize()} />
        <SysBtn
          kind={state.maximized ? 'restore' : 'max'}
          label={state.maximized ? '还原' : '最大化'}
          onClick={toggleMaximize}
        />
        <SysBtn kind="close" label="关闭" danger onClick={() => void api.close()} />
      </div>
    </div>
  );
}
