import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronRight, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode, MouseEvent as ReactMouseEvent } from "react";
import { create } from "zustand";
import { recordContextMenuSize } from "../../lib/menuMetrics";
import { useT } from "../../lib/i18n";
import { useFontStore } from "../../state/fontStore";
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
  | { kind: "check"; label: string; checked: boolean; action: () => void }
  /**
   * 二级菜单：hover / 点击 / → 展开。
   *
   * 为什么要有：分组和快照的成员列表会随用户使用无限增长（用户已经建到 5 个快照、
   * 分组名还可能是长串路径），平铺在菜单里会把「停用 / 加入收藏 / 应用 / 导出」这些
   * 常用项一路顶到屏幕外。收进二级菜单后主菜单长度恒定。
   *
   * 子项复用同一套 MenuItem，所以勾选、分隔、嵌套都可以照常组合。
   */
  | {
      kind: "submenu";
      label: string;
      icon?: ReactNode;
      disabled?: boolean;
      items: MenuItem[];
    };

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

type SubmenuItem = Extract<MenuItem, { kind: "submenu" }>;

/**
 * 二级菜单行。
 *
 * 交互（与系统菜单对齐）：
 * - 鼠标移入展开、移出 140ms 后收起 —— 中间有 2px 间隙，立刻收会让子菜单点不到；
 * - 点击父项也可以开合（触屏 / 不依赖 hover）；
 * - 键盘 →/Enter 展开并聚焦第一项，← 收起并回到父项。
 *
 * 子面板走 portal 挂到 body：父面板是 `overflow-y: auto`，
 * 直接嵌在里面会被裁掉，而且父面板的上下键导航会把子项当成同级项。
 */
function SubmenuRow({ item, close }: { item: SubmenuItem; close: () => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);

  const cancelTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const openNow = () => {
    cancelTimer();
    setOpen(true);
  };
  const closeSoon = () => {
    cancelTimer();
    timer.current = window.setTimeout(() => {
      setOpen(false);
      setPos(null);
    }, 140);
  };
  useEffect(() => cancelTimer, []);

  useLayoutEffect(() => {
    if (!open) return;
    const b = btnRef.current;
    const p = panelRef.current;
    if (!b || !p) return;
    const r = b.getBoundingClientRect();
    const naturalW = p.offsetWidth;
    const h = p.offsetHeight;
    const gap = 2;
    const margin = 8;
    const rightSpace = window.innerWidth - r.right - gap - margin;
    const leftSpace = r.left - gap - margin;

    /**
     * 关键取舍：**宁可把子面板压窄，也不要翻到左侧盖住父菜单。**
     *
     * 速览窗口只有 500 宽，主面板 223 + 子面板 246 并排放不下，
     * 早期实现直接翻到左侧 —— 结果是子菜单整块盖在父菜单上，
     * 「分组 / 快照」两行被完全遮住，用户不知道自己在哪一层。
     * 现在改为：右侧能挤出 ≥ MIN_SUBMENU_WIDTH 就压窄放右边；
     * 两边都挤不出（窗口窄到离谱）才选较宽的一侧，靠 clamp 兜底。
     */
    const MIN_SUBMENU_WIDTH = 168;
    let left: number;
    let width: number;
    if (rightSpace >= MIN_SUBMENU_WIDTH || rightSpace >= leftSpace) {
      width = Math.max(MIN_SUBMENU_WIDTH, Math.min(naturalW, rightSpace));
      left = Math.max(margin, Math.min(r.right + gap, window.innerWidth - width - margin));
    } else {
      width = Math.max(MIN_SUBMENU_WIDTH, Math.min(naturalW, leftSpace));
      left = Math.max(margin, r.left - width - gap);
    }

    let top = r.top - 4;
    if (top + h > window.innerHeight - margin) top = window.innerHeight - h - margin;
    // layout effect 里 setState 会在 paint 前同步生效，所以不会看到 -9999 那一帧
    setPos({ left, top: Math.max(margin, top), width });
  }, [open]);

  const focusFirst = () => {
    panelRef.current?.querySelector<HTMLButtonElement>("button.ctx-item:not(:disabled)")?.focus();
  };

  return (
    <>
      <button
        ref={btnRef}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={item.disabled}
        className={`ctx-item ${open ? "ctx-submenu-open" : ""}`}
        onMouseEnter={openNow}
        onMouseLeave={closeSoon}
        onClick={() => (open ? setOpen(false) : openNow())}
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "Enter") return;
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
          requestAnimationFrame(focusFirst);
        }}
      >
        {item.icon && <span className="ctx-icon">{item.icon}</span>}
        <span className="ctx-label">{item.label}</span>
        <span className="ctx-submenu-chevron" aria-hidden>
          <ChevronRight size={13} strokeWidth={2} />
        </span>
      </button>
      {open &&
        createPortal(
          <motion.div
            ref={panelRef}
            className="ctx-menu glass-e3 ctx-submenu-panel"
            role="menu"
            style={{
              left: pos?.left ?? -9999,
              top: pos?.top ?? -9999,
              width: pos?.width,
              // 覆盖 .ctx-menu 的 min-width: 208 —— 窄窗口下子面板必须能被压窄，
              // 否则「并排」这个前提就不成立，又会退回盖住父菜单
              minWidth: 0,
              visibility: pos ? "visible" : "hidden",
            }}
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            transition={springSnappy}
            onMouseEnter={openNow}
            onMouseLeave={closeSoon}
            onKeyDown={(e) => {
              if (e.key === "Tab") {
                e.stopPropagation();
                close();
                return;
              }
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
                btnRef.current?.focus();
                return;
              }
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
              e.preventDefault();
              e.stopPropagation();
              const list = [
                ...(panelRef.current?.querySelectorAll<HTMLButtonElement>(
                  "button.ctx-item:not(:disabled)",
                ) ?? []),
              ];
              if (list.length === 0) return;
              const cur = list.indexOf(document.activeElement as HTMLButtonElement);
              const next =
                e.key === "Home" ? 0
                : e.key === "End" ? list.length - 1
                : e.key === "ArrowDown" ? (cur + 1) % list.length
                : (cur - 1 + list.length) % list.length;
              list[next]?.focus();
            }}
          >
            <MenuItems items={item.items} close={close} />
          </motion.div>,
          document.body,
        )}
    </>
  );
}

/**
 * 一组菜单项。主面板与子面板共用，保证勾选框、分隔线、禁用态样式**完全一致**
 * —— 用户在不同层级看到的同一种东西，长得必须一样。
 */
function MenuItems({ items, close }: { items: MenuItem[]; close: () => void }) {
  return (
    <>
      {items.map((item, i) => {
        if (item.kind === "separator") return <div key={i} className="ctx-sep" />;
        if (item.kind === "heading")
          return (
            <div key={i} className="ctx-heading">
              {item.label}
            </div>
          );
        if (item.kind === "submenu")
          return <SubmenuRow key={i} item={item} close={close} />;
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
    </>
  );
}

function MenuPanel({ x, y, items }: { x: number; y: number; items: MenuItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const close = useMenuStore((s) => s.close);
  const t = useT();
  /**
   * 菜单内「打字即搜」（用户 2026-11-05：右键菜单开着时直接打字就要能搜字体）。
   *
   * - `null` = 还没开始打字：菜单保持原样；敲下第一个可打印字符后进入搜索模式，
   *   顶部出现搜索框（首字符已填入并聚焦），字符不会再触发别处。
   * - 有词时列出全库匹配字族（最多 8 条），原菜单项暂时让位——方向键只在结果里走；
   *   清空输入自动回到原菜单，Esc 先清词、再按一次才关菜单。
   * - 选中 = `select(family)`（完整面板打开详情并滚过去）；速览面板没有「详情」，
   *   额外派发 `zfm-quickbar-search`，QuickBar 收到后把族名填进自己的搜索框。
   */
  const [search, setSearch] = useState<string | null>(null);
  const searchActiveRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const fonts = useFontStore((s) => s.fonts);
  const sessionActivated = useFontStore((s) => s.sessionActivated);
  // 菜单打开那一刻判定环境：速览默认只搜已启用字体（Tab 可切全部），完整界面恒为全部。
  // 用户口径（2026-11-05）：速览选中已启用字体 = 在速览里滚动定位；选中未启用字体 =
  // 退回完整界面字体库并滚动到该族；完整界面 = 搜全部、保持当前浏览方式滚动定位。
  const [inQuickbar] = useState(() => document.querySelector(".qb-frame") !== null);
  const [scope, setScope] = useState<"enabled" | "all">(inQuickbar ? "enabled" : "all");

  const familyNames = useMemo(() => {
    const seen = new Set<string>();
    if (scope === "enabled") {
      // 与速览顶栏「已启用 N」同口径：任一面启用，或会话级临时启用
      for (const f of fonts) {
        if (f.active || sessionActivated.includes(f.family)) seen.add(f.family);
      }
    } else {
      for (const f of fonts) seen.add(f.family);
    }
    return [...seen];
  }, [fonts, scope, sessionActivated]);

  const hits = useMemo(() => {
    if (search === null) return [];
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return familyNames.filter((n) => n.toLowerCase().includes(q)).slice(0, 8);
  }, [search, familyNames]);

  const searching = search !== null && search.trim() !== "";

  const setSearchBoth = (v: string | null) => {
    searchActiveRef.current = v !== null;
    setSearch(v);
  };

  // 从「没在搜」进入搜索时把焦点交给输入框（autofocus 只在挂载时生效，
  // 而输入框是先有普通菜单、打字后才挂载的，两种时序都要覆盖）
  useEffect(() => {
    if (search !== null) searchRef.current?.focus();
  }, [search === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (family: string) => {
    const st = useFontStore.getState();
    const fam = st.fonts.find((f) => f.family === family);
    const enabled = !!fam && (fam.active || st.sessionActivated.includes(family));
    if (!inQuickbar || !enabled) {
      // 完整界面（或速览里选中了未启用字体）：切到字体库视图、选中并滚动到该族。
      // 三个视图（卡片/列表/样张）都监听 selectedFamily 自动 scrollToIndex。
      if (st.nav.kind !== "library") st.setNav({ kind: "library" });
      st.select(family);
      if (inQuickbar) void st.setQuickbar(false);
    } else {
      // 速览里选中已启用字体：不动界面，速览列表内滚动定位（QuickBar 监听）
      window.dispatchEvent(new CustomEvent("zfm-quickbar-search", { detail: { family } }));
    }
    close();
  };

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
    // 搜索框出现/结果增减都会改菜单高度，要重新 clamp，否则底部超出窗口
  }, [x, y, search !== null, hits.length]);

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
    /** 打字即搜：第一个可打印字符开启搜索模式（IME 合成中的键不动，交给输入框） */
    const onType = (e: KeyboardEvent) => {
      if (searchActiveRef.current) return;
      if (e.key.length !== 1) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      e.stopPropagation();
      setSearchBoth(e.key);
    };
    /**
     * 搜索模式下 Tab = 切换搜索范围（已启用 ↔ 全部），**必须挂在捕获层**。
     * 挂在输入框的 React 合成事件里抢不过容器冒泡层的 onTab（原生冒泡先于
     * React 的 root 委托触发，菜单会先被关掉——用户实测「Tab 没法用」就是它）。
     * 用户口径：只要出现了搜索，Tab 就归搜索用，不再关菜单。
     */
    const onTabScope = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      if (!searchActiveRef.current) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setScope((s) => (s === "enabled" ? "all" : "enabled"));
    };
    /**
     * Tab 逃出菜单会跑到背后被遮住的界面上（视觉上「焦点消失了」）。
     * 菜单是模态的，Tab 直接关掉菜单并把焦点还回去最稳（§5 第 23 条）。
     * 搜索模式下不走这里 —— onTabScope 在捕获层已经把 Tab 截走了。
     */
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      e.stopPropagation();
      close();
    };
    el.addEventListener("keydown", onKey);
    el.addEventListener("keydown", onType, true);
    el.addEventListener("keydown", onTabScope, true);
    el.addEventListener("keydown", onTab);
    return () => {
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("keydown", onType, true);
      el.removeEventListener("keydown", onTabScope, true);
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
      {search !== null && (
        <div className="ctx-search-wrap">
          <Search size={13} strokeWidth={2} aria-hidden />
          <input
            ref={searchRef}
            className="ctx-search"
            value={search}
            placeholder={
              scope === "enabled" ? t("menu.typeToSearchEnabled") : t("menu.typeToSearch")
            }
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setSearchBoth(e.target.value)}
            onKeyDown={(e) => {
              // Tab 不在这里处理：容器捕获层的 onTabScope 先于一切冒泡截走它
              //（切搜索范围）；完整界面/速览一致 —— 搜索模式下 Tab 永远不关菜单
              if (e.key === "Enter") {
                e.preventDefault();
                const active =
                  document.activeElement instanceof HTMLButtonElement &&
                  document.activeElement.classList.contains("ctx-hit")
                    ? document.activeElement
                    : null;
                const target =
                  active ??
                  ref.current?.querySelector<HTMLButtonElement>("button.ctx-hit:not(:disabled)");
                target?.click();
                return;
              }
              if (e.key === "Escape") {
                // 窗口级 capture 的 Escape（ContextMenuHost）已经把「清词优先」处理掉了，
                // 走到这里说明搜索框是空的：恢复普通菜单
                e.preventDefault();
                e.stopPropagation();
                setSearchBoth(null);
              }
            }}
          />
        </div>
      )}
      {searching ? (
        hits.length === 0 ? (
          <div className="ctx-nomatch">{t("menu.searchNoMatch")}</div>
        ) : (
          hits.map((name) => (
            <button
              key={name}
              role="menuitem"
              className="ctx-item ctx-hit"
              onClick={() => pick(name)}
            >
              <span className="ctx-label">{name}</span>
            </button>
          ))
        )
      ) : (
        <MenuItems items={items} close={close} />
      )}
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
      // 菜单内搜索框有词时，第一下 Esc 先清词回到原菜单（与速览搜索框同口径），
      // 第二下才关菜单。必须绕过 React 的 value tracker 再派发 input 事件，
      // 受控 input 的 onChange 才会真的收到空串。
      const input = document.querySelector<HTMLInputElement>(".ctx-search");
      if (input && input.value !== "") {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
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
