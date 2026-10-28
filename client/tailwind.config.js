/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // 暗色为主的设计令牌，全部映射到 index.css 中的 CSS 变量
      colors: {
        base: 'var(--bg-base)',
        panel: 'var(--bg-panel)',
        elevated: 'var(--bg-elevated)',
        sidebar: 'var(--bg-sidebar)',
        /* 毛玻璃导航底色（半透明已烘焙进变量，不支持 /NN 修饰符） */
        glass: 'var(--bg-glass)',
        line: 'var(--border-base)',
        primary: {
          DEFAULT: 'var(--primary)',
          hover: 'var(--primary-hover)',
          soft: 'var(--primary-soft)',
        },
        ink: {
          DEFAULT: 'var(--text-primary)',
          muted: 'var(--text-secondary)',
        },
        /* 交互洗色（hover/active 微底色）：颜色随主题在 CSS 变量层反相，
           注意 var 颜色不支持 /NN 透明度修饰符，透明度已烘焙进变量本身 */
        wash: {
          faint: 'var(--wash-faint)',
          DEFAULT: 'var(--wash)',
          strong: 'var(--wash-strong)',
        },
        /* 黑白身份（mono 主按钮/激活态）：暗色=白底黑字，亮色=黑底白字 */
        mono: {
          DEFAULT: 'var(--mono-bg)',
          hover: 'var(--mono-bg-hover)',
          fg: 'var(--mono-fg)',
        },
        /* 节点状态点：idle 最暗灰 / waiting 半透明 */
        dot: {
          idle: 'var(--dot-idle)',
          dim: 'var(--dot-dim)',
        },
      },
      fontFamily: {
        sans: [
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'PingFang SC',
          'Microsoft YaHei',
          'sans-serif',
        ],
      },
      borderRadius: {
        '2': '2px',
        '8': '8px',
        sm: 'var(--radius-sm)',
        base: 'var(--radius-base)',
        lg: 'var(--radius-lg)',
      },
      keyframes: {
        // 节点 running 状态的边框呼吸灯（墨色系：暗色白呼吸 / 亮色黑呼吸，变量随主题反转）
        'node-breathe': {
          '0%, 100%': { boxShadow: '0 0 0 0 var(--node-breathe)' },
          '50%': { boxShadow: '0 0 0 7px rgba(0, 0, 0, 0)' },
        },
        // Modal：淡入 + 轻微缩放
        'modal-in': {
          from: { opacity: '0', transform: 'scale(0.96) translateY(8px)' },
          to: { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        // 全屏遮罩淡入
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        // Toast：自下而上滑入
        'toast-in': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        // 抽屉/侧栏：自右滑入（backwards：结束后回样式表基础态；
        // KBPanel 前台使用没问题。聚焦面板改用 transition 翻转，不再依赖 animation）
        'slide-in-right': {
          from: { opacity: '0', transform: 'translateX(18px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        // 通用上浮淡入（面板内容/卡片）
        'rise-in': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'node-breathe': 'node-breathe 1.6s ease-in-out infinite',
        'modal-in': 'modal-in 0.22s cubic-bezier(0.16, 1, 0.3, 1) both',
        'fade-in': 'fade-in 0.18s ease-out both',
        'toast-in': 'toast-in 0.24s cubic-bezier(0.16, 1, 0.3, 1) both',
        'slide-in-right': 'slide-in-right 0.24s cubic-bezier(0.16, 1, 0.3, 1) backwards',
        'rise-in': 'rise-in 0.3s ease-out backwards',
      },
    },
  },
  plugins: [],
};
