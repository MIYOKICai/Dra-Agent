/**
 * NodeShell：所有节点的统一外壳（暗色沉浸式）。
 * 标签与状态悬浮在卡片上方（图标 + 双击改名标签 + 状态灯），
 * 卡片本体（children / 错误重试 / 拦截横幅 / 输出区）+ 左右连接点
 * （8px 小圆点，节点 hover / 选中时显现，见 index.css）。
 */
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Handle, Position } from '@xyflow/react';
import type { AgentStep, NodeOutput, NodeRunStatus } from '@shared/types';
import { useCanvasStore, type CanvasNodeData } from '../store/canvasStore';
import { useRunStore } from '../store/runStore';
import { NODE_DEFS } from './registry';
import { readImageConfig } from './nodeConfigs';
import { StreamingText } from '../components/StreamingText';
import { ImageGrid } from '../components/ImageGrid';
import { Lightbox } from '../components/Lightbox';
import { IconChevronLeft, IconChevronRight, IconRefresh, IconShield } from '../components/icons';

/**
 * 各运行状态的视觉元数据（墨色单色系，颜色随主题反相）：状态灯 + 边框。
 * 去彩色化后以亮度 / 形状 / 文字区分：running 前景灯脉冲 + 前景描边呼吸，
 * success 全亮前景灯 + 边框提亮，error 空心环灯 + 虚线描边（附文字），
 * blocked 暗灰灯（附文字），waiting 半透明，idle / skipped 最暗灰。
 */
const STATUS_META: Record<NodeRunStatus, { label: string; dot: string; border: string }> = {
  idle: { label: '空闲', dot: 'bg-dot-idle', border: 'border-line' },
  waiting: { label: '等待中', dot: 'bg-dot-dim', border: 'border-dot-idle' },
  running: {
    label: '运行中',
    dot: 'bg-ink animate-pulse',
    border: 'border-ink animate-node-breathe',
  },
  success: { label: '成功', dot: 'bg-ink', border: 'border-ink-muted' },
  error: {
    label: '错误',
    dot: 'border-[1.5px] border-ink-muted bg-transparent',
    border: 'border-ink-muted border-dashed',
  },
  blocked: { label: '已拦截', dot: 'bg-ink-muted', border: 'border-dot-idle' },
  skipped: { label: '已跳过', dot: 'bg-dot-idle', border: 'border-line' },
};

/** 连接点统一外观：8px 小圆点，默认透明，节点 hover / 选中时由 index.css 显现 */
const HANDLE_CLASS =
  '!h-2 !w-2 !rounded-full !border-0 !bg-ink-muted opacity-0 transition-all duration-150';

const STEP_KIND_LABELS: Record<AgentStep['kind'], string> = {
  thought: '思考',
  tool_call: '调用',
  tool_result: '结果',
  answer: '回答',
};

function hasOutput(output: NodeOutput): boolean {
  return Boolean(
    output.text !== undefined ||
      (output.images && output.images.length > 0) ||
      (output.fragments && output.fragments.length > 0) ||
      output.branch ||
      (output.steps && output.steps.length > 0)
  );
}

/** 节点运行产物渲染：text（流式光标）/ images（可放大）/ fragments / steps / branch */
function OutputView({
  output,
  streaming,
  hideText,
}: {
  output: NodeOutput;
  streaming: boolean;
  hideText?: boolean;
}) {
  return (
    <div className="no-scrollbar max-h-48 space-y-1.5 overflow-y-auto rounded-b-xl border-t border-line bg-base p-2">
      {!hideText && output.text !== undefined && (
        <StreamingText text={output.text} streaming={streaming} />
      )}
      {output.images && output.images.length > 0 && <ImageGrid images={output.images} />}
      {output.fragments && output.fragments.length > 0 && (
        <ul className="space-y-1">
          {output.fragments.map((f, i) => (
            <li key={i} className="rounded bg-elevated px-1.5 py-1 text-[10px] leading-snug">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-ink">{f.source}</span>
                <span className="shrink-0 font-mono text-ink-muted">{f.score.toFixed(2)}</span>
              </div>
              <p className="truncate text-ink-muted">{f.text}</p>
            </li>
          ))}
        </ul>
      )}
      {output.steps && output.steps.length > 0 && (
        <ol className="space-y-1">
          {output.steps.map((s, i) => (
            <li key={i} className="flex items-start gap-1.5 text-[10px] leading-snug">
              <span className="shrink-0 rounded bg-elevated px-1 font-mono text-ink-muted">
                {STEP_KIND_LABELS[s.kind]}
              </span>
              <span className="min-w-0 flex-1 truncate text-ink-muted">
                {s.tool ? `[${s.tool}] ` : ''}
                {s.content}
              </span>
            </li>
          ))}
        </ol>
      )}
      {output.branch && (
        <div className="flex items-center gap-1.5 text-[10px]">
          <span className="text-ink-muted">分流结果</span>
          <span
            className={`rounded px-1 font-mono ${
              output.branch === 'true' ? 'bg-wash-strong text-ink' : 'bg-wash text-ink-muted'
            }`}
          >
            {output.branch}
          </span>
        </div>
      )}
    </div>
  );
}

interface NodeShellProps {
  id: string;
  data: CanvasNodeData;
  selected?: boolean;
  children?: ReactNode;
  /** 关闭默认输出区渲染（如 output 节点用富文本布局自行展示） */
  hideDefaultOutput?: boolean;
}

/** AI 生成装配时的标题打字机：逐字显现 + 闪烁光标，播完回调 onDone（memo：重渲染不重置打字计时） */
const TypewriterLabel = memo(function TypewriterLabel({
  text,
  className,
  onDone,
}: {
  text: string;
  className?: string;
  onDone?: () => void;
}) {
  const [count, setCount] = useState(0);
  const doneCalled = useRef(false);
  useEffect(() => {
    if (count >= text.length) {
      if (!doneCalled.current) {
        doneCalled.current = true;
        onDone?.();
      }
      return;
    }
    const t = window.setTimeout(() => setCount((c) => c + 1), 55);
    return () => window.clearTimeout(t);
  }, [count, text.length, onDone]);
  const done = count >= text.length;
  return (
    <span className={className} title="双击重命名">
      {text.slice(0, count)}
      {!done && <span className="streaming-cursor h-[10px] w-[2px] bg-ink align-middle" />}
    </span>
  );
});

/** 从尺寸串（如 1024x1024 / 864x1152）解析宽高比，解析失败按 1:1 */
function parseRatio(size: string): number {
  const m = size.match(/^(\d+)x(\d+)$/i);
  return m ? Number(m[1]) / Number(m[2]) : 1;
}

/** 按图片比例的预览格：aspect-ratio 占位（未生成=虚线空态），图到后等比填充，点击放大 */
function RatioBox({ ratio, src }: { ratio: number; src?: string }) {
  const [zoom, setZoom] = useState(false);
  return (
    <>
      <div
        style={{ aspectRatio: String(ratio) }}
        className="max-h-72 overflow-hidden rounded-lg border bg-elevated/50"
      >
        {src ? (
          <img
            src={src}
            alt="生成图片"
            loading="lazy"
            onClick={() => setZoom(true)}
            className="h-full w-full cursor-zoom-in object-contain"
          />
        ) : null}
      </div>
      {zoom && src && <Lightbox src={src} alt="图片预览" onClose={() => setZoom(false)} />}
    </>
  );
}

/** 多图轮播：单图独占预览区，两侧悬浮左右切换钮，底部进度点指示当前张（点击图片放大） */
function ImageCarousel({ ratio, images }: { ratio: number; images: string[] }) {
  const [rawIdx, setIdx] = useState(0);
  const [zoom, setZoom] = useState(false);
  // 重跑后 images 变化时索引防越界
  const idx = Math.min(rawIdx, images.length - 1);
  const src = images[idx];
  const goto = (i: number) => setIdx((i + images.length) % images.length);
  return (
    <>
      <div
        style={{ aspectRatio: String(ratio) }}
        className="relative max-h-72 overflow-hidden rounded-lg border bg-elevated/50"
      >
        <img
          src={src}
          alt={`生成图片 ${idx + 1}/${images.length}`}
          loading="lazy"
          onClick={() => setZoom(true)}
          className="h-full w-full cursor-zoom-in object-contain"
        />
        {/* 左右切换钮：悬浮于图两侧（nodrag 防误触发节点拖拽） */}
        <button
          type="button"
          aria-label="上一张"
          title="上一张"
          onClick={(e) => {
            e.stopPropagation();
            goto(idx - 1);
          }}
          className="nodrag absolute left-1.5 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-panel/85 text-ink shadow-sm backdrop-blur transition-colors hover:bg-wash-strong"
        >
          <IconChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="下一张"
          title="下一张"
          onClick={(e) => {
            e.stopPropagation();
            goto(idx + 1);
          }}
          className="nodrag absolute right-1.5 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-panel/85 text-ink shadow-sm backdrop-blur transition-colors hover:bg-wash-strong"
        >
          <IconChevronRight className="h-3.5 w-3.5" />
        </button>
        {/* 底部进度点：当前张拉长加亮 */}
        <div className="absolute bottom-1.5 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1">
          {images.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`查看第 ${i + 1} 张`}
              onClick={(e) => {
                e.stopPropagation();
                setIdx(i);
              }}
              className={`nodrag h-1.5 rounded-full transition-all duration-200 ${
                i === idx ? 'w-3.5 bg-ink' : 'w-1.5 bg-ink-muted/60 hover:bg-ink-muted'
              }`}
            />
          ))}
        </div>
      </div>
      {zoom && <Lightbox src={src} alt="图片预览" onClose={() => setZoom(false)} />}
    </>
  );
}

/** 图像节点专属预览区：按配置尺寸的比例直接铺出占位区（空态虚线框），
 *  生成后同比例展示（单图独占，多图轮播 + 进度点），替代通用的小缩略图网格 */
function ImagePreviewArea({
  size,
  count,
  output,
  running,
}: {
  size: string;
  count: number;
  output?: NodeOutput;
  running: boolean;
}) {
  const ratio = parseRatio(size);
  const images = output?.images ?? [];
  const emptyHint = running ? '生成中…' : count > 1 ? `图像预览区（将生成 ×${count}）` : '图像预览区';
  return (
    <div className="space-y-1.5 border-t border-line bg-base p-2">
      {images.length > 1 ? (
        <ImageCarousel ratio={ratio} images={images} />
      ) : images.length === 1 ? (
        <RatioBox ratio={ratio} src={images[0]} />
      ) : (
        <div
          style={{ aspectRatio: String(ratio) }}
          className={`image-skeleton relative flex max-h-72 items-center justify-center overflow-hidden rounded-lg border border-line ${
            running ? 'skeleton-active' : ''
          }`}
        >
          <span className={`relative z-10 text-[10px] text-ink-muted ${running ? 'animate-pulse' : ''}`}>
            {emptyHint}
          </span>
        </div>
      )}
    </div>
  );
}

export function NodeShell({ id, data, selected, children, hideDefaultOutput }: NodeShellProps) {
  const def = NODE_DEFS[data.type];
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const isRunning = useRunStore((s) => s.isRunning);
  /** AI 生成逐节点装配的入场标记：播入场动画 + 标题打字机，两者都完成后由 store 摘除 */
  const entering = useCanvasStore((s) => Boolean(s.enteringIds?.[id]));
  /** 拖入落点缩放过渡标记：幽灵卡片 100% 尺寸 vs 画布缩放后实际大小，从 1/zoom 平滑缩到位 */
  const spawnScale = useCanvasStore((s) => s.spawnScales?.[id]);
  /** 入场收尾双标记：动画结束 + 打字完成取晚者，避免长标题被动画收尾截断 */
  const enterEndRef = useRef({ anim: false, typed: false });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.label);
  const status = data.status ?? 'idle';
  const meta = STATUS_META[status];

  const maybeEndEnter = useCallback(() => {
    const f = enterEndRef.current;
    if (f.anim && f.typed) useCanvasStore.getState().endNodeEnter(id);
  }, [id]);

  const handleTypedDone = useCallback(() => {
    enterEndRef.current.typed = true;
    maybeEndEnter();
  }, [maybeEndEnter]);

  /** 兜底清除入场标记：标签页节流等导致 animationend / 打字回调不触发时强制摘除 */
  useEffect(() => {
    if (!entering) return;
    enterEndRef.current = { anim: false, typed: false };
    const t = window.setTimeout(() => useCanvasStore.getState().endNodeEnter(id), 1600);
    return () => window.clearTimeout(t);
  }, [entering, id]);

  /** 兜底清除落点缩放标记：animationend 不触发时 600ms 强制摘除 */
  useEffect(() => {
    if (!spawnScale) return;
    const t = window.setTimeout(() => useCanvasStore.getState().endNodeSpawn(id), 600);
    return () => window.clearTimeout(t);
  }, [spawnScale, id]);

  const commitLabel = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== data.label) {
      updateNodeData(id, { label: next });
    } else {
      setDraft(data.label);
    }
  };

  /** 错误重试：从本节点起重跑（下游一并刷新）；运行中禁用 */
  const onRetry = () => {
    if (!isRunning) useRunStore.getState().rerunFrom(id);
  };

  /** blocked 态的拦截原因：执行器把原因写进 output.text 的「[已拦截] 」前缀之后 */
  const blockedReason =
    status === 'blocked'
      ? (data.output?.text ?? '').replace(/^\[已拦截\]\s*/, '') || '内容被安全策略拦截'
      : null;

  return (
    /* node-card：聚焦模式的缩放锚点（index.css 对 .focus-mode 下选中节点的该层做 scale，
       不动 .react-flow__node 的 transform 以免破坏 RF translate 定位） */
    <div
      className={`node-card group relative w-[280px] ${status === 'skipped' ? 'node-skipped' : ''} ${
        entering ? 'animate-node-enter' : ''
      } ${spawnScale ? 'animate-node-spawn' : ''}`}
      style={
        spawnScale ? ({ '--spawn-from': String(spawnScale) } as CSSProperties) : undefined
      }
      onAnimationEnd={(e) => {
        // 只认节点本体动画结束（子元素如光标闪烁的 animationend 会冒泡，须排除）
        if (entering && e.target === e.currentTarget && e.animationName === 'node-enter') {
          enterEndRef.current.anim = true;
          maybeEndEnter();
        }
        if (spawnScale && e.target === e.currentTarget && e.animationName === 'node-spawn') {
          useCanvasStore.getState().endNodeSpawn(id);
        }
      }}
    >
      {/* 浮动头部：图标 + 可编辑标签 + 状态灯（悬浮在卡片上方） */}
      <div className="absolute bottom-full left-0 z-10 mb-1.5 flex items-center gap-1.5 whitespace-nowrap">
        <def.icon className={`h-3.5 w-3.5 shrink-0 ${def.color}`} />
        {editing ? (
          <input
            className="nodrag node-label-input w-44 rounded border border-ink-muted bg-base px-1 py-0.5 text-[11px] text-ink"
            value={draft}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                setDraft(data.label);
                setEditing(false);
              }
            }}
          />
        ) : entering ? (
          <TypewriterLabel
            text={data.label}
            className="max-w-[190px] truncate text-[11px] font-medium text-ink-muted"
            onDone={handleTypedDone}
          />
        ) : (
          <span
            className="max-w-[190px] cursor-text truncate text-[11px] font-medium text-ink-muted transition-colors group-hover:text-ink"
            title="双击重命名"
            onDoubleClick={() => {
              setDraft(data.label);
              setEditing(true);
            }}
          >
            {data.label}
          </span>
        )}
        {(status === 'error' || status === 'blocked') && (
          <span
            className={`shrink-0 text-[10px] leading-none ${
              status === 'error' ? 'text-ink' : 'text-ink-muted'
            }`}
          >
            {meta.label}
          </span>
        )}
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`}
          title={meta.label + (data.error ? `：${data.error}` : '')}
        />
      </div>

      {/* 卡片本体：无内部标题栏，正文直接开始；选中走 --focus-glow 光晕（暗=白光/亮=黑柔光） */}
      <div
        className={`w-[280px] overflow-hidden rounded-xl border bg-panel transition-colors ${
          selected
            ? 'border-ink shadow-[0_0_0_1px_var(--focus-glow-ring),0_0_18px_var(--focus-glow)]'
            : `shadow-md shadow-black/30 ${meta.border} ${
                status === 'idle' ? 'hover:border-ink-muted' : ''
              }`
        }`}
      >
        {/* 正文（各节点类型自行填充） */}
        {children}

        {/* blocked 拦截说明（墨色横幅） */}
        {blockedReason && (
          <div className="flex items-start gap-1.5 border-t border-line bg-wash p-2 text-[10px] leading-snug text-ink-muted">
            <IconShield className="mt-px h-3 w-3 shrink-0" />
            <span className="min-w-0 break-all">已被安全策略拦截：{blockedReason}</span>
          </div>
        )}

        {/* 运行错误信息 + 重试（单节点重跑，运行中禁用） */}
        {data.error && (
          <div className="flex items-start gap-1.5 border-t border-dashed border-line bg-wash p-2 text-[10px] text-ink-muted">
            <span className="min-w-0 flex-1 break-all leading-snug">{data.error}</span>
            <button
              type="button"
              className="flex shrink-0 items-center gap-1 rounded border border-ink-muted px-1.5 py-0.5 text-[10px] leading-none text-ink transition-colors hover:border-ink hover:bg-wash-strong disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isRunning}
              title={isRunning ? '运行中，请先取消当前运行' : '从该节点起重跑（含下游）'}
              onClick={onRetry}
            >
              <IconRefresh className="h-2.5 w-2.5" />
              重试
            </button>
          </div>
        )}

        {/* 输出区：图像节点用比例预览区（含未生成的空态占位）；其余走通用输出。
            运行中（LLM / Agent 文本流）显示流式光标；blocked 时文本由拦截横幅承载。
            仅本节点正在生成（running）时占位区播骨架屏，排队/等待不播 */}
        {!hideDefaultOutput && data.type === 'image' && (
          <ImagePreviewArea
            size={readImageConfig(data.config).size}
            count={readImageConfig(data.config).count}
            output={data.output}
            running={status === 'running'}
          />
        )}
        {!hideDefaultOutput && data.type !== 'image' && data.output && hasOutput(data.output) && (
          <OutputView
            output={data.output}
            streaming={status === 'running'}
            hideText={status === 'blocked'}
          />
        )}
      </div>

      {/* 连接点：目标在左、来源在右（hover / 选中时显现） */}
      {def.hasTargetHandle && (
        <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />
      )}
      {def.sourceHandles.map((h, i) => {
        const multi = def.sourceHandles.length > 1;
        return (
          <Handle
            key={h.id}
            type="source"
            position={Position.Right}
            id={h.id}
            className={HANDLE_CLASS}
            style={multi ? { top: `${((i + 1) / (def.sourceHandles.length + 1)) * 100}%` } : undefined}
          >
            {multi && (
              <span className="pointer-events-none absolute left-full top-1/2 ml-1.5 -translate-y-1/2 whitespace-nowrap text-[9px] font-medium text-ink-muted opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                {h.label}
              </span>
            )}
          </Handle>
        );
      })}
    </div>
  );
}
