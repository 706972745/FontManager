import { useEffect, useRef } from "react";

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * 焦点陷阱栈（§5 第 8 条）。
 * 以前每个实例各自监听 window Tab：设置面板和重复字体弹窗同时开着时，
 * 两层都会把焦点往自己身上拽，用户按 Tab 像在原地打转。
 * 只有**最后压栈**（视觉上最上层）的那一层响应 Tab，其余让路。
 */
const trapStack: symbol[] = [];

export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;
    const id = Symbol("focus-trap");
    trapStack.push(id);
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      // 上面还压着别的陷阱：这一层不抢 Tab（否则两层互拽，焦点原地打转）
      if (trapStack[trapStack.length - 1] !== id) return;
      const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => !el.hasAttribute("disabled") && el.offsetParent !== null,
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const cur = document.activeElement;
      if (e.shiftKey && (cur === first || !container.contains(cur))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (cur === last || !container.contains(cur))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      const at = trapStack.lastIndexOf(id);
      if (at >= 0) trapStack.splice(at, 1);
      // 还有更外层弹层开着时，焦点归它管；空了才还给打开这一层的元素
      if (trapStack.length === 0) opener?.focus?.();
    };
  }, [active]);
  return ref;
}
