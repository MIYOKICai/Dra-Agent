/**
 * 画布缩略图：点阵底 + 两个节点块。
 * 项目菜单与左侧画布列表共用，保证两处缩略图完全一致。
 */
export function CanvasThumb({ className = 'h-10 w-10' }: { className?: string }) {
  return (
    <span
      className={`relative shrink-0 overflow-hidden rounded-lg border border-line bg-base ${className}`}
      aria-hidden="true"
    >
      <span
        className="absolute inset-0"
        style={{
          backgroundImage: 'radial-gradient(var(--border-base) 1px, transparent 1px)',
          backgroundSize: '8px 8px',
        }}
      />
      <span className="absolute left-[22%] top-[26%] h-[20%] w-[40%] rounded-[3px] bg-wash-strong" />
      <span className="absolute bottom-[26%] right-[22%] h-[20%] w-[40%] rounded-[3px] bg-wash-strong" />
    </span>
  );
}
