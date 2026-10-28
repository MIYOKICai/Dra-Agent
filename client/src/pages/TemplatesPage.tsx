/**
 * 模板中心页面（/templates）：沿用画布页的整体框架——左侧项目侧边栏 + 右侧内容区，
 * 右侧（原画布区域）为每行 3 张的模板卡片墙。
 * 卡片封面不再是静态图片，而是模板工作流的「画布投影」（点阵底 + 节点 + 连线）；
 * 点击整卡时新建一块画布应用模板，卡片矩形平滑展开为全屏投影，随后进入画布直接使用。
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from '../templates';
import { applyTemplateToNewCanvas } from '../templates/loader';
import { ProjectSidebar } from '../components/canvas/ProjectSidebar';
import { TemplatePreview } from '../components/templates/TemplatePreview';
import { useExpandStore } from '../store/expandStore';
import { KBPanel } from '../panels/KBPanel';
import { useUiStore } from '../store/uiStore';
import { IconSparkles } from '../components/icons';

/** 卡片：画布投影 + 「模板」徽标 + 悬停「使用模板」 */
function TemplateCard({
  template,
  onUse,
}: {
  template: WorkflowTemplate;
  onUse: (template: WorkflowTemplate, cover: HTMLElement | null) => void;
}) {
  return (
    <button
      type="button"
      onClick={(event) =>
        void onUse(template, event.currentTarget.querySelector<HTMLElement>('[data-template-cover]'))
      }
      aria-label={`使用模板：${template.name}。${template.description}`}
      className="group block w-full text-left"
    >
      <div
        data-template-cover
        className="relative aspect-[16/10] overflow-hidden rounded-2xl border border-line bg-base"
      >
        <TemplatePreview template={template} />

        {/* 左上角模板徽标 */}
        <span className="absolute left-3 top-3 rounded-lg bg-black/45 px-2 py-1 text-[11px] font-medium text-white backdrop-blur-sm">
          模板
        </span>

        {/* 悬停动作：整卡可点，遮罩提示「使用模板」 */}
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-300 group-hover:bg-black/35 group-hover:opacity-100 group-focus-visible:bg-black/35 group-focus-visible:opacity-100">
          <span className="flex items-center gap-1.5 rounded-full bg-mono px-3.5 py-2 text-xs font-medium text-mono-fg">
            <IconSparkles className="h-3.5 w-3.5" />
            使用模板
          </span>
        </span>
      </div>
      <h3 className="mt-3 truncate text-[15px] font-medium text-ink">{template.name}</h3>
    </button>
  );
}

export function TemplatesPage() {
  const navigate = useNavigate();
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const startExpand = useExpandStore((s) => s.start);

  /** 模板中心以左侧栏为导航，进入时默认展开 */
  useEffect(() => {
    setSidebarOpen(true);
  }, [setSidebarOpen]);

  const onUse = async (template: WorkflowTemplate, cover: HTMLElement | null) => {
    // 每次使用模板都新建一块画布来应用（当前画布内容原样保留）；失败则不进入画布
    if (!(await applyTemplateToNewCanvas(template))) return;
    // 展开进入画布时收起侧边栏，落点即为全宽画布
    setSidebarOpen(false);
    const box = cover?.getBoundingClientRect();
    if (!box) {
      navigate('/canvas');
      return;
    }
    // 展开 → 导航 → 淡出的全部时序交给挂在 <Routes> 之上的 TemplateExpandOverlay
    // （过渡层跨路由不卸载，导航发生在投影背后，无跨页闪帧）
    startExpand(template, {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
    });
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-base text-ink">
      {/* 左侧项目侧边栏：与画布页共用，推入式布局 */}
      <ProjectSidebar />

      {/* 右侧内容区：原画布位置替换为模板卡片墙 */}
      <div className="relative min-w-0 flex-1 overflow-y-auto">
        {/* 画布式浮动 header：左侧徽标（开合侧边栏）+ 标题胶囊，右侧「进入画布」 */}
        <div className="pointer-events-none absolute inset-x-4 top-4 z-20 flex items-start justify-between gap-3">
          <div className="pointer-events-auto flex items-center gap-2.5">
            <button
              type="button"
              onClick={toggleSidebar}
              title="展开 / 收起侧边栏"
              aria-label="展开 / 收起侧边栏"
              className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-mono text-mono-fg shadow-lg shadow-black/40 transition-opacity hover:opacity-90"
            >
              <IconSparkles className="h-4 w-4" />
            </button>
            <div className="flex h-11 items-center gap-3 rounded-xl border border-line bg-panel px-3 shadow-lg shadow-black/40 backdrop-blur">
              <span className="text-sm font-medium text-ink">模板中心</span>
              <span className="h-3.5 w-px bg-line" />
              <span className="text-xs tabular-nums text-ink-muted">
                {String(WORKFLOW_TEMPLATES.length).padStart(2, '0')} 个模板
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => navigate('/canvas')}
            className="pointer-events-auto flex h-11 shrink-0 items-center gap-2 rounded-xl bg-mono px-4 text-sm font-medium text-mono-fg shadow-lg shadow-black/40 transition-colors hover:bg-mono-hover"
          >
            进入画布
          </button>
        </div>

        <div className="mx-auto w-full max-w-7xl px-6 pb-20 pt-[92px]">
          {/* 分区标题 */}
          <div className="flex items-end justify-between gap-6">
            <div>
              <p className="text-[11px] tracking-[0.14em] text-ink-muted">TEMPLATES</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-ink">
                从一条完整工作流开始
              </h2>
            </div>
            <p className="hidden max-w-xs pb-1 text-xs leading-relaxed text-ink-muted md:block">
              选择一个模板即新建画布应用：模型与知识库会自动回填，节点与连线均可继续编辑。
            </p>
          </div>

          {/* 每行 3 张卡片 */}
          <div className="mt-8 grid grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
            {WORKFLOW_TEMPLATES.map((template) => (
              <TemplateCard key={template.id} template={template} onUse={onUse} />
            ))}
          </div>
        </div>
      </div>

      {/* 侧边栏「知识库」入口在本页同样可用 */}
      <KBPanel />
    </div>
  );
}
