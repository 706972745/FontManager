import { create } from "zustand";

/**
 * 两个停靠面板「现在谁开着」—— 只为了让它们**同时展开时各让一步**。
 *
 * 为什么需要这个：
 * 侧栏底部的可用高度是固定的（标题栏 + 目录树 + 两个面板 + 底栏四行）。两个面板各自
 * `min(300px, 42vh)` 时，同时展开就是 600px，先把中间的目录树压到几乎为零，再把底栏
 * 推出可视区 —— 而 `.app-frame` 是 `overflow: hidden`，用户看到的就是「底栏不见了」。
 *
 * 这里不上报就没人知道对面开着：`pinned` / `selectedHold` / `focusHold` 全是组件内部状态。
 * 两边都上报之后，各自加一个 `.half` 类，高度降到 `min(220px, 30vh)`：
 * 单开仍是 300px（够看十几行），双开各 220px（目录树还能留两百多像素）。
 *
 * 与 `dockHover` 分开是有意的：那个管「指针在哪」，这个管「面板开着没」，
 * 悬停互斥与高度让步是两件事，混在一个 store 里早晚互相踩。
 */
export const useDockOpen = create<{
  tags: boolean;
  collections: boolean;
  setOpen: (id: "tags" | "collections", value: boolean) => void;
}>((set) => ({
  tags: false,
  collections: false,
  setOpen: (id, value) => set({ [id]: value } as never),
}));
