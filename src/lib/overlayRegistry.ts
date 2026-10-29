/**
 * 「顶层弹层」登记表（0.9.8 · BUG-B）。
 *
 * 背景：`App.tsx` 的 `topLayerOpen()` 原本只认 store 里的浮层（对比 / 设置 / 帮助 /
 * 命令面板 / 导览 / 各种 prompt / 在线详情）和右键菜单。排序、筛选这两个下拉菜单
 * 是组件内部的 `useState`，外面完全看不见 —— 于是菜单开着时 `F` 会改收藏、
 * `Space` 会启停字体、`Delete` 会把**背后看不见的字族**丢进回收站。
 *
 * 这里放一个极小的登记表：谁开着就往里登记一个 id，关掉就注销，
 * `topLayerOpen()` 读 `overlayOpen()`。故意不依赖 React / zustand，
 * 这样纯逻辑可以直接用 `node --test` 跑（见 tests/overlayRegistry.test.ts）。
 *
 * 计数而非布尔：同一个 id 被重复登记（React 严格模式下 effect 双跑、
 * 或者两层同名菜单）时不会因为先注销的那个把还开着的一起放行。
 */
const layers = new Map<string, number>();

/** 登记一个打开的弹层。必须与 `releaseOverlay` 成对调用。 */
export function acquireOverlay(id: string): void {
  layers.set(id, (layers.get(id) ?? 0) + 1);
}

/** 注销一个弹层。计数归零才真正移除。 */
export function releaseOverlay(id: string): void {
  const n = (layers.get(id) ?? 0) - 1;
  if (n > 0) layers.set(id, n);
  else layers.delete(id);
}

/** 当前是否有弹层占着键盘。 */
export function overlayOpen(): boolean {
  return layers.size > 0;
}

/** 当前打开的弹层 id（调试 / 排查「快捷键为什么没反应」时用）。 */
export function openOverlays(): string[] {
  return [...layers.keys()].sort();
}
