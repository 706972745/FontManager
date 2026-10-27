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

export function staggerDelay(index: number): number {
  return Math.min(index, STAGGER_CAP) * STAGGER_STEP;
}
