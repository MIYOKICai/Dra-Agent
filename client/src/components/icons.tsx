/**
 * 统一线性 SVG 图标库（lucide 风格）：
 * - 20x20 viewBox、stroke=currentColor、strokeWidth 1.6、圆头圆角、fill none
 * - 颜色跟随使用处的 text-* 类，尺寸由 className 控制（建议 h-3.5 ~ h-5）
 * - 个别继承自 24 网格的专业路径（齿轮/刷新/扩音器）以 scale(5/6) 等比缩放嵌入，
 *   并按比例补偿 strokeWidth 保持视觉线宽一致。
 */
import type { FC, ReactNode, SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement>;
export type IconComponent = FC<IconProps>;

/** 图标基座：统一网格与描边参数 */
function IconBase({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/** 文字输入：T 字光标形 */
export function IconType(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4.2 5.2h11.6M10 5.2v9.6M7.4 14.8h5.2" />
    </IconBase>
  );
}

/** 图像生成：方框 + 太阳 + 山形 */
export function IconImage(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="3.5" width="14" height="13" rx="2.5" />
      <circle cx="7.3" cy="7.9" r="1.4" />
      <path d="M3.4 13.6l3.9-3.5 3 2.6 2.7-2.3 3.6 3.2" />
    </IconBase>
  );
}

/** AI / 星火：大小双四角星（凹边） */
export function IconSparkles(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9.2 3.2Q10 7.85 14.65 8.65Q10 9.45 9.2 14.1Q8.4 9.45 3.75 8.65Q8.4 7.85 9.2 3.2Z" />
      <path d="M15.3 12.6Q15.75 15.3 18.45 15.75Q15.75 16.2 15.3 18.9Q14.85 16.2 12.15 15.75Q14.85 15.3 15.3 12.6Z" />
    </IconBase>
  );
}

/** 提示词模板：文档 + 折角 + 文本行 */
export function IconFileText(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M11.7 2.5H6A1.5 1.5 0 004.5 4v12A1.5 1.5 0 006 17.5h8a1.5 1.5 0 001.5-1.5V6.3z" />
      <path d="M11.7 2.5v3.8h3.8" />
      <path d="M7.5 10.6h5M7.5 13.4h5" />
    </IconBase>
  );
}

/** 知识检索：放大镜 */
export function IconSearch(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="9" cy="9" r="5.4" />
      <path d="M13 13l4 4" />
    </IconBase>
  );
}

/** 条件分支：分支线 + 两提交点 */
export function IconGitBranch(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="15" cy="5" r="2" />
      <circle cx="5" cy="15" r="2" />
      <path d="M5 13V3.8" />
      <path d="M15 7.5a7.5 7.5 0 01-7.5 7.5" />
    </IconBase>
  );
}

/** 大模型调用：机器人头（天线 + 双眼 + 嘴） */
export function IconBot(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3.2" y="6.2" width="13.6" height="9.6" rx="2.4" />
      <path d="M10 6.2V3.6" />
      <circle cx="10" cy="2.7" r="0.8" />
      <circle cx="7.4" cy="11" r="1.05" fill="currentColor" stroke="none" />
      <circle cx="12.6" cy="11" r="1.05" fill="currentColor" stroke="none" />
      <path d="M8.2 13.3h3.6" />
    </IconBase>
  );
}

/** 输出节点：旗标 */
export function IconFlag(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5.5 17.5V3.2" />
      <path d="M5.5 4.2h8.8l-2.2 3 2.2 3H5.5" />
    </IconBase>
  );
}

/** 加号 */
export function IconPlus(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M10 5.2v9.6M5.2 10h9.6" />
    </IconBase>
  );
}

/** 回形针（附件上传） */
export function IconPaperclip(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M16.5 9.5l-6.2 6.2a3.4 3.4 0 0 1-4.8-4.8l7-7a2.4 2.4 0 0 1 3.4 3.4l-7 7a1.2 1.2 0 0 1-1.7-1.7l6.2-6.2" />
    </IconBase>
  );
}

/** 减号 */
export function IconMinus(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5.2 10h9.6" />
    </IconBase>
  );
}

/** 运行：三角播放 */
export function IconPlay(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M7.4 4.9v10.2L15.4 10z" />
    </IconBase>
  );
}

/** 停止：实心圆角方块描边 */
export function IconSquare(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="5.9" y="5.9" width="8.2" height="8.2" rx="1.5" />
    </IconBase>
  );
}

/**
 * 节点树：顶部节点块经直角引线接底部节点块，旁缀加号（新增节点）。
 * 由 1024 网格 fill 图标线性化重绘为 20 网格描边风格，currentColor 随上下文配色。
 */
export function IconNodeTree(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="2.2" y="2.2" width="5.6" height="4.6" rx="1.2" />
      <path d="M5 6.8v8.9a1.2 1.2 0 0 0 1.2 1.2h4.4" />
      <rect x="10.6" y="15.4" width="7.2" height="3" rx="1.1" />
      <path d="M14.4 7.4v4.4M12.2 9.6h4.4" />
    </IconBase>
  );
}

/**
 * 布局板：顶部通栏横条 + 左列两块小方块 + 右列竖长块（dashboard 分区）。
 * 由 1024 网格 fill 图标线性化重绘为 20 网格描边风格，currentColor 随上下文配色。
 */
export function IconLayoutBoard(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="2.5" y="3" width="15" height="3.5" rx="1" />
      <rect x="2.5" y="9" width="6.5" height="3" rx="1" />
      <rect x="2.5" y="14.5" width="6.5" height="3.5" rx="1" />
      <rect x="11.5" y="9" width="6" height="9" rx="1" />
    </IconBase>
  );
}

/** 设置：齿轮（feather 路径，24 网格等比缩放） */
export function IconSettings(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </g>
    </IconBase>
  );
}

/** 知识库：翻开的书 */
export function IconBook(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M10 4.6C8.4 3.3 6.3 2.9 4 3.1v12.8c2.3-.2 4.4.2 6 1.5 1.6-1.3 3.7-1.7 6-1.5V3.1c-2.3-.2-4.4.2-6 1.5z" />
      <path d="M10 4.6v12.8" />
    </IconBase>
  );
}

/** 更多：竖排省略号（水平三点） */
export function IconMore(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="4.6" cy="10" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="10" cy="10" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="15.4" cy="10" r="1.15" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

/** 上传 / 导入 */
export function IconUpload(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M10 12.6V4.2M6.6 7.6L10 4.2l3.4 3.4" />
      <path d="M4 13.4v1.5a1.6 1.6 0 001.6 1.6h8.8a1.6 1.6 0 001.6-1.6v-1.5" />
    </IconBase>
  );
}

/** 下载 / 导出 */
export function IconDownload(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M10 4.2v8.4M6.6 9.2L10 12.6l3.4-3.4" />
      <path d="M4 13.4v1.5a1.6 1.6 0 001.6 1.6h8.8a1.6 1.6 0 001.6-1.6v-1.5" />
    </IconBase>
  );
}

/** 复制：双层矩形（lucide copy，24 网格等比缩放，与拇指/分享等图标视觉尺寸一致） */
export function IconCopy(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
      </g>
    </IconBase>
  );
}

/** 工具调用：扳手（lucide wrench，24 网格等比缩放） */
export function IconWrench(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </g>
    </IconBase>
  );
}

/** 工具结果：终端提示符（lucide terminal，24 网格等比缩放） */
export function IconTerminal(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </g>
    </IconBase>
  );
}

/** 编辑：铅笔（lucide pencil，24 网格等比缩放） */
export function IconEdit(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
        <path d="m15 5 4 4" />
      </g>
    </IconBase>
  );
}

/** 上箭头（composer 发送 / 运行按钮） */
export function IconArrowUp(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M10 15.4V4.9M5.7 9.2L10 4.9l4.3 4.3" />
    </IconBase>
  );
}

/** 点赞：竖拇指向上的手形（lucide thumbs-up，24 网格等比缩放） */
export function IconThumbUp(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <path d="M7 10v12" />
        <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
      </g>
    </IconBase>
  );
}

/** 点踩：竖拇指向下的手形（lucide thumbs-down，24 网格等比缩放） */
export function IconThumbDown(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <path d="M17 14V2" />
        <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
      </g>
    </IconBase>
  );
}

/** 分享：三节点两连线（lucide share-2，24 网格等比缩放） */
export function IconShare(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <circle cx="18" cy="5" r="3" />
        <circle cx="6" cy="12" r="3" />
        <circle cx="18" cy="19" r="3" />
        <path d="m8.59 13.51 6.83 3.98" />
        <path d="m15.41 6.51-6.82 3.98" />
      </g>
    </IconBase>
  );
}

/** 用量：数据库圆柱（lucide database，24 网格等比缩放） */
export function IconDatabase(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M3 5v14a9 3 0 0 0 18 0V5" />
        <path d="M3 12a9 3 0 0 0 18 0" />
      </g>
    </IconBase>
  );
}

/** 朗读：扬声器双声波（lucide volume-2，24 网格等比缩放） */
export function IconVolume2(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <path d="M11 5 6 9H2v6h4l5 4V5Z" />
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      </g>
    </IconBase>
  );
}

/** 停止：方框（lucide square，朗读中点击停止播放） */
export function IconStop(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <rect width="18" height="18" x="3" y="3" rx="2" />
      </g>
    </IconBase>
  );
}

/** 删除：垃圾桶（lucide 24 艺术按 0.8333 缩放进 20 盒，字形占比与整套图标一致） */
export function IconTrash(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <path d="M3 6h18" />
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        <path d="M10 11v6M14 11v6" />
      </g>
    </IconBase>
  );
}

/** 关闭：X */
export function IconX(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
    </IconBase>
  );
}

/** 对勾 */
export function IconCheck(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4.6 10.7l3.3 3.3 7.5-8.3" />
    </IconBase>
  );
}

/** 重试：顺时针旋转箭头（lucide rotate-cw，24 网格等比缩放） */
export function IconRefresh(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
        <path d="M21 3v5h-5" />
      </g>
    </IconBase>
  );
}

/** 加载中：缺口圆环（lucide loader-circle，24 网格等比缩放；配合 animate-spin 做旋转动画） */
export function IconLoader(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </g>
    </IconBase>
  );
}

/** 图层 / 节点库 */
export function IconLayers(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M10 3.1L3.2 6.4 10 9.7l6.8-3.3z" />
      <path d="M3.2 10.2l6.8 3.3 6.8-3.3" />
      <path d="M3.2 13.8l6.8 3.3 6.8-3.3" />
    </IconBase>
  );
}

/** 下箭头 */
export function IconChevronDown(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5.8 8.2l4.2 4.2 4.2-4.2" />
    </IconBase>
  );
}

/** 左箭头（轮播上一张） */
export function IconChevronLeft(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M11.8 5.8L7.6 10l4.2 4.2" />
    </IconBase>
  );
}

/** 右箭头（轮播下一张） */
export function IconChevronRight(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M8.2 5.8l4.2 4.2-4.2 4.2" />
    </IconBase>
  );
}

/** 安全拦截：盾牌 + 对勾 */
export function IconShield(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M10 2.9l5.8 2.1v4.5c0 3.5-2.3 6.1-5.8 7.4-3.5-1.3-5.8-3.9-5.8-7.4V5z" />
      <path d="M7.6 9.9l1.7 1.7 3.1-3.3" />
    </IconBase>
  );
}

/** 课程 / 毕业：学位帽 */
export function IconGraduationCap(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M2.9 7.7L10 4.5l7.1 3.2L10 10.9z" />
      <path d="M5.9 9.5v3c0 1.3 1.85 2.3 4.1 2.3s4.1-1 4.1-2.3v-3" />
      <path d="M17.1 7.7v3.9" />
    </IconBase>
  );
}

/** 营销：扩音器（lucide megaphone，24 网格等比缩放） */
export function IconMegaphone(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <path d="m3 11 18-5v12L3 14v-3z" />
        <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
      </g>
    </IconBase>
  );
}

/** 展开：对角双箭头向外（lucide maximize-2，24 网格等比缩放） */
export function IconExpand(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <path d="M15 3h6v6" />
        <path d="M9 21H3v-6" />
        <path d="M21 3l-7 7" />
        <path d="M3 21l7-7" />
      </g>
    </IconBase>
  );
}

/** 收起：对角双箭头向内（lucide minimize-2，24 网格等比缩放） */
export function IconCollapse(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <path d="M4 14h6v6" />
        <path d="M20 10h-6V4" />
        <path d="M14 10l7-7" />
        <path d="M3 21l7-7" />
      </g>
    </IconBase>
  );
}

/** 研究：锥形瓶 */
export function IconFlask(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M7.8 2.9h4.4" />
      <path d="M8.7 2.9v5L4.5 14.9a2.5 2.5 0 002.2 3.7h6.6a2.5 2.5 0 002.2-3.7L11.3 7.9v-5" />
      <path d="M6.7 12.9h6.6" />
    </IconBase>
  );
}

/** 主题切换（当前暗色，点击切亮色）：太阳（lucide sun，24 网格等比缩放） */
export function IconSun(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2" />
        <path d="M12 20v2" />
        <path d="m4.93 4.93 1.41 1.41" />
        <path d="m17.66 17.66 1.41 1.41" />
        <path d="M2 12h2" />
        <path d="M20 12h2" />
        <path d="m6.34 17.66-1.41 1.41" />
        <path d="m19.07 4.93-1.41 1.41" />
      </g>
    </IconBase>
  );
}

/** 主题切换（当前亮色，点击切暗色）：月亮（lucide moon，24 网格等比缩放） */
export function IconMoon(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
      </g>
    </IconBase>
  );
}

/** 首页：屋顶 + 门 */
export function IconHome(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3.4 8.7 10 3.2l6.6 5.5v6.6a1.7 1.7 0 0 1-1.7 1.7H5.1a1.7 1.7 0 0 1-1.7-1.7z" />
      <path d="M8.1 17v-4.6h3.8V17" />
    </IconBase>
  );
}

/** 侧边栏开合：面板 + 左缘分隔线 */
export function IconPanelLeft(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3.2" y="3.6" width="13.6" height="12.8" rx="2.4" />
      <path d="M7.9 3.6v12.8" />
    </IconBase>
  );
}

/** 返回：左箭头（lucide 24 艺术按 0.8333 缩放进 20 盒，字形占比与整套图标一致） */
export function IconArrowLeft(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <path d="m12 19-7-7 7-7" />
        <path d="M19 12H5" />
      </g>
    </IconBase>
  );
}

/** 选择模式：鼠标指针（lucide mouse-pointer，同款缩放规范） */
export function IconCursor(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
      </g>
    </IconBase>
  );
}

/** 拖动模式：四向移动（lucide move，同款缩放规范） */
export function IconMove(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <path d="M5 9l-3 3 3 3" />
        <path d="M9 5l3-3 3 3" />
        <path d="M15 19l-3 3-3-3" />
        <path d="M19 9l3 3-3 3" />
        <path d="M2 12h20" />
        <path d="M12 2v20" />
      </g>
    </IconBase>
  );
}

/** 布局：四宫格（lucide layout-grid，同款缩放规范） */
export function IconGrid(props: IconProps) {
  return (
    <IconBase {...props}>
      <g transform="scale(0.8333)" strokeWidth={1.92}>
        <rect width="7" height="7" x="3" y="3" rx="1" />
        <rect width="7" height="7" x="14" y="3" rx="1" />
        <rect width="7" height="7" x="14" y="14" rx="1" />
        <rect width="7" height="7" x="3" y="14" rx="1" />
      </g>
    </IconBase>
  );
}
