/**
 * 模板展开过渡的全局挂起态（transient，不落盘）：
 * 模板中心页点击卡片后挂起「模板 + 卡片矩形」，由挂在 <Routes> 之上的
 * TemplateExpandOverlay 接管「展开 → 导航 → 淡出」全流程。过渡层跨路由
 * 存活，路由切换发生在其背后，彻底消除跳转画布时的闪帧。
 */
import { create } from 'zustand';
import type { WorkflowTemplate } from '../templates';

/** 展开源矩形（视口坐标） */
export interface ExpandRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ExpandState {
  template: WorkflowTemplate | null;
  rect: ExpandRect | null;
  start: (template: WorkflowTemplate, rect: ExpandRect) => void;
  clear: () => void;
}

export const useExpandStore = create<ExpandState>((set) => ({
  template: null,
  rect: null,
  start: (template, rect) => set({ template, rect }),
  clear: () => set({ template: null, rect: null }),
}));
