import type { Transition } from "motion/react";

export const spring: Transition = { type: "spring", stiffness: 300, damping: 30, mass: 1 };
export const springSnappy: Transition = { type: "spring", stiffness: 500, damping: 35 };
export const springSoft: Transition = { type: "spring", stiffness: 180, damping: 24 };

export const springBouncy: Transition = { type: "spring", stiffness: 560, damping: 24 };

/**
 * 0.2 秒简约缓动：用于「即时开合」类过渡（如速览顶部栏自动收起），
 * 不走弹簧，位移/高度收得干净，不出现过冲。
 */
export const easeTop: Transition = { duration: 0.2, ease: [0.32, 0.72, 0, 1] };

export const STAGGER_CAP = 14;
export const STAGGER_STEP = 0.04;

/**
 * 遮罩（scrim / backdrop）的淡入淡出：全站统一 0.18s（审计 P1-5）。
 *
 * 之前有 0.15 / 0.18 / 0.2 三种，右键菜单那处干脆一点动画都没有 ——
 * 同一个「点开一个浮层」的动作，遮罩快慢不一样。
 * 0.18s 与 CSS 侧的 `--t-quick`（180ms）同档，弹层平均观感也最舒服。
 *
 * 做成令牌而不是各写各的数字：以后要调只改这一处（grep `scrimFade`）。
 */
export const scrimFade: Transition = { duration: 0.18 };

export function staggerDelay(index: number): number {
  return Math.min(index, STAGGER_CAP) * STAGGER_STEP;
}
