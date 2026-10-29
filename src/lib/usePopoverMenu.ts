import { useCallback, useEffect, useRef, useState } from "react";
import { acquireOverlay, releaseOverlay } from "./overlayRegistry";

/**
 * 下拉菜单（排序 / 筛选）的公共行为（0.9.8 · BUG-B）。
 *
 * 原来这两个菜单各自用组件内 `useState` 管开关，外面看不见，于是：
 * - 菜单开着时全局快捷键照常生效（`F` 改收藏、`Space` 启停字体、`Delete` 删字族）；
 * - 键盘用户打开菜单后按方向键，动的是背后字族列表的选择；
 * - `Escape` 走不到菜单上，先把背后的选择清掉。
 *
 * 这个 hook 把三件事收在一处：
 * 1. **登记**：打开期间登记到 overlayRegistry，`topLayerOpen()` 据此让全局快捷键整体让路；
 * 2. **移焦**：打开后把焦点送进菜单（当前选中项优先），方向键才会在菜单内走；
 * 3. **收回**：Escape / 点遮罩都只关菜单，并把焦点还给触发器。
 */
export function usePopoverMenu(id: string) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const wasOpen = useRef(false);

  /**
   * 登记 / 注销放在 effect 里而不是 setter 里：React 的 updater 可能被调用两次，
   * 在 updater 里改登记表会让计数漂移。effect 的 cleanup 天然成对，
   * 组件卸载时也不会留下「永远开着的弹层」把快捷键全锁死。
   */
  useEffect(() => {
    if (!open) return;
    acquireOverlay(id);
    return () => releaseOverlay(id);
  }, [id, open]);

  /** 关掉菜单；默认把焦点还给触发器，键盘用户不会掉回 body。 */
  const close = useCallback(() => {
    setOpen(false);
    const trigger = triggerRef.current;
    if (trigger && document.contains(trigger)) trigger.focus({ preventScroll: true });
  }, []);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  // 打开后把焦点送进菜单：当前选中项优先，否则第一项
  useEffect(() => {
    if (open && !wasOpen.current) {
      const list = listRef.current;
      const target =
        list?.querySelector<HTMLElement>("[role='option'][aria-selected='true']") ??
        list?.querySelector<HTMLElement>("[role='option']");
      target?.focus({ preventScroll: true });
    }
    wasOpen.current = open;
  }, [open]);

  // Escape 只关菜单。用 capture 阶段拿住，避免继续冒到 App 的全局 handler
  // （那边会用 Escape 清空选择，看起来就像「菜单和选择一起没了」）。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  return { open, toggle, close, triggerRef, listRef };
}
