/**
 * 落地页（/）：按 workbuddy.cn 原站结构镜像重构——
 * 居中导航（右侧昼夜切换 + 进入画布）/ 巨型标题 hero + 双 CTA + 画布投影展示面板 /
 * AI 场景标签页（真实模板投影卡片）/ 模型生态无限跑马灯 / 安全合规三栏 /
 * GET STARTED 分组网格 / 黑色页脚（含巨型水印）。
 * 主题与画布页共用 uiStore，html.light 双向同步。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { WORKFLOW_TEMPLATES } from '../templates';
import { TemplatePreview } from '../components/templates/TemplatePreview';
import { useUiStore } from '../store/uiStore';
import {
  IconLayers,
  IconMoon,
  IconSettings,
  IconShield,
  IconSparkles,
  IconSun,
} from '../components/icons';

/** hero 展示屏使用的模板：多 Agent 研究助手（输入 → Agent → 大模型 → 输出） */
const HERO_TEMPLATE =
  WORKFLOW_TEMPLATES.find((t) => t.id === 'research-agent') ?? WORKFLOW_TEMPLATES[0];

/** 一次性渐入：进入视口后 translate + opacity 过渡显现 */
function FadeIn({
  children,
  className = '',
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!('IntersectionObserver' in window)) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setShown(true);
            io.disconnect();
          }
        }),
      { threshold: 0.15 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className={`${className} transition-all duration-700 ease-out ${
        shown ? 'translate-y-0 opacity-100' : 'translate-y-5 opacity-0'
      }`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

/** 双段区块标签（如「AI 场景 / AI SCENARIOS」）：中文 + 分隔线 + 英文 */
function Tag({ zh, en }: { zh: string; en: string }) {
  return (
    <p className="inline-flex items-center gap-2.5 text-[11px] font-medium tracking-[0.14em] text-ink-muted">
      <span>{zh}</span>
      <span className="h-3 w-px bg-line" />
      <span className="tracking-[0.22em]">{en}</span>
    </p>
  );
}

/* ============================= 导航 ============================= */

const NAV_LINKS: { label: string; href: string; route?: boolean }[] = [
  { label: '场景', href: '#scenarios' },
  { label: '生态', href: '#ecosystem' },
  { label: '安全', href: '#privacy' },
  { label: '模板中心', href: '/templates', route: true },
];

/**
 * 顶部导航（滚动感知双态，形态由页面根组件的哨兵观测驱动）：
 * - 顶部：全宽毛玻璃通栏，镜像 workbuddy.cn 实测规格（半透明底 + 16px 模糊 + 底部 1px 浅描边），
 *   三栏网格真居中主导航（14px / 8px 圆角悬停底）。
 * - 下滑：收缩为悬浮药丸，镜像 deepseek.com 下滑态——收窄至内容容器宽度（max-w-6xl，
 *   左右至少 16px），药丸边缘正好落在 logo 与主 CTA 位置上，收缩过程内容零位移；
 */
function Nav({ scrolled }: { scrolled: boolean }) {
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  return (
    <header
      className={`fixed z-50 transition-all duration-300 ${
        scrolled
          ? 'inset-x-4 top-3 mx-auto max-w-6xl rounded-full border border-line bg-glass shadow-lg shadow-black/40 backdrop-blur-lg'
          : 'inset-x-0 top-0 mx-auto max-w-full border border-transparent bg-base'
      }`}
    >
      <div
        className={`mx-auto grid max-w-6xl grid-cols-[1fr_auto_1fr] items-center px-5 transition-all duration-300 ${
          scrolled ? 'h-14' : 'h-16'
        }`}
      >
        <Link to="/" className="flex items-center gap-2 justify-self-start">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-mono text-mono-fg">
            <IconSparkles className="h-4 w-4" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-ink">Dra-Agent</span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((link) =>
            link.route ? (
              <Link
                key={link.href}
                to={link.href}
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-muted transition-colors hover:bg-wash hover:text-ink"
              >
                {link.label}
              </Link>
            ) : (
              <a
                key={link.href}
                href={link.href}
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-muted transition-colors hover:bg-wash hover:text-ink"
              >
                {link.label}
              </a>
            )
          )}
        </nav>

        <div className="flex items-center gap-2.5 justify-self-end">
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? '切换到白天模式' : '切换到黑夜模式'}
            title={theme === 'dark' ? '切换到白天模式' : '切换到黑夜模式'}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-line text-ink-muted transition-colors hover:bg-wash hover:text-ink"
          >
            {theme === 'dark' ? <IconSun className="h-4 w-4" /> : <IconMoon className="h-4 w-4" />}
          </button>
          <Link
            to="/canvas"
            className="flex h-9 items-center rounded-full bg-mono px-5 text-[13px] font-medium text-mono-fg transition-opacity hover:opacity-90"
          >
            进入画布
          </Link>
        </div>
      </div>
    </header>
  );
}

/* ============================= Hero ============================= */

function Hero() {
  return (
    <section className="relative overflow-hidden pt-28 sm:pt-36">
      <div className="mx-auto max-w-6xl px-5 text-center">
        <FadeIn>
          <h1 className="text-5xl font-bold tracking-tight text-ink sm:text-7xl">Dra-Agent</h1>
        </FadeIn>
        <FadeIn delay={80}>
          <p className="mx-auto mt-6 max-w-2xl text-sm leading-relaxed text-ink-muted sm:text-base">
            Dra-Agent 是一款开源的 AI Agent 画布工作台。说出想法、编排节点、交付完整成果。
            完美衔接主流模型生态，你的创作好搭子。
          </p>
        </FadeIn>
        <FadeIn delay={160}>
          <div className="mt-8 flex items-center justify-center gap-6">
            <Link
              to="/canvas"
              className="flex h-11 items-center rounded-full bg-mono px-7 text-sm font-medium text-mono-fg transition-opacity hover:opacity-90"
            >
              立即体验 Dra-Agent
            </Link>
            <Link
              to="/templates"
              className="text-sm text-ink underline-offset-4 transition-opacity hover:underline hover:opacity-80"
            >
              浏览模板中心
            </Link>
          </div>
        </FadeIn>
      </div>

      {/* 展示面板：真实画布投影（多 Agent 研究助手模板） */}
      <FadeIn delay={220} className="mx-auto mt-14 max-w-6xl px-5">
        <div className="relative">
          <div
            aria-hidden="true"
            className="absolute -top-24 left-1/2 h-60 w-[80%] -translate-x-1/2 rounded-full opacity-70 blur-3xl"
            style={{ backgroundImage: 'radial-gradient(closest-side, var(--wash-strong), transparent)' }}
          />
          <div className="relative rounded-[24px] border border-line bg-panel p-2 sm:p-3">
            <div className="relative h-[420px] overflow-hidden rounded-2xl border border-line sm:h-[560px]">
              <TemplatePreview template={HERO_TEMPLATE} demo />
            </div>
          </div>
        </div>
      </FadeIn>
    </section>
  );
}

/* ===================== AI 场景（标签页 + 模板投影） ===================== */

interface Scenario {
  key: string;
  tab: string;
  title: string;
  sub: string;
  desc: string;
  templateId: string;
}

const SCENARIOS: Scenario[] = [
  {
    key: 'research',
    tab: '研究',
    title: '深度调研',
    sub: '从查资料到给结论，几分钟交付报告',
    desc: '告诉 Dra-Agent 你要研究的课题，它会拆解检索路径、交叉验证信息源，再生成结构化报告与结论建议。',
    templateId: 'research-agent',
  },
  {
    key: 'copy',
    tab: '文档',
    title: '营销文案与配图',
    sub: '从卖点提炼到成稿配图，一气呵成',
    desc: '说出产品与目标人群，它会先写文案、再生成配图，文字与视觉在同一条工作流里对齐。',
    templateId: 'marketing-copy',
  },
  {
    key: 'book',
    tab: '设计',
    title: '绘本创作',
    sub: '从故事大纲到成页画面，逐页生成',
    desc: '给它一个主题，它会规划分页故事，逐页生成画面与文字，成品直接在节点里预览。',
    templateId: 'picture-book',
  },
  {
    key: 'image',
    tab: '图像',
    title: '图文互译',
    sub: '文字与图像双向生成',
    desc: '文生图、图生文在同一条链路：输入描述生成图像，也可以反过来让模型读懂图像。',
    templateId: 'text-to-image',
  },
];

function Scenarios() {
  const [active, setActive] = useState(0);
  const current = SCENARIOS[active];
  const template =
    WORKFLOW_TEMPLATES.find((t) => t.id === current.templateId) ?? WORKFLOW_TEMPLATES[0];
  return (
    <section id="scenarios" className="mx-auto max-w-6xl scroll-mt-16 px-5 pt-24">
      <FadeIn className="text-center">
        <Tag zh="AI 场景" en="AI SCENARIOS" />
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          你的创作好帮手
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-ink-muted">
          把任务交给它，Dra-Agent
          会自主规划节点、调用模型与工具、生成文件，并把过程与结果都留在画布上供你审核。
        </p>
      </FadeIn>

      <FadeIn delay={80}>
        <div className="mt-8 flex flex-wrap justify-center gap-2">
          {SCENARIOS.map((scenario, index) => (
            <button
              key={scenario.key}
              type="button"
              onClick={() => setActive(index)}
              aria-pressed={index === active}
              className={`flex h-9 items-center rounded-full px-5 text-[13px] transition-colors ${
                index === active
                  ? 'bg-mono font-medium text-mono-fg'
                  : 'border border-line text-ink-muted hover:text-ink'
              }`}
            >
              {scenario.tab}
            </button>
          ))}
        </div>
      </FadeIn>

      <FadeIn delay={140}>
        <div className="mt-8 grid items-center gap-8 rounded-[24px] border border-line bg-panel p-6 sm:p-10 lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <h3 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">
              {current.title}
            </h3>
            <p className="mt-1.5 text-sm text-ink-muted">{current.sub}</p>
            <p className="mt-4 text-sm leading-relaxed text-ink-muted">{current.desc}</p>
            <Link
              to="/templates"
              className="mt-6 inline-flex h-9 items-center rounded-full border border-line px-4 text-[13px] text-ink transition-colors hover:bg-wash"
            >
              使用该模板 →
            </Link>
          </div>
          {/* 真实模板投影：key 随模板切换重挂载，引导期禁用节点过渡避免飞入 */}
          <div
            key={current.templateId}
            className="relative aspect-[16/10] overflow-hidden rounded-2xl border border-line bg-base"
          >
            <TemplatePreview template={template} demo />
          </div>
        </div>
      </FadeIn>
    </section>
  );
}

/* ======================= 模型生态（无限跑马灯） ======================= */

const PROVIDERS = ['DeepSeek', '火山方舟', 'OpenAI', 'Anthropic', '通义千问', '智谱 GLM'];

function Ecosystem() {
  // 每个半区重复两轮服务商，保证轨道宽度覆盖超宽视口，-50% 平移无缝循环
  const half = [...PROVIDERS, ...PROVIDERS];
  return (
    <section id="ecosystem" className="scroll-mt-16 pt-24">
      <div className="mx-auto max-w-6xl px-5 text-center">
        <FadeIn>
          <h2 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            Dra-Agent 打通主流模型生态
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-ink-muted">
            无缝连接文本生成、图像生成与知识检索等常用能力，服务商与模型一处配置、全画布生效。
          </p>
        </FadeIn>
      </div>
      <FadeIn delay={100}>
        <div className="lp-marquee-mask mt-12 overflow-hidden">
          <div className="lp-marquee-track">
            {[0, 1].map((copy) => (
              <div key={copy} aria-hidden={copy === 1} className="flex gap-3 pr-3">
                {half.map((provider, index) => (
                  <span
                    key={`${provider}-${index}`}
                    className="flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-xl border border-line bg-panel px-6 py-3.5 text-sm text-ink"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-ink-muted" />
                    {provider}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </FadeIn>
    </section>
  );
}

/* ============================= 安全合规 ============================= */

const PRIVACY = [
  {
    icon: IconLayers,
    title: '全链路本地存储',
    desc: '画布、节点与运行产物全部保存在本地浏览器，离线可开、随时恢复，数据不出你的设备。',
  },
  {
    icon: IconSettings,
    title: '密钥自主可控',
    desc: 'API Key 仅存于本地并直连模型服务商，不经过任何第三方服务器，随时可撤销更换。',
  },
  {
    icon: IconShield,
    title: '开源可审计',
    desc: '核心代码开源可审查，节点与连线结构一目了然，每一次模型调用都可在画布上追溯。',
  },
];

function Privacy() {
  return (
    <section id="privacy" className="mx-auto max-w-6xl scroll-mt-16 px-5 pt-24">
      <FadeIn>
        <div className="rounded-[24px] border border-line bg-panel p-8 sm:p-12">
          <div className="text-center">
            <Tag zh="安全合规" en="PRIVACY & SECURITY" />
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
              隐私与安全
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-ink-muted">
              本地优先的安全架构与全链路数据保护，让每一次协作都可信、可控、可追溯。
            </p>
          </div>
          <div className="mt-12 grid gap-10 sm:grid-cols-3">
            {PRIVACY.map((item) => (
              <div key={item.title} className="text-center">
                <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-wash text-ink">
                  <item.icon className="h-5 w-5" />
                </span>
                <h3 className="mt-4 text-[15px] font-medium text-ink">{item.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </FadeIn>
    </section>
  );
}

/* ===================== 免费开始（GET STARTED 分组网格） ===================== */

const START_GROUPS: { group: string; items: { name: string; note: string; to?: string }[] }[] = [
  {
    group: '在线使用',
    items: [
      { name: '进入画布', note: '适用于 即开即用', to: '/canvas' },
      { name: '模板中心', note: '适用于 一键载入完整工作流', to: '/templates' },
    ],
  },
  {
    group: '本地优先',
    items: [
      { name: '本地持久化', note: '适用于 离线保存画布与产物' },
      { name: '密钥自管', note: '适用于 直连模型服务商' },
    ],
  },
];

function StartCta() {
  return (
    <section id="download" className="scroll-mt-16 pt-24">
      <div className="mx-auto max-w-6xl px-5">
        <FadeIn className="text-center">
          <Tag zh="免费开始 · 无限可能" en="GET STARTED" />
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            立即体验 高效创作
          </h2>
        </FadeIn>
        <div className="mx-auto mt-12 grid max-w-3xl gap-8 sm:grid-cols-2">
          {START_GROUPS.map((group, groupIndex) => (
            <FadeIn key={group.group} delay={groupIndex * 80}>
              <p className="text-[13px] font-medium text-ink-muted">{group.group}</p>
              <div className="mt-4 grid gap-3">
                {group.items.map((item) => {
                  const cls =
                    'flex items-center justify-between gap-4 rounded-2xl border border-line bg-panel px-5 py-4';
                  return item.to ? (
                    <Link
                      key={item.name}
                      to={item.to}
                      className={`${cls} transition-colors hover:bg-wash`}
                    >
                      <span className="text-[15px] font-medium text-ink">{item.name}</span>
                      <span className="text-right text-xs text-ink-muted">{item.note}</span>
                    </Link>
                  ) : (
                    <div key={item.name} className={cls}>
                      <span className="text-[15px] font-medium text-ink">{item.name}</span>
                      <span className="text-right text-xs text-ink-muted">{item.note}</span>
                    </div>
                  );
                })}
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ============================= 页脚 ============================= */

const FOOTER_COLUMNS: { title: string; links: { label: string; to: string }[] }[] = [
  {
    title: '产品',
    links: [
      { label: '画布', to: '/canvas' },
      { label: '模板中心', to: '/templates' },
      { label: '场景介绍', to: '/#scenarios' },
    ],
  },
  {
    title: '资源',
    links: [
      { label: '模型生态', to: '/#ecosystem' },
      { label: '隐私与安全', to: '/#privacy' },
    ],
  },
  {
    title: '关于',
    links: [
      { label: '参赛项目', to: '/#download' },
      { label: '回到顶部', to: '/#top' },
    ],
  },
];

function Footer() {
  return (
    <footer className="relative mt-24 overflow-hidden bg-[#0a0a0a] text-zinc-500">
      <div className="mx-auto max-w-6xl px-5 pb-10 pt-16">
        <div className="flex flex-col gap-10 md:flex-row md:justify-between">
          <div>
            <p className="text-xl font-bold tracking-tight text-white">
              DRA-AGENT<span className="text-zinc-600">&gt;</span>
            </p>
            <p className="mt-3 max-w-xs text-xs leading-relaxed">
              开源、可托管的 AI
              智能体画布。把想法编排成工作流，把工作流跑成结果。
            </p>
          </div>
          <div className="grid grid-cols-3 gap-10 text-xs">
            {FOOTER_COLUMNS.map((column) => (
              <div key={column.title}>
                <p className="font-medium text-zinc-300">{column.title}</p>
                <ul className="mt-3 space-y-2.5">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <Link to={link.to} className="transition-colors hover:text-zinc-200">
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-12 border-t border-white/10 pt-5 text-[11px]">
          © 2026 Dra-Agent · AI Agent 画布参赛作品
        </div>
      </div>
      {/* 巨型水印字（超出裁切，纯装饰） */}
      <div
        aria-hidden="true"
        className="pointer-events-none select-none whitespace-nowrap text-center text-[13vw] font-bold leading-[0.72] text-white/[0.035]"
      >
        DRA-AGENT&gt;
      </div>
    </footer>
  );
}

/* ============================= 页面根 ============================= */

export function Landing() {
  /** 页顶哨兵观测：哨兵钉在文档 24px 处，滚出视口顶缘 → Nav 进入药丸态（不依赖 scroll 事件） */
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !('IntersectionObserver' in window)) {
      setScrolled(window.scrollY > 24);
      return;
    }
    // 哨兵（1px，位于文档 y=24）+ scroll 事件双触发，回调统一按「当前 scrollY」判定：
    // 纯函数无竞态——过期的 IO 帧到达时会被最新 scrollY 纠偏，两机制不会互相拉扯抖动。
    const apply = () => setScrolled(window.scrollY > 24);
    const io = new IntersectionObserver(apply, { threshold: 0 });
    io.observe(sentinel);
    apply();
    window.addEventListener('scroll', apply, { passive: true, capture: true });
    return () => {
      io.disconnect();
      window.removeEventListener('scroll', apply, { capture: true });
    };
  }, []);

  return (
    <div id="top" className="relative min-h-screen bg-base text-ink">
      {/* 页顶哨兵（文档 24px 处的 1px 线）：Nav 据此判断是否滚入药丸态 */}
      <div
        ref={sentinelRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-6 h-px"
      />
      <Nav scrolled={scrolled} />
      <main>
        <Hero />
        <Scenarios />
        <Ecosystem />
        <Privacy />
        <StartCta />
      </main>
      <Footer />
    </div>
  );
}
