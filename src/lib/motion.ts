import { useFontStore } from "../state/fontStore";

/** 系统层「减少动态效果」的媒体查询（与 tokens.css 里 @media 那条同源） */
const SYSTEM_REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * 此刻是否应该「不做动效」——窗口级 / DOM 级动画的统一口径（审计 P0-2）。
 *
 * 为什么需要这个函数：`MotionConfig reducedMotion` 只管 motion 组件，
 * 「减少动效」开关管不到**窗口几何**（useQuickbarDock 的收起/展开、细线滑出、
 * 长回提示）和 `morphDuration()`。以前只有 `enterQuickbar` 读了 motionPref，
 * dock 整条流程全是硬编码时长 —— 用户开了开关，窗口照样滑出屏幕再滑回来。
 *
 * 为什么两轨都要看：`MotionPref` 只有 "system" / "reduced" 两档，
 * 「跟随系统」时 store 里存的是 "system"，此时必须问系统 —— 这与组件里
 * `noMotion = useReducedMotion() || motionPref === "reduced"`（FamilyCard.tsx:78-80、
 * DetailPanel.tsx:678-680）保持同一口径，不能只判 store。
 *
 * 可以在非 React 环境（事件回调 / 状态机）里直接调用：每次现读 store，
 * 用户在设置里一改就立刻生效，不需要额外的订阅。
 *
 * 注意：本文件 import 了 fontStore，而 fontStore 也会 import 本文件（morphDuration）。
 * 与 useQuickbarDock.ts ↔ fontStore 是同一个既有形状 —— 只在函数体内取值，
 * 不做模块顶层求值，所以循环引用是安全的。
 */
export function motionReduced(): boolean {
  if (useFontStore.getState().motionPref === "reduced") return true;
  if (typeof window === "undefined") return false;
  return window.matchMedia?.(SYSTEM_REDUCED_QUERY).matches ?? false;
}
