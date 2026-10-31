/**
 * 画布页左侧抽屉：贴左缘、不悬浮（无圆角无阴影的整高面板）。
 * 由左上角徽标唤起。内容自上而下：品牌行（点击徽标返回首页，含收起钮）→
 * 主导航（一键创作 / 模板中心 / 知识库）→ 创作对话分组 → 画布分组 → 新建画布。
 * 条目管理：悬停行尾 ✓→⋯，点击 ⋯ 果冻滑入操作条（返回/重命名/删除）；
 * 重命名过渡为行内输入框，删除过渡为确认选项。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useCanvasStore } from '../../store/canvasStore';
import { useUiStore } from '../../store/uiStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { useCreationSessions } from '../../lib/creationSessions';
import { getCloudCanvasId } from '../../lib/canvasSync';
import { CanvasThumb } from './CanvasThumb';
import {
  IconArrowLeft,
  IconBook,
  IconBot,
  IconCheck,
  IconChevronDown,
  IconEdit,
  IconFlag,
  IconLayers,
  IconLayoutBoard,
  IconLoader,
  IconMore,
  IconPanelLeft,
  IconPlus,
  IconSettings,
  IconSparkles,
  IconTrash,
} from '../icons';

/** 条目管理目标（画布行 / 创作对话行共用） */
type RowTarget = { kind: 'canvas' | 'session'; id: string };

/** 操作条按钮统一样式：图标 + 文字（垂直居中，与行高协调） */
const STRIP_BTN =
  'flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-ink-muted transition-colors hover:bg-wash-strong hover:text-ink';

/**
 * 行尾操作条（行内部的动画图层，非悬浮胶囊）：
 * 点 ⋯ 后行内容层过渡淡出，本层在行内右侧果冻滑入 [返回][重命名][删除]；
 * 点删除过渡为 [取消][确认删除]（row-pop-in）。
 */
function RowActionStrip({
  confirming,
  onBack,
  onRename,
  onTrash,
  onCancelDelete,
  onConfirmDelete,
  onReport,
}: {
  confirming: boolean;
  onBack: () => void;
  onRename: () => void;
  onTrash: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  /** 可选举报入口（仅画布行）：定位云端目标提交举报 */
  onReport?: () => void;
}) {
  if (confirming) {
    return (
      <div className="row-pop-in flex items-center gap-1">
        <button
          type="button"
          title="取消删除"
          className="rounded-md px-1.5 py-1 text-[11px] text-ink-muted transition-colors hover:bg-wash hover:text-ink"
          onClick={(e) => {
            e.stopPropagation();
            onCancelDelete();
          }}
        >
          取消
        </button>
        <button
          type="button"
          title="确认删除"
          className="rounded-md px-1.5 py-1 text-[11px] font-medium text-ink transition-colors hover:bg-wash-strong"
          onClick={(e) => {
            e.stopPropagation();
            onConfirmDelete();
          }}
        >
          确认删除
        </button>
      </div>
    );
  }
  return (
    /* 果冻滑入：右缘锚定（origin-right），先过冲再回弹落位 */
    <div
      className="row-actions-jelly flex origin-right items-center gap-1"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onBack();
      }}
    >
      <button type="button" title="收起" className={STRIP_BTN} onClick={(e) => { e.stopPropagation(); onBack(); }}>
        <IconArrowLeft className="h-3.5 w-3.5" />
        收起
      </button>
      <button type="button" title="重命名" className={STRIP_BTN} onClick={(e) => { e.stopPropagation(); onRename(); }}>
        <IconEdit className="h-3.5 w-3.5" />
        重命名
      </button>
      {onReport && (
        <button type="button" title="举报" className={STRIP_BTN} onClick={(e) => { e.stopPropagation(); onReport(); }}>
          <IconFlag className="h-3.5 w-3.5" />
          举报
        </button>
      )}
      <button type="button" title="删除" className={STRIP_BTN} onClick={(e) => { e.stopPropagation(); onTrash(); }}>
        <IconTrash className="h-3.5 w-3.5" />
        删除
      </button>
    </div>
  );
}

/**
 * 行内重命名输入框：挂载即聚焦全选；Enter / 失焦提交，Esc 取消。
 * settledRef 防重：Enter 提交后紧接着的 blur 不重复触发 onCommit。
 */
function RowRenameInput({
  defaultValue,
  onCommit,
  onCancel,
}: {
  defaultValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const settle = (commit: boolean): void => {
    if (settledRef.current) return;
    settledRef.current = true;
    const value = ref.current?.value ?? '';
    if (commit && value.trim() && value.trim() !== defaultValue) onCommit(value.trim());
    onCancel();
  };
  return (
    <div className="row-pop-in flex min-w-0 flex-1">
      <input
        ref={ref}
        defaultValue={defaultValue}
        maxLength={40}
        aria-label="重命名"
        className="min-w-0 flex-1 rounded-md border border-line bg-base px-2 py-1 text-[13px] text-ink outline-none focus:border-ink-muted"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // 阻止冒泡：输入框内的 Esc / Enter 不触发全局关闭（创作面板等）
          e.stopPropagation();
          if (e.key === 'Enter') settle(true);
          else if (e.key === 'Escape') settle(false);
        }}
        onBlur={() => settle(true)}
      />
    </div>
  );
}

/** 主导航行：当前页高亮，其余悬停亮起 */
function NavRow({
  icon,
  label,
  active = false,
  onClick,
  trailing,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
  /** 行尾附加内容（如画布分组的下拉箭头），自动靠右 */
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-11 w-full items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors ${
        active
          ? 'bg-wash-strong text-ink'
          : 'text-ink-muted hover:bg-wash hover:text-ink'
      }`}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">{icon}</span>
      {label}
      {trailing && (
        <span className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center">
          {trailing}
        </span>
      )}
    </button>
  );
}

/** 折叠态图标钮：48px 触摸区居中图标，悬停反白，title 作 tooltip */
function RailBtn({
  children,
  title,
  active,
  onClick,
}: {
  children: ReactNode;
  title: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
        active ? 'bg-wash-strong text-ink' : 'text-ink-muted hover:bg-wash hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

export function ProjectSidebar() {
  const navigate = useNavigate();
  /** 当前路由：主导航按页面高亮，画布项点击后跳回画布页 */
  const { pathname } = useLocation();
  const open = useUiStore((s) => s.sidebarOpen);
  /** 折叠为图标栏：宽度保留 64px 仅显示图标（持久化，刷新后保持） */
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const setCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const setCreationOpen = useUiStore((s) => s.setCreationOpen);
  /** 创作面板是否展开：驱动画布列表与创作对话两组「选中态」互斥高亮 */
  const creationOpen = useUiStore((s) => s.creationOpen);
  /** 创作面板当前会话 id：null = 新对话；侧边栏与面板经它交接 */
  const activeCreationSessionId = useUiStore((s) => s.activeCreationSessionId);
  const setActiveCreationSessionId = useUiStore((s) => s.setActiveCreationSessionId);
  /** 正在流式生成中的会话 id：对应行尾显示环形旋转加载，完成后切回对勾 */
  const generatingSessionId = useUiStore((s) => s.generatingSessionId);
  const showToast = useUiStore((s) => s.showToast);
  const showReport = useUiStore((s) => s.showReport);

  const canvases = useWorkspaceStore((s) => s.canvases);
  const activeId = useWorkspaceStore((s) => s.activeId);
  const createCanvas = useWorkspaceStore((s) => s.createCanvas);
  const renameCanvas = useWorkspaceStore((s) => s.renameCanvas);
  const deleteCanvasById = useWorkspaceStore((s) => s.deleteCanvas);
  /** 「生成」模式的创作对话历史（与创作面板共享同一持久化 store） */
  const creationSessions = useCreationSessions((s) => s.sessions);
  const removeSessionById = useCreationSessions((s) => s.remove);
  const renameSessionById = useCreationSessions((s) => s.rename);
  /** 当前画布名称以 canvasStore 实时值为准（输入框改名立即同步到列表） */
  const activeName = useCanvasStore((s) => s.name);
  /**
   * 分组单开互斥：'canvas' | 'session' | null（都收起）。
   * 展开一个分组时另一个自动收起（状态只存一个值）；
   * 展开的分组经 flex order 排到另一分组下方。
   */
  /* 分组展开态存全局 uiStore：本组件随页面切换会重挂载，
     本地 state 的初始值会在每次跳页时把展开态重置回 'canvas'（点击
     知识库 / 设置等其他按钮后画布分组被意外展开）；存 store 后跨页面保持，
     挂载时由下方路由跟随 effect 按 /chat 与 /canvas 重新对齐 */
  const expandedGroup = useUiStore((s) => s.expandedGroup);
  const setExpandedGroup = useUiStore((s) => s.setExpandedGroup);
  /** 折叠图标栏的历史 flyout：'session' | 'canvas' | null（点击空白处关闭） */
  const [railFlyout, setRailFlyout] = useState<'session' | 'canvas' | null>(null);

  /* ===== 分组换位 FLIP 动画 =====
     order 切换不会触发过渡，需手动 FLIP：点击分组头时先采样两组当前位置，
     状态落盘（DOM 重排后、绘制前）计算各组位移，反向 transform 再过渡归零 */
  const sessionGroupRef = useRef<HTMLDivElement>(null);
  const canvasGroupRef = useRef<HTMLDivElement>(null);
  const flipRectsRef = useRef<{ session: DOMRect; canvas: DOMRect } | null>(null);

  const toggleGroup = (group: 'canvas' | 'session'): void => {
    const sessionEl = sessionGroupRef.current;
    const canvasEl = canvasGroupRef.current;
    if (sessionEl && canvasEl) {
      flipRectsRef.current = {
        session: sessionEl.getBoundingClientRect(),
        canvas: canvasEl.getBoundingClientRect(),
      };
    }
    setExpandedGroup(expandedGroup === group ? null : group);
  };

  useLayoutEffect(() => {
    const rects = flipRectsRef.current;
    flipRectsRef.current = null;
    if (!rects) return;
    const glide = (el: HTMLElement, oldTop: number) => {
      const dy = oldTop - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) return;
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      void el.getBoundingClientRect(); // 强制 reflow，确保起始帧生效
      el.style.transition = 'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1)';
      el.style.transform = '';
      el.addEventListener(
        'transitionend',
        () => {
          el.style.transition = '';
        },
        { once: true }
      );
    };
    if (sessionGroupRef.current) glide(sessionGroupRef.current, rects.session.top);
    if (canvasGroupRef.current) glide(canvasGroupRef.current, rects.canvas.top);
  }, [expandedGroup]);

  /* ===== 分组展开态跟随页面 =====
     切到 /chat（创作对话面板）自动展开会话组，切回 /canvas 展开画布组；
     单开互斥自动收起另一组。页面内手动收起/展开不受影响，仅路由变化时重新跟随；
     去往其他页面（设置 / 知识库 / 模板中心）不干预用户当前的展开/收起状态 */
  useEffect(() => {
    if (pathname === '/chat') setExpandedGroup('session');
    else if (pathname === '/canvas') setExpandedGroup('canvas');
  }, [pathname]);

  /* ===== 折叠图标栏：历史入口换位 FLIP（与分组换位同一套机制） =====
     展开的入口经 order 换到最下方，换位过程用 FLIP 平滑过渡（与左侧边栏分组一致） */
  const sessionRailRef = useRef<HTMLDivElement>(null);
  const canvasRailRef = useRef<HTMLDivElement>(null);
  const railFlipRef = useRef<{ session: DOMRect; canvas: DOMRect } | null>(null);

  const toggleRail = (group: 'session' | 'canvas'): void => {
    const s = sessionRailRef.current;
    const c = canvasRailRef.current;
    if (s && c) {
      railFlipRef.current = {
        session: s.getBoundingClientRect(),
        canvas: c.getBoundingClientRect(),
      };
    }
    setRailFlyout((cur) => (cur === group ? null : group));
  };

  /** 图标栏其他功能被点击时先收起历史 flyout（flyout 展开期间图标栏保持可交互） */
  const railNav =
    (fn: () => void) =>
    (): void => {
      setRailFlyout(null);
      fn();
    };

  useLayoutEffect(() => {
    const rects = railFlipRef.current;
    railFlipRef.current = null;
    if (!rects) return;
    const glide = (el: HTMLElement, oldTop: number) => {
      const dy = oldTop - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) return;
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      void el.getBoundingClientRect();
      el.style.transition = 'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1)';
      el.style.transform = '';
      el.addEventListener(
        'transitionend',
        () => {
          el.style.transition = '';
        },
        { once: true }
      );
    };
    if (sessionRailRef.current) glide(sessionRailRef.current, rects.session.top);
    if (canvasRailRef.current) glide(canvasRailRef.current, rects.canvas.top);
  }, [railFlyout]);

  /* ===== 折叠/展开切换时同步历史展开态 =====
     侧边栏分组与图标栏 flyout 是同一份「历史入口」在两种形态下的展开表现：
     收起侧边栏 → 展开的分组带到 flyout；展开侧边栏 → 张开的 flyout 带回分组。
     挂载首跑不同步（刷新后 flyout 不应自动张开），仅响应真实的折叠切换 */
  const prevCollapsedRef = useRef(collapsed);
  useEffect(() => {
    const prev = prevCollapsedRef.current;
    prevCollapsedRef.current = collapsed;
    if (prev === collapsed) return;
    if (collapsed) setRailFlyout(expandedGroup);
    else setExpandedGroup(railFlyout);
  }, [collapsed, expandedGroup, railFlyout]);

  /** 空态引导：新建创作对话（进入一键创作的新对话态） */
  const startNewConversation = (): void => {
    setActiveCreationSessionId(null);
    navigate('/chat');
    setCreationOpen(true);
  };

  /* ===== 条目管理：⋯ 展开操作条 / 删除确认 / 行内重命名 ===== */
  /** 已展开操作条的行（⋯ 点击后出现 [返回/重命名/删除]；同一时间仅一行） */
  const [actionsRow, setActionsRow] = useState<RowTarget | null>(null);
  /** 已进入删除确认态的行（过渡为 [取消/确认删除]） */
  const [confirmRow, setConfirmRow] = useState<RowTarget | null>(null);
  /** 行内重命名目标：命中该行渲染切换为输入框 */
  const [renaming, setRenaming] = useState<RowTarget | null>(null);

  const closeRowUi = (): void => {
    setActionsRow(null);
    setConfirmRow(null);
  };

  const commitRename = (kind: 'canvas' | 'session', id: string, value: string): void => {
    if (kind === 'canvas') renameCanvas(id, value);
    else renameSessionById(id, value);
  };

  const deleteCanvasRow = (id: string): void => {
    deleteCanvasById(id);
    showToast('已删除画布');
  };

  /** 举报画布：经映射定位云端 id（未上云提示稍后再试），打开全局举报弹窗 */
  const reportCanvasRow = (id: string): void => {
    const cloudId = getCloudCanvasId(id);
    if (!cloudId) {
      showToast('该画布尚未同步到云端，请稍后再试');
      return;
    }
    showReport({ targetType: 'canvas', targetId: cloudId });
  };

  /** 删除创作对话；删除当前打开的会话时回退到新对话态（/chat 去参数 / 关面板） */
  const deleteSessionRow = (id: string): void => {
    removeSessionById(id);
    if (activeCreationSessionId === id) {
      if (pathname === '/chat') {
        navigate('/chat', { replace: true }); // 无 session 参数 → CanvasPage effect 置回新对话态
      } else {
        setActiveCreationSessionId(null);
        setCreationOpen(false);
      }
    }
    showToast('已删除创作对话');
  };

  /**
   * 行主体点击：操作条 / 确认态打开时先收起（不触发跳转），否则执行正常打开动作。
   * 正常打开动作里统一 closeRowUi，避免切走后残留展开态。
   */
  const rowClick = (target: RowTarget, open: () => void): void => {
    const hit =
      (actionsRow && actionsRow.kind === target.kind && actionsRow.id === target.id) ||
      (confirmRow && confirmRow.kind === target.kind && confirmRow.id === target.id);
    if (hit) {
      closeRowUi();
      return;
    }
    closeRowUi();
    open();
  };

  const onCreate = () => {
    closeRowUi();
    createCanvas();
    showToast('已新建空白画布');
  };

  /** 打开一条创作对话：交接会话 id → 面板载入历史；URL /chat?session=，刷新可恢复面板 */
  const openCreationSession = (id: string) => {
    closeRowUi();
    setActiveCreationSessionId(id);
    navigate(`/chat?session=${id}`);
    setCreationOpen(true);
  };

  /** 打开一块画布：直接切工作区 activeId（store 驱动，URL 由 CanvasPage effect 跟随同步）。
      不在画布页时先跳回 /canvas：/chat 路由的 effect 会强制展开创作面板，
      只切 store 不跳路由会被面板抢回焦点，表现为点击无反应。
      URL 深链只在画布页挂载首跑生效（刷新/粘贴恢复场景），应用内点击 store 优先 */
  const openCanvasRow = (id: string) => {
    closeRowUi();
    useWorkspaceStore.getState().switchCanvas(id);
    if (pathname !== '/canvas') navigate('/canvas');
    setCreationOpen(false);
  };

  return (
    <aside
      aria-label="项目侧边栏"
      aria-hidden={!open}
      /* 背景用内联样式直引 --bg-sidebar（亮 #fcfcfc / 暗 #171a20）：
         Tailwind 新令牌类依赖 dev server 重新编译，内联样式保证即时生效 */
      style={{ backgroundColor: 'var(--bg-sidebar)' }}
      className={`relative flex h-full shrink-0 flex-col overflow-hidden transition-[width] duration-300 ease-out ${
        open ? (collapsed ? 'w-16' : 'w-[252px]') : 'pointer-events-none w-0'
      }`}
    >
      {/* 展开内容层：折叠时淡出，宽度同步过渡（overflow 裁切 + 透明度交接形成平滑动画） */}
      <div
        aria-hidden={collapsed}
        className={`flex h-full w-[252px] flex-col transition-opacity duration-300 ${
          collapsed ? 'pointer-events-none opacity-0' : 'opacity-100'
        }`}
      >
        {/* 品牌行：徽标（点击返回首页）+ 名称 + 收起 */}
        <div className="flex h-16 shrink-0 items-center gap-2.5 px-4">
          <button
            type="button"
            onClick={() => navigate('/')}
            title="返回首页"
            aria-label="返回首页"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-mono text-mono-fg transition-colors hover:bg-mono-hover"
          >
            <IconSparkles className="h-4 w-4" />
          </button>
          <span className="text-[15px] font-semibold tracking-tight text-ink">Dra-Agent</span>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            title="折叠为图标栏"
            aria-label="折叠为图标栏"
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-wash hover:text-ink"
          >
            <IconPanelLeft className="h-4 w-4" />
          </button>
        </div>

        {/* 主导航：一键创作固定第一，其后模板中心 / 知识库；active 跟随当前路由。
            画布切换独立于主导航，放至下方的画布分组（默认展开） */}
        <nav className="shrink-0 space-y-0.5 px-3">
          <NavRow
            icon={<IconSparkles className="h-4 w-4" />}
            label="一键创作"
            onClick={() => {
              setActiveCreationSessionId(null);
              navigate('/chat');
              setCreationOpen(true);
            }}
          />
          <NavRow
            icon={<IconLayoutBoard className="h-4 w-4" />}
            label="模板中心"
            active={pathname === '/templates'}
            onClick={() => navigate('/templates')}
          />
          <NavRow
            icon={<IconBook className="h-4 w-4" />}
            label="知识库"
            active={pathname === '/knowledge'}
            onClick={() => navigate('/knowledge')}
          />
          <NavRow
            icon={<IconSettings className="h-4 w-4" />}
            label="设置"
            active={pathname === '/settings'}
            onClick={() => navigate('/settings')}
          />
        </nav>

        {/* 创作对话与画布两个分组：单开互斥（展开一个自动收起另一个）；
            展开的分组经 flex order 排到另一分组下方，列表紧随其头。
            两个分组头始终渲染；空态时展开列表首项为「新建对话 / 新建画布」引导 */}
        <div className="mt-3 flex min-h-0 flex-1 flex-col px-3 pb-4">
          <div
            ref={sessionGroupRef}
            style={{ order: expandedGroup === 'session' ? 2 : 1 }}
            className={
              expandedGroup === 'session'
                ? 'flex min-h-0 flex-1 flex-col space-y-0.5'
                : 'shrink-0 space-y-0.5'
            }
          >
            <NavRow
              icon={<IconBot className="h-4 w-4" />}
              label="创作对话"
              onClick={() => toggleGroup('session')}
              trailing={
                <IconChevronDown
                  className={`h-3.5 w-3.5 transition-transform duration-200 ${expandedGroup === 'session' ? '' : '-rotate-90'}`}
                />
              }
            />
            {expandedGroup === 'session' && (
              <div className="row-pop-in no-scrollbar mt-0.5 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
                {creationSessions.length === 0 ? (
                  <button
                    type="button"
                    onClick={startNewConversation}
                    className="flex h-11 w-full items-center gap-3 rounded-xl px-1 text-[13px] text-ink transition-colors hover:bg-wash"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-dashed border-line text-ink-muted">
                      <IconPlus className="h-4 w-4" />
                    </span>
                    新建对话
                  </button>
                ) : (
                  creationSessions.map((session) => {
                    // 选中态仅在创作面板展开且当前位于 /chat 时生效：点击其他导航
                    // （模板中心 / 知识库等）后行自动取消选中，避免「假选中」残留
                    const isActive =
                      creationOpen && pathname === '/chat' && session.id === activeCreationSessionId;
                    // 行内重命名中：整行切换为输入框（不可点击跳转）
                    if (renaming?.kind === 'session' && renaming.id === session.id) {
                      return (
                        <div
                          key={session.id}
                          className="flex h-11 w-full items-center gap-3 rounded-xl bg-wash-strong px-1 py-1"
                        >
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-base text-ink-muted">
                            <IconSparkles className="h-4 w-4" />
                          </span>
                          <RowRenameInput
                            key={session.id}
                            defaultValue={session.title}
                            onCommit={(value) => commitRename('session', session.id, value)}
                            onCancel={() => setRenaming(null)}
                          />
                        </div>
                      );
                    }
                    const target: RowTarget = { kind: 'session', id: session.id };
                    const stripOpen = actionsRow?.kind === 'session' && actionsRow.id === session.id;
                    const confirming = confirmRow?.kind === 'session' && confirmRow.id === session.id;
                    const isGenerating = session.id === generatingSessionId;
                    return (
                      <div
                        key={session.id}
                        role="button"
                        tabIndex={0}
                        onClick={() =>
                          rowClick(target, () => openCreationSession(session.id))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            rowClick(target, () => openCreationSession(session.id));
                          }
                        }}
                        title={session.title}
                        className={`group relative flex h-11 w-full cursor-pointer items-center rounded-xl px-1 py-1 text-left transition-colors ${
                          isActive ? 'bg-wash-strong' : 'hover:bg-wash'
                        }`}
                      >
                        {/* 内容层：操作条开启时整体淡出微缩（先消失），随后操作层在行内滑入 */}
                        <div
                          className={`flex w-full items-center gap-3 transition-[opacity,transform] duration-200 ${
                            stripOpen || confirming
                              ? 'pointer-events-none scale-[0.985] opacity-0'
                              : 'opacity-100'
                          }`}
                        >
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-base text-ink-muted">
                            <IconSparkles className="h-4 w-4" />
                          </span>
                          <span
                            className={`min-w-0 flex-1 truncate text-[13px] ${
                              isActive ? 'font-medium text-ink' : 'text-ink-muted'
                            }`}
                          >
                            {session.title}
                          </span>
                          {/* 行尾：生成中=旋转加载；其余悬停时 ✓ 淡出、⋯ 淡入
                              （非活动行仅悬停显示 ⋯）；操作条开启时随内容层一并隐藏 */}
                          <span className="relative mr-2 flex h-5 w-5 shrink-0 items-center justify-center">
                            {isGenerating ? (
                              <IconLoader className="h-3.5 w-3.5 animate-spin text-ink-muted" />
                            ) : (
                              <>
                                {isActive && (
                                  <IconCheck className="absolute h-3.5 w-3.5 text-ink transition-opacity duration-150 group-hover:opacity-0" />
                                )}
                                <button
                                  type="button"
                                  title="更多操作"
                                  aria-label="更多操作"
                                  className={`absolute inset-0 flex items-center justify-center rounded-md text-ink-muted opacity-0 transition-opacity duration-150 hover:bg-wash-strong hover:text-ink focus:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 ${
                                    isActive ? '' : 'pointer-events-none'
                                  }`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setConfirmRow(null);
                                    setActionsRow(target);
                                  }}
                                >
                                  <IconMore className="h-3.5 w-3.5" />
                                </button>
                              </>
                            )}
                          </span>
                        </div>
                        {/* 操作层：铺满行内，操作条水平 + 垂直双居中 */}
                        {(stripOpen || confirming) && (
                          <div className="absolute inset-0 z-10 flex items-center justify-end rounded-xl justify-center">
                            <RowActionStrip
                              confirming={confirming}
                              onBack={closeRowUi}
                              onRename={() => {
                                closeRowUi();
                                setRenaming(target);
                              }}
                              onTrash={() => setConfirmRow(target)}
                              onCancelDelete={() => setConfirmRow(null)} // 回到操作条（actionsRow 仍开启）
                              onConfirmDelete={() => {
                                closeRowUi();
                                deleteSessionRow(session.id);
                              }}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
            {/* 新建对话：固定于会话列表下方不随滚动移出（与「新建画布」同款）；
                无会话时列表首项即引导，此按钮不重复渲染 */}
            {expandedGroup === 'session' && creationSessions.length > 0 && (
              <button
                type="button"
                onClick={startNewConversation}
                className="mt-1.5 flex h-11 w-full shrink-0 items-center gap-3 rounded-xl px-1 text-[13px] text-ink transition-colors hover:bg-wash"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-dashed border-line text-ink-muted">
                  <IconPlus className="h-4 w-4" />
                </span>
                新建对话
              </button>
            )}
          </div>

          <div
            ref={canvasGroupRef}
            style={{ order: expandedGroup === 'canvas' ? 2 : 1 }}
            className={
              expandedGroup === 'canvas'
                ? 'flex min-h-0 flex-1 flex-col space-y-0.5'
                : 'shrink-0 space-y-0.5'
            }
          >
            <NavRow
              icon={<IconLayers className="h-4 w-4" />}
              label="画布"
              onClick={() => toggleGroup('canvas')}
              trailing={
                <IconChevronDown
                  className={`h-3.5 w-3.5 transition-transform duration-200 ${expandedGroup === 'canvas' ? '' : '-rotate-90'}`}
                />
              }
            />

            {/* 画布列表：与分组头同缩进同圆角；无画布时首项即「新建画布」引导 */}
            {expandedGroup === 'canvas' && (
              <div className="row-pop-in no-scrollbar mt-0.5 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
                {canvases.map((item) => {
                  // 选中态仅在位于画布页（/canvas）且未开创作面板时生效：
                  // 点击模板中心 / 知识库等其他内容后行自动取消选中，避免「假选中」残留；
                  // 面板展开时高亮让位给创作对话，两组不同时呈现「已点击」样式
                  const isActive =
                    pathname === '/canvas' && !creationOpen && item.id === activeId;
                  // 行内重命名中：整行切换为输入框（活动行回填 canvasStore 实时名称）
                  if (renaming?.kind === 'canvas' && renaming.id === item.id) {
                    return (
                      <div
                        key={item.id}
                        className="flex h-11 w-full items-center gap-3 rounded-xl bg-wash-strong px-1 py-1"
                      >
                        <CanvasThumb className="h-9 w-9" />
                        <RowRenameInput
                          key={item.id}
                          defaultValue={item.id === activeId ? activeName || '' : item.name}
                          onCommit={(value) => commitRename('canvas', item.id, value)}
                          onCancel={() => setRenaming(null)}
                        />
                      </div>
                    );
                  }
                  const target: RowTarget = { kind: 'canvas', id: item.id };
                  const stripOpen = actionsRow?.kind === 'canvas' && actionsRow.id === item.id;
                  const confirming = confirmRow?.kind === 'canvas' && confirmRow.id === item.id;
                  return (
                    <div
                      key={item.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => rowClick(target, () => openCanvasRow(item.id))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          rowClick(target, () => openCanvasRow(item.id));
                        }
                      }}
                      title={isActive ? '当前画布' : '切换到该画布'}
                      className={`group relative flex h-11 w-full cursor-pointer items-center rounded-xl px-1 py-1 text-left transition-colors ${
                        isActive ? 'bg-wash-strong' : 'hover:bg-wash'
                      }`}
                    >
                      {/* 内容层：操作条开启时整体淡出微缩（先消失），随后操作层在行内滑入 */}
                      <div
                        className={`flex w-full items-center gap-3 transition-[opacity,transform] duration-200 ${
                          stripOpen || confirming
                            ? 'pointer-events-none scale-[0.985] opacity-0'
                            : 'opacity-100'
                        }`}
                      >
                        <CanvasThumb className="h-9 w-9" />
                        <span
                          className={`min-w-0 flex-1 truncate text-[13px] ${
                            isActive ? 'font-medium text-ink' : 'text-ink-muted'
                          }`}
                        >
                          {isActive ? activeName || '未命名工作流' : item.name}
                        </span>
                        {/* 行尾：悬停时 ✓ 淡出、⋯ 淡入。mr-2 补偿行内边距差
                            （行 px-1 / 分组头 px-3），使行尾中心与分组头下拉箭头
                            中心同处 22px 右距线上 */}
                        <span className="relative mr-2 flex h-5 w-5 shrink-0 items-center justify-center">
                          {isActive && (
                            <IconCheck className="absolute h-3.5 w-3.5 text-ink transition-opacity duration-150 group-hover:opacity-0" />
                          )}
                          <button
                            type="button"
                            title="更多操作"
                            aria-label="更多操作"
                            className={`absolute inset-0 flex items-center justify-center rounded-md text-ink-muted opacity-0 transition-opacity duration-150 hover:bg-wash-strong hover:text-ink focus:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 ${
                              isActive ? '' : 'pointer-events-none'
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmRow(null);
                              setActionsRow(target);
                            }}
                          >
                            <IconMore className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      </div>
                      {/* 操作层：铺满行内，操作条水平 + 垂直双居中 */}
                      {(stripOpen || confirming) && (
                        <div className="absolute inset-0 z-10 flex items-center justify-end rounded-xl justify-center">
                          <RowActionStrip
                            confirming={confirming}
                            onBack={closeRowUi}
                            onRename={() => {
                              closeRowUi();
                              setRenaming(target);
                            }}
                            onTrash={() => setConfirmRow(target)}
                            onCancelDelete={() => setConfirmRow(null)} // 回到操作条（actionsRow 仍开启）
                            onConfirmDelete={() => {
                              closeRowUi();
                              deleteCanvasRow(item.id);
                            }}
                            onReport={() => {
                              closeRowUi();
                              reportCanvasRow(item.id);
                            }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* 新建画布：固定于列表下方不随滚动移出；无画布时列表为空、首项即引导 */}
            {expandedGroup === 'canvas' && (
                <button
                  type="button"
                  onClick={() => {
                    onCreate();
                    if (pathname !== '/canvas') navigate('/canvas');
                    setCreationOpen(false);
                  }}
                  className="mt-1.5 flex h-11 w-full shrink-0 items-center gap-3 rounded-xl px-1 text-[13px] text-ink transition-colors hover:bg-wash"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-dashed border-line text-ink-muted">
                    <IconPlus className="h-4 w-4" />
                  </span>
                  新建画布
                </button>
              )}
          </div>
        </div>
      </div>

      {/* 历史 flyout 遮罩：位于图标栏层（z-30）之下，只拦截图标栏以外的点击，点击空白关闭。
          仅折叠态挂载：展开侧边栏时 flyout 状态保留用于同步分组，不应出现全屏遮罩 */}
      {collapsed && railFlyout && <div className="fixed inset-0 z-20" onClick={() => setRailFlyout(null)} />}

      {/* 折叠图标栏层：64px，与展开层交叉淡入淡出 */}
      <div
        aria-hidden={!collapsed}
        className={`absolute inset-y-0 left-0 z-30 flex w-16 flex-col items-center gap-1 py-3 transition-opacity duration-300 ${
          collapsed ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <RailBtn title="返回首页" onClick={railNav(() => navigate('/'))}>
          <IconSparkles className="h-4 w-4" />
        </RailBtn>
        {/* 展开侧边栏不走 railNav（不先清 flyout）：张开中的 flyout 要带回展开层作为分组展开态 */}
        <RailBtn title="展开侧边栏" onClick={() => setCollapsed(false)}>
          <IconPanelLeft className="h-4 w-4" />
        </RailBtn>
        <div className="my-1.5 h-px w-8 bg-line" />
        <RailBtn
          title="一键创作"
          onClick={railNav(() => {
            setActiveCreationSessionId(null);
            navigate('/chat');
            setCreationOpen(true);
          })}
        >
          <IconSparkles className="h-4 w-4" />
        </RailBtn>
        <RailBtn title="模板中心" active={pathname === '/templates'} onClick={railNav(() => navigate('/templates'))}>
          <IconLayers className="h-4 w-4" />
        </RailBtn>
        <RailBtn title="知识库" active={pathname === '/knowledge'} onClick={railNav(() => navigate('/knowledge'))}>
          <IconBook className="h-4 w-4" />
        </RailBtn>
        <RailBtn title="设置" active={pathname === '/settings'} onClick={railNav(() => navigate('/settings'))}>
          <IconSettings className="h-4 w-4" />
        </RailBtn>

        {/* 创作对话历史入口：与侧边栏分组同逻辑——展开的入口经 order 换到最下（FLIP 过渡），
            flyout 从按钮下方弹出（row-pop-in，与侧边栏列表同一动画） */}
        <div
          ref={sessionRailRef}
          style={{ order: railFlyout === 'session' ? 2 : 1 }}
          className="relative flex w-16 justify-center"
        >
          <button
            type="button"
            onClick={() => toggleRail('session')}
            title="创作对话"
            aria-label="创作对话"
            className={`group relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
              railFlyout === 'session'
                ? 'bg-wash-strong text-ink'
                : 'text-ink-muted hover:bg-wash hover:text-ink'
            }`}
          >
            <span
              className={`absolute flex items-center justify-center transition-opacity duration-150 ${
                railFlyout === 'session' ? 'opacity-0' : 'opacity-100 group-hover:opacity-0'
              }`}
            >
              <IconBot className="h-4 w-4" />
            </span>
            <IconChevronDown
              className={`absolute h-4 w-4 transition-all duration-200 ${
                railFlyout === 'session'
                  ? 'rotate-180 opacity-100'
                  : 'rotate-90 opacity-0 group-hover:rotate-0 group-hover:opacity-100'
              }`}
            />
          </button>
          {railFlyout === 'session' && (
            /* 无面板框：图标列与图标栏同款样式无缝衔接（同宽同列同间距），悬停 title 提示名称 */
            <div className="row-pop-in absolute left-0 top-full z-30 flex w-16 flex-col items-center gap-1 pt-2">
              {creationSessions.length === 0 ? (
                <div className="px-1 py-3 text-center text-[10px] leading-tight text-ink-faint">
                  暂无对话
                </div>
              ) : (
                creationSessions.map((s) => {
                  const isActive =
                    pathname === '/chat' && creationOpen && s.id === activeCreationSessionId;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => openCreationSession(s.id)}
                      title={s.title}
                      aria-label={s.title}
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors ${
                        isActive
                          ? 'bg-wash-strong text-ink'
                          : 'text-ink-muted hover:bg-wash hover:text-ink'
                      }`}
                    >
                      <IconSparkles className="h-4 w-4" />
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* 画布历史入口：同上交互 */}
        <div
          ref={canvasRailRef}
          style={{ order: railFlyout === 'canvas' ? 2 : 1 }}
          className="relative flex w-16 justify-center"
        >
          <button
            type="button"
            onClick={() => toggleRail('canvas')}
            title="画布"
            aria-label="画布"
            className={`group relative flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
              railFlyout === 'canvas'
                ? 'bg-wash-strong text-ink'
                : 'text-ink-muted hover:bg-wash hover:text-ink'
            }`}
          >
            <span
              className={`absolute flex items-center justify-center transition-opacity duration-150 ${
                railFlyout === 'canvas' ? 'opacity-0' : 'opacity-100 group-hover:opacity-0'
              }`}
            >
              <IconLayers className="h-4 w-4" />
            </span>
            <IconChevronDown
              className={`absolute h-4 w-4 transition-all duration-200 ${
                railFlyout === 'canvas'
                  ? 'rotate-180 opacity-100'
                  : 'rotate-90 opacity-0 group-hover:rotate-0 group-hover:opacity-100'
              }`}
            />
          </button>
          {railFlyout === 'canvas' && (
            /* 无面板框：图标列与图标栏同款样式无缝衔接；当前画布反白高亮，悬停 title 提示名称 */
            <div className="row-pop-in absolute left-0 top-full z-30 flex w-16 flex-col items-center gap-1 pt-2">
              {canvases.length === 0 ? (
                <div className="px-1 py-3 text-center text-[10px] leading-tight text-ink-faint">
                  暂无画布
                </div>
              ) : (
                canvases.map((c) => {
                  const isActive =
                    pathname === '/canvas' && !creationOpen && c.id === activeId;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        useWorkspaceStore.getState().switchCanvas(c.id);
                        if (pathname !== '/canvas') navigate('/canvas');
                        setCreationOpen(false);
                      }}
                      title={c.name}
                      aria-label={c.name}
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors ${
                        isActive
                          ? 'bg-wash-strong text-ink'
                          : 'text-ink-muted hover:bg-wash hover:text-ink'
                      }`}
                    >
                      <CanvasThumb className="h-7 w-7" />
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
