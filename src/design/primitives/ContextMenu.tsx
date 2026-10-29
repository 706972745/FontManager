import { AnimatePresence, motion } from "motion/react";
import { Check } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, MouseEvent as ReactMouseEvent } from "react";
import { create } from "zustand";
import { recordContextMenuSize } from "../../lib/menuMetrics";
import { springSnappy } from "../springs";

export type MenuItem =
  | {
      kind?: "item";
      label: string;
      icon?: ReactNode;
      danger?: boolean;
      disabled?: boolean;
      action: () => void;
    }
  | { kind: "separator" }
  | { kind: "heading"; label: string }
  | { kind: "check"; label: string; checked: boolean; action: () => void };

interface MenuState {
  open: boolean;
  x: number;
  y: number;
  items: MenuItem[];
  /** 打开菜单前的焦点元素：关掉时要还回去（§5 第 23 条） */
  prevFocus: HTMLElement | null;
  show: (x: number, y: number, items: MenuItem[]) => void;
  close: () => void;
}

const useMenuStore = create<MenuState>((set, get) => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  prevFocus: null,
  show: (x, y, items) =>
    set({
      open: true,
      x,
      y,
      items,
      prevFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    }),
  close: () => {
    const prev = get().prevFocus;
    set({ open: false, prevFocus: null });
    // 键盘用户关掉菜单后，焦点不能掉回 body（否则 Tab 要从头开始走）
    if (prev && prev !== document.body && document.contains(prev)) {
      prev.focus({ preventScroll: true });
    }
  },
}));

/** 右键菜单是否开着：全局快捷键 / 顶层弹层判定要用（见 App.tsx 的 topLayerOpen） */
export function isContextMenuOpen(): boolean {
  return useMenuStore.getState().open;
}

export function openContextMenu(e: ReactMouseEvent, items: MenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  // 右键不会改变焦点：先把触发它的元素聚焦，菜单关掉时焦点才有地方可回
  const host = e.currentTarget as HTMLElement | null;
  if (host && host !== document.body && (host.tabIndex >= 0 || host.isContentEditable)) {
    host.focus({ preventScroll: true });
  }
  useMenuStore.getState().show(e.clientX, e.clientY, items);
}

export function openContextMenuAt(x: number, y: number, items: MenuItem[]) {
  useMenuStore.getState().show(x, y, items);
}

export function closeContextMenu() {
  useMenuStore.getState().close();
}

function MenuPanel({ x, y, items }: { x: number; y: number; items: MenuItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const close = useMenuStore((s) => s.close);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 用 offsetWidth/offsetHeight（不含 transform）量测：入场缩放动画会让
    // getBoundingClientRect 偏小，导致 clamp 后菜单底部仍超出窗口被裁掉
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
    });
    // 回填实测尺寸：速览界面用它保证窗口最小尺寸放得下菜单
    recordContextMenuSize(w, h);
  }, [x, y]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const enabled = () =>
      [...el.querySelectorAll<HTMLButtonElement>("button.ctx-item:not(:disabled)")];
    enabled()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const items = enabled();
      if (items.length === 0) return;
      const cur = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        e.key === "Home" ? 0
        : e.key === "End" ? items.length - 1
        : e.key === "ArrowDown" ? (cur + 1) % items.length
        : (cur - 1 + items.length) % items.length;
      items[next].focus();
    };
    /**
     * Tab 逃出菜单会跑到背后被遮住的界面上（视觉上「焦点消失了」）。
     * 菜单是模态的，Tab 直接关掉菜单并把焦点还回去最稳（§5 第 23 条）。
     */
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      e.stopPropagation();
      close();
    };
    el.addEventListener("keydown", onKey);
    el.addEventListener("keydown", onTab);
    return () => {
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("keydown", onTab);
    };
  }, [items, close]);

  return (
    <motion.div
      ref={ref}
      className="ctx-menu glass-e3"
      style={{ left: pos.x, top: pos.y }}
      initial={{ opacity: 0, scale: 0.96, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12 } }}
      transition={springSnappy}
      role="menu"
    >
      {items.map((item, i) => {
        if (item.kind === "separator") return <div key={i} className="ctx-sep" />;
        if (item.kind === "heading")
          return (
            <div key={i} className="ctx-heading">
              {item.label}
            </div>
          );
        if (item.kind === "check")
          return (
            <button
              key={i}
              role="menuitemcheckbox"
              aria-checked={item.checked}
              className="ctx-item"
              onClick={() => {
                item.action();
                close();
              }}
            >
              <span className={`ctx-checkbox ${item.checked ? "ctx-checked" : ""}`}>
                {item.checked && (
                  <motion.span
                    style={{ display: "grid", placeItems: "center" }}
                    initial={{ scale: 0.4, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={springSnappy}
                  >
                    <Check size={11} strokeWidth={2.5} />
                  </motion.span>
                )}
              </span>
              <span className="ctx-label">{item.label}</span>
            </button>
          );
        return (
          <button
            key={i}
            role="menuitem"
            className={`ctx-item ${item.danger ? "ctx-danger" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              item.action();
              close();
            }}
          >
            {item.icon && <span className="ctx-icon">{item.icon}</span>}
            <span className="ctx-label">{item.label}</span>
          </button>
        );
      })}
    </motion.div>
  );
}

export function ContextMenuHost() {
  const { open, x, y, items } = useMenuStore();
  const close = useMenuStore((s) => s.close);

  useEffect(() => {
    if (!open) return;
    // capture 阶段 + stopImmediatePropagation：菜单是当前最上层，
    // Escape 只能它来消费。用冒泡阶段的 stopPropagation 压不住同一 target 上的
    // 其他监听（App 的全局快捷键就会顺手把选择也清了 —— §5 第 22 条）。
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    };
    const onScroll = () => close();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wheel", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, close]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <div
            className="ctx-backdrop"
            onClick={close}
            onContextMenu={(e) => {
              e.preventDefault();
              close();
            }}
          />
          <MenuPanel x={x} y={y} items={items} />
        </>
      )}
    </AnimatePresence>
  );
}
