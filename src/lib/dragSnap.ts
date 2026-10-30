/**
 * 速览拖动时的「顶边吸附」纯逻辑（从 useWindowDrag 拆出来，方便 node --test 直接测）。
 * 这里不 import 任何 tauri / DOM 接口，保持可在 node 里跑。
 */

/** 可以越过屏幕上边界的余量（物理像素）：留一点点让窗口能贴到顶，又不会整条飞到屏幕外 */
export const OVER_TOP = 4;

/**
 * 顶边吸附距离（**逻辑像素**）：距屏幕顶边这么近就直接吸到 y=0，
 * 不用精确拖到边（0.9.9 用户需求：拖到「还差一点点」的位置就自动贴顶，
 * 实测当时窗口距顶 7 物理像素）。
 *
 * 用逻辑像素而不是写死物理像素，是为了不同分辨率 / 缩放下手感一致：
 * 调用方传入窗口当前所在显示器的 devicePixelRatio，阈值随之换算，
 * 多显示器各自 DPI 不同也各自成立。
 */
export const SNAP_TOP_LOGICAL = 8;

/**
 * 给定一次拖动算出的目标顶边坐标（物理像素），返回吸附后的坐标。
 * - rawY <= 吸附阈值（含越过顶边的负值）→ 0，贴住屏幕顶；
 * - 否则原样返回，并保留越顶余量 -OVER_TOP。
 */
export function snapDragTop(rawY: number, dpr: number): number {
  const ratio = dpr > 0 ? dpr : 1;
  const snapTop = SNAP_TOP_LOGICAL * ratio;
  return rawY <= snapTop ? 0 : Math.max(-OVER_TOP, rawY);
}
