/**
 * 画布连线（共享模块）：CanvasPage 与模板投影（TemplatePreview）共用，
 * 保证投影与真实画布的连线渲染完全一致。
 * - defaultEdgeOptions：默认贝塞尔（墨色浅灰细线，颜色随主题取 --edge-line）
 * - FlowEdge：给 path 挂 pathLength="1" 归一化路径长度，"画线生长"动画与边长无关；
 *   分支未触发（data.branchSkipped）时线体改为黄黑警戒斜纹并挂标签
 */
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import type { EdgeTypes } from '@xyflow/react';

/** 默认连线：贝塞尔曲线（墨色浅灰细线，颜色随主题取 --edge-line） */
export const defaultEdgeOptions = {
  type: 'flow',
  style: { stroke: 'var(--edge-line)', strokeWidth: 1.5 },
} as const;

/**
 * 自定义贝塞尔连线：给 path 挂 pathLength="1" 归一化路径长度。
 * 退出聚焦的"画线生长"动画（stroke-dashoffset 1→0）因此与实际边长无关，
 * 任何长度的连线都严格从源节点画到目标节点；运行中流动虚线也用归一化单位。
 * 分支未触发（data.branchSkipped）：线体改为黄黑警戒斜纹，中点挂"该分支未触发"标签。
 */
export function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
}: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const branchSkipped = Boolean((data as { branchSkipped?: boolean } | undefined)?.branchSkipped);
  return (
    <>
      {/* 警戒斜纹填充图案：45° 琥珀/深底条纹（仅分支未触发的边引用） */}
      {branchSkipped && (
        <defs>
          <pattern id={`hazard-${id}`} width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="8" height="8" fill="rgba(120,113,108,0.25)" />
            <rect width="4" height="8" fill="#f59e0b" opacity="0.85" />
          </pattern>
        </defs>
      )}
      <BaseEdge path={path} markerEnd={markerEnd} style={style} pathLength={1} />
      {branchSkipped && (
        <>
          <BaseEdge
            path={path}
            style={{ stroke: `url(#hazard-${id})`, strokeWidth: 3 }}
            pathLength={1}
          />
          <EdgeLabelRenderer>
            <div
              className="nodrag nopan absolute flex items-center gap-1 rounded border border-amber-500/60 bg-base px-1.5 py-0.5 text-[10px] font-medium text-amber-500 shadow-md"
              style={{
                transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
                pointerEvents: 'none',
              }}
            >
              该分支未触发
            </div>
          </EdgeLabelRenderer>
        </>
      )}
    </>
  );
}

export const edgeTypes: EdgeTypes = { flow: FlowEdge };
