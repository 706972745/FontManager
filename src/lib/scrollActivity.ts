import { useSyncExternalStore } from "react";

/**
 * 全局「正在滚动」信号。
 *
 * 为什么需要它（2026-10-31 实测）：字体预览用 `FontFace` + `document.fonts.add()` 加载，
 * 一屏一屏往下滚会不断加载新字体。原来的 LRU 上限（条数 / 字节）**并不能把内存还回去** ——
 * 把上限压到 8 个字体、8 MB 再滚 180 格，渲染进程照样从 419 MB 涨到 855 MB：
 * `document.fonts.delete()` 只是把 FontFace 从集合里摘掉，Chromium 仍按 family 名留着
 * 那份字体数据（卡片样式里还引用着 `font-family: zfm-xxx`）。
 *
 * 所以真正有效的办法是**少加载**：滚动过程中先不上真字体（用系统字体占位），
 * 停手 180 ms 后再给当前视口那几张卡片加载。用户看到的效果是「停下才变成本字体」，
 * 快速翻找时内存不再一路涨。
 *
 * 只用一个模块级布尔 + 订阅，不走 zustand：卡片有几十个，订阅者越多越要省。
 */

const IDLE_MS = 180;

let scrolling = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const fn of listeners) fn();
};

/** 滚动容器每次 scroll 都调它：置为「滚动中」，并把「停手」计时器往后推 */
export function notifyScrollActivity(): void {
  if (!scrolling) {
    scrolling = true;
    emit();
  }
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    scrolling = false;
    emit();
  }, IDLE_MS);
}

export function isScrolling(): boolean {
  return scrolling;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 组件里读「现在是否在滚动」；停手后会自动重渲染一次 */
export function useScrollActivity(): boolean {
  return useSyncExternalStore(subscribe, isScrolling, () => false);
}
