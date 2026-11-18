import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, MoreHorizontal, Plus, Tag as TagIcon, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { openContextMenuAt, useContextMenuOpen, type MenuItem } from "../design/primitives/ContextMenu";
import { BlinkCaretInput } from "../design/primitives/BlinkCaretInput";
import { toast } from "../design/primitives/Toast";
import { DOCK_LEAVE_DELAY, useDockHover } from "../lib/dockHover";
import { useDockOpen } from "../lib/dockOpen";
import { spring, springSnappy, springSoft } from "../design/springs";
import { familiesFor, familyTagCounts, useFontStore } from "../state/fontStore";
import { tagLabel } from "../lib/tagLabels";
import { NAMESPACES, isAutoTagId, namespaceOf, type Namespace } from "../lib/tagVocabulary";
import { useT, type TKey } from "../lib/i18n";

/**
 * 侧栏「标签」分区（2.3.0，与 AssetManager 0.5.0 的 TagDock 同一套交互）。
 *
 * 形态（照抄 AssetManager 的最终版，前两版失败形态别重犯）：
 * - 头部（`🏷 标签`）**永远可见、位置不动**，钉在底栏上方 —— 所以它可以安全地当点击目标：
 *   点一下 = 固定展开 / 取消固定；
 * - 悬停头部或面板 → 就地展开（目录树被压缩，不被盖住），进入即展开、离开即收起（纯 CSS `:hover`，
 *   不用 JS 事件 + 定时器：那样会出现「鼠标走了它还赖着」）；
 * - 展开/收起是 110ms 高度过渡（150ms 实机就觉得慢）；
 * - 收起时头部仍显示「正在筛的标签」胶囊（色点 + × 一键清除），筛选状态不会被藏起来；
 * - 容器用**固定像素高度**，不用百分比、不用 `column-reverse`（都是踩过的坑，见 AssetManager §8.1）。
 *
 * 内容侧与 AssetManager 的唯一区别：**内里按 FontManager 的标签分类走** ——
 * 手工标签 + 分组（用户自己建的），自动标签按 `tagVocabulary` 的命名空间（一级分类 / 中文字体 /
 * 装饰 / 形态 / 技术 / 用途 …）折叠成一节，一行都不改词表。
 */

/** 语义色键（与 AssetManager 同一套 10 个；**不存色值**，深浅主题各自映射） */
export const TAG_COLORS = [
  "gray",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "indigo",
  "violet",
  "pink",
] as const;

export function tagColorClass(color: string | undefined | null): string {
  return color ? `tag-c-${color}` : "tag-c-none";
}

const PIN_KEY = "zfm.tags.pinned";
const CLOSED_KEY = "zfm.tags.groups.closed";

function loadPinned(): boolean {
  try {
    return localStorage.getItem(PIN_KEY) === "1";
  } catch {
    return false;
  }
}
function savePinned(v: boolean) {
  try {
    localStorage.setItem(PIN_KEY, v ? "1" : "0");
  } catch {
    /* 隐私模式：本次会话有效 */
  }
}
function loadClosed(): Set<string> {
  try {
    const raw = localStorage.getItem(CLOSED_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}
function saveClosed(s: Set<string>) {
  try {
    localStorage.setItem(CLOSED_KEY, JSON.stringify([...s]));
  } catch {
    /* 同上 */
  }
}

interface EditTarget {
  kind: "tag" | "group";
  name: string;
  x: number;
  y: number;
}

export function TagDock() {
  const t = useT();
  const fonts = useFontStore((s) => s.fonts);
  const tags = useFontStore((s) => s.tags);
  const tagMeta = useFontStore((s) => s.tagMeta);
  const tagGroups = useFontStore((s) => s.tagGroups);
  const nav = useFontStore((s) => s.nav);
  const setNav = useFontStore((s) => s.setNav);
  const purgeTag = useFontStore((s) => s.purgeTag);
  const removeTagEverywhere = useFontStore((s) => s.removeTagEverywhere);
  // 「+ 标签」要落到具体字体上：标签在数据里是「字族 → 标签」的反向表，
  // 没有任何字体挂着的标签无处可存（见 state.tags 的类型）。所以先取选中态。
  const selection = useFontStore((s) => s.selection);
  const selectedFamily = useFontStore((s) => s.selectedFamily);
  const setBulkTagFor = useFontStore((s) => s.setBulkTagFor);
  // 自动标签总开关 / 否决名单：只订阅，用来在它们变化时触发重渲染（计数是现算的）
  useFontStore((s) => s.autoTagEnabled);
  useFontStore((s) => s.autoTagDenied);

  const [pinned, setPinned] = useState(loadPinned);
  const [closed, setClosed] = useState<Set<string>>(loadClosed);
  const [autoOpen, setAutoOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const addRef = useRef<HTMLDivElement>(null);

  /**
   * 两种「临时钉住」，都只在对应动作期间生效，不动用户的固定开关：
   *
   * - `focusHold`：过滤框一聚焦就钉住。中文输入法的候选词窗是**独立窗口**，
   *   它一出现 WebView 就当成指针离开了面板，`:hover` 断掉 → 面板在打字途中收起来
   *   （用户 2026-11-16 报的就是这个：「正常输入中文的时候会收起」）。
   * - `menuHold`：右键按下就钉住。右键菜单是 portal 到 body 的，指针必然离开面板；
   *   不钉住的话菜单还没点，面板先收起了 —— 表现就是「标签右键菜单没有了」。
   */
  const [focusHold, setFocusHold] = useState(false);
  const [menuHold, setMenuHold] = useState(false);
  const menuOpen = useContextMenuOpen();

  /* 悬停由全局单值驱动，不用 CSS :hover —— 理由见 lib/dockHover.ts：
     两个面板上下相邻，各自 :hover 时，从标签移到分组会让标签先收起、把分组推走，
     指针脱靶，分组永远展不开。 */
  const DOCK_ID = "tags";
  const activeDock = useDockHover((s) => s.active);
  const setActiveDock = useDockHover((s) => s.setActive);
  const leaveTimer = useRef<number | null>(null);

  const dockEnter = () => {
    if (leaveTimer.current !== null) {
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
    setActiveDock(DOCK_ID);
  };

  const dockLeave = () => {
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = null;
      // 只在「还是自己」的时候清：期间指针可能已经进了另一个面板
      if (useDockHover.getState().active === DOCK_ID) setActiveDock(null);
    }, DOCK_LEAVE_DELAY);
  };

  useEffect(
    () => () => {
      if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!menuOpen) setMenuHold(false);
  }, [menuOpen]);

  /** 有标签正在筛（右侧蓝线亮着）时面板保持展开，切到别的导航就自然解除（用户 2026-11-16） */
  const selectedHold = nav.kind === "tag";
  const open =
    pinned || selectedHold || activeDock === DOCK_ID || focusHold || menuHold || edit !== null;

  /**
   * 两个面板同时展开时各让一步（用户 2026-11-16 定：各自限到约 220px）。
   * 单开仍是 300px；对面开着才降档，否则目录树会被压没、底栏被挤出可视区。
   */
  const setDockOpen = useDockOpen((s) => s.setOpen);
  const collectionsOpen = useDockOpen((s) => s.collections);
  useEffect(() => {
    setDockOpen("tags", open);
    return () => setDockOpen("tags", false);
  }, [open, setDockOpen]);

  /**
   * 面板收起时把过滤词清掉。
   *
   * 不清理的话：用户搜「宋」→ 点某条标签（面板转成「选中即固定」）→ 点别处收起 →
   * 再悬停展开，看到的是一片「没有匹配」的空列表，还会以为标签丢了。
   */
  useEffect(() => {
    if (!open) setQ((v) => (v === "" ? v : ""));
  }, [open]);

  useEffect(() => {
    if (!adding) return;
    const timer = window.setTimeout(
      () => addRef.current?.querySelector("input")?.focus(),
      40,
    );
    return () => window.clearTimeout(timer);
  }, [adding]);

  // Esc：先取消固定再收起（输入框里的 Esc 归输入框自己处理）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !open) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (edit) return; // 编辑卡自己会关
      setPinned(false);
      savePinned(false);
      setFocusHold(false);
      setMenuHold(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, edit]);

  const allFamilies = useMemo(() => [...familiesFor(fonts, tags).values()], [fonts, tags]);
  const { counts, autoOnly } = useMemo(() => familyTagCounts(allFamilies), [allFamilies]);

  /** 真正落在 `state.json` 里的标签名（= 手工标签）。自动标签只活在这一帧 */
  const storedNames = useMemo(() => {
    const set = new Set<string>();
    for (const list of Object.values(tags)) for (const name of list) set.add(name);
    return set;
  }, [tags]);

  const manual = useMemo(
    () =>
      [...counts.entries()]
        .filter(([name]) => storedNames.has(name))
        .map(([name, count]) => ({
          name,
          count,
          color: tagMeta[name]?.color,
          group: tagMeta[name]?.group,
        })),
    [counts, storedNames, tagMeta],
  );

  const auto = useMemo(
    () =>
      [...counts.entries()]
        .filter(([name]) => autoOnly.has(name) && !storedNames.has(name))
        .map(([name, count]) => ({ name, count })),
    [counts, autoOnly, storedNames],
  );

  const needle = q.trim().toLowerCase();
  const hit = (s: string) => !needle || s.toLowerCase().includes(needle);
  const shownManual = manual.filter((m) => hit(m.name) || hit(tagLabel(m.name, t)));
  const shownAuto = auto.filter((a) => hit(a.name) || hit(tagLabel(a.name, t)));
  const total = manual.length + auto.length;

  const activeTag = nav.kind === "tag" ? nav.tag : null;
  const activeColor = activeTag ? tagMeta[activeTag]?.color : undefined;

  /** 界面上「已固定」的显示口径：手动固定的，或被选中项撑开的 */
  const showingPinned = pinned || selectedHold;

  const togglePin = () => {
    // 面板是被「选中的标签」撑开时，点头部的意思是收起它 —— 那就先取消这个筛选，
    // 否则点了没反应（pinned 本来就是 false，切了也看不出变化）。
    if (selectedHold && !pinned) {
      setNav({ kind: "library" });
      return;
    }
    const next = !pinned;
    setPinned(next);
    savePinned(next);
  };

  const toggleGroup = (name: string) => {
    const next = new Set(closed);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setClosed(next);
    saveClosed(next);
  };

  const commitGroup = () => {
    const value = draft.trim();
    setAdding(false);
    setDraft("");
    if (value) void useFontStore.getState().newTagGroup(value);
  };

  /**
   * 「+ 标签」：给当前选中的字族打一个新标签（2.3.2，用户 2026-11-18）。
   *
   * 为什么不是「建一个空标签」：`state.tags` 是「字族 → 标签[]」的反向表，
   * 没有字体挂着的标签没有地方存（后端也不存在空标签），所以这个动作必须落在具体字体上。
   * 只选了右侧详情那一个族（`selectedFamily`）时也算 —— 那正是用户此刻在看的字体。
   */
  const startAddTag = () => {
    const targets = selection.length > 0 ? selection : selectedFamily ? [selectedFamily] : [];
    if (targets.length === 0) {
      toast.info(t("toast.tagNeedFonts"), t("toast.tagNeedFontsSub"));
      return;
    }
    setBulkTagFor(targets);
  };

  /**
   * 面板空白处右键。工具栏那个「+」已经按用户要求改回「+ 标签」，
   * 「新建标签分组」这个低频动作挪到这里，免得再从标签栏里点出一个分组。
   */
  const dockMenu = (x: number, y: number) => {
    openContextMenuAt(x, y, [
      {
        label: `${t("tag.newGroup")}…`,
        action: () => {
          setAdding(true);
          setDraft("");
        },
      },
    ]);
  };

  const pickTag = (name: string) => {
    setNav(activeTag === name ? { kind: "library" } : { kind: "tag", tag: name });
  };

  /** 一条标签的右键菜单：只放「 pertains to this tag」的项，不弹整库那套 */
  const tagMenu = (name: string, x: number, y: number) => {
    const isAuto = isAutoTagId(name) && !storedNames.has(name);
    const items: MenuItem[] = [
      {
        label:
          activeTag === name
            ? t("tag.menuUnfilter")
            : t("tag.menuOnly", { tag: tagLabel(name, t) }),
        action: () => pickTag(name),
      },
    ];
    if (!isAuto) {
      items.push({
        label: t("tag.edit"),
        action: () => setEdit({ kind: "tag", name, x, y }),
      });
    }
    items.push({ kind: "separator" });
    items.push({
      label: isAuto ? t("tag.deny") : t("menu.removeTagEverywhere", { tag: name }),
      danger: true,
      action: () => {
        if (isAuto) void removeTagEverywhere(name);
        else void purgeTag(name);
      },
    });
    openContextMenuAt(x, y, items);
  };

  const groupMenu = (name: string, x: number, y: number) => {
    openContextMenuAt(x, y, [
      {
        label: t("tag.groupEdit"),
        action: () => setEdit({ kind: "group", name, x, y }),
      },
      { kind: "separator" },
      {
        label: t("tag.groupDissolve"),
        danger: true,
        action: () => void useFontStore.getState().deleteTagGroup(name),
      },
    ]);
  };

  const row = (
    name: string,
    count: number,
    color: string | undefined,
    extra?: string,
    isAuto = false,
  ) => (
    <motion.div
      key={`${extra ?? ""}${name}`}
      // auto 类必须挂上：`.tag-row.auto .tag-dot` 那条「空心虚线圆点」的规则
      // 从 2.3.0 写进样式表起就一直没生效（行上没有这个类），所以自动标签
      // 一直显示成和手工标签一样的实心灰点（用户 2026-11-16：「这个圆点你也一点没改」）。
      className={`tag-row ${isAuto ? "auto" : ""} ${tagColorClass(color)} ${activeTag === name ? "sel" : ""}`}
      /* 键盘可达：只加无障碍语义与按键，不动 DOM 结构与动画。
         容器是 `role="listbox"`，行只能是 `option`（用 button 会破坏 listbox 语义）。 */
      role="option"
      tabIndex={0}
      aria-selected={activeTag === name}
      onClick={() => pickTag(name)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          pickTag(name);
        } else if (e.key === "F2" && !isAuto) {
          // 键盘打开编辑卡：定位到行右端，和「⋯」按钮点出来的位置一致
          e.preventDefault();
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setEdit({ kind: "tag", name, x: rect.right, y: rect.bottom + 4 });
        }
      }}
      onMouseDown={(e) => {
        // 右键**按下**就钉住（不是等 contextmenu）：面板一收，行从渲染树里消失，
        // contextmenu 事件就永远到不了这一行 —— 菜单会「没有了」。
        if (e.button === 2) setMenuHold(true);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenuHold(true);
        tagMenu(name, e.clientX, e.clientY);
      }}
      whileTap={{ scale: 0.985, transition: springSnappy }}
      transition={spring}
      title={`${tagLabel(name, t)} · ${count}`}
    >
      <span className="tag-dot" aria-hidden />
      <span className="tag-row-name">{tagLabel(name, t)}</span>
      <button
        className="tag-row-more"
        aria-label={t("tag.moreAria", { tag: name })}
        title={t("tag.edit")}
        onClick={(e) => {
          e.stopPropagation();
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setEdit({ kind: "tag", name, x: rect.right, y: rect.bottom + 4 });
        }}
      >
        <MoreHorizontal size={12} strokeWidth={2} />
      </button>
      <span className="tag-row-count tabular">{count}</span>
    </motion.div>
  );

  // 组内：按使用数降序，同数按显示名（「常用的浮前面」这条规则在组内依然成立）
  const sortInGroup = (list: typeof manual) =>
    [...list].sort(
      (a, b) => b.count - a.count || tagLabel(a.name, t).localeCompare(tagLabel(b.name, t)),
    );

  const groups = tagGroups.map((g) => ({
    ...g,
    items: sortInGroup(shownManual.filter((m) => m.group === g.name)),
  }));
  const ungrouped = sortInGroup(shownManual.filter((m) => !m.group || !tagGroups.some((g) => g.name === m.group)));

  // 自动标签按命名空间分节（FontManager 自己的分类，不另起一套）
  const autoSections = useMemo(() => {
    const byNs = new Map<Namespace, { name: string; count: number }[]>();
    const other: { name: string; count: number }[] = [];
    for (const item of shownAuto) {
      const ns = namespaceOf(item.name);
      if (!ns) {
        other.push(item);
        continue;
      }
      const list = byNs.get(ns) ?? [];
      list.push(item);
      byNs.set(ns, list);
    }
    const order = Object.keys(NAMESPACES) as Namespace[];
    type AutoSection = { ns: string; label: string; items: { name: string; count: number }[] };
    const sections: AutoSection[] = order
      .filter((ns) => byNs.has(ns))
      .map((ns) => ({
        ns,
        label: t(NAMESPACES[ns].label as TKey),
        items: [...(byNs.get(ns) ?? [])].sort(
          (a, b) => b.count - a.count || tagLabel(a.name, t).localeCompare(tagLabel(b.name, t)),
        ),
      }));
    if (other.length > 0) {
      sections.push({
        ns: "other",
        label: t("tag.nsOther"),
        items: other.sort((a, b) => b.count - a.count),
      });
    }
    return sections;
  }, [shownAuto, t]);

  return (
    <div
      className={`tag-dock ${open ? "open" : ""} ${pinned ? "pinned" : ""} ${open && collectionsOpen ? "half" : ""}`}
      onMouseEnter={dockEnter}
      onMouseLeave={dockLeave}
    >
      {/* 头部永远在、且位置不动（CSS 用 order 把它钉在底栏上方）：
          所以它可以安全地当点击目标 —— 点一下 = 固定展开 / 收起。 */}
      <div
        className="tag-dock-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={showingPinned ? t("tag.unpinAria") : t("tag.pinAria")}
        title={showingPinned ? t("tag.pinnedHint") : t("tag.pinHint")}
        onClick={togglePin}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            togglePin();
          }
        }}
      >
        <TagIcon size={15} strokeWidth={1.5} className="tag-dock-icon" />
        <span className="tag-dock-title">{t("side.tags")}</span>

        {activeTag ? (
          <span className={`tag-dock-filter ${tagColorClass(activeColor)}`}>
            <span className="tag-dot" aria-hidden />
            <span className="tag-dock-filter-name">{tagLabel(activeTag, t)}</span>
            <span
              className="tag-dock-filter-x"
              role="button"
              tabIndex={0}
              aria-label={t("tag.filterClear")}
              title={t("tag.filterClear")}
              onClick={(e) => {
                e.stopPropagation();
                setNav({ kind: "library" });
              }}
            >
              <X size={9} strokeWidth={2.4} />
            </span>
          </span>
        ) : (
          manual.length > 0 && <span className="tag-dock-count tabular">{manual.length}</span>
        )}

        <span className={`tag-dock-caret ${open ? "" : "closed"}`}>
          <ChevronRight size={10} strokeWidth={2} />
        </span>
      </div>

      <div className="tag-dock-body">
        <div className="tag-dock-tools">
          {total > 8 && (
            <BlinkCaretInput
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("tag.filterPlaceholder")}
              aria-label={t("tag.filterPlaceholder")}
              fieldClassName="tag-dock-search"
              spellCheck={false}
              onFocus={() => setFocusHold(true)}
              // 失焦才解除临时钉住 —— 用户要的「激活后固定、取消激活后正常收起」
              onBlur={() => setFocusHold(false)}
            />
          )}
          <button
            className={`tag-tool-btn ${showingPinned ? "on" : ""}`}
            title={showingPinned ? t("tag.pinnedHint") : t("tag.pinHint")}
            aria-pressed={showingPinned}
            onClick={togglePin}
          >
            <span className="tag-pin-dot" aria-hidden />
            <span>{showingPinned ? t("tag.pinned") : t("tag.pin")}</span>
          </button>
          <button
            className="tag-tool-btn"
            title={t("tag.addAria")}
            aria-label={t("tag.addAria")}
            onClick={startAddTag}
          >
            <Plus size={11} strokeWidth={1.8} />
            <span>{t("side.tags")}</span>
          </button>
        </div>

        {adding && (
          <div className="tag-group-add" ref={addRef}>
            <BlinkCaretInput
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t("tag.newGroupPlaceholder")}
              aria-label={t("tag.newGroup")}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitGroup();
                else if (e.key === "Escape") {
                  e.stopPropagation();
                  setAdding(false);
                  setDraft("");
                }
              }}
              onBlur={commitGroup}
              spellCheck={false}
            />
          </div>
        )}

        <div
          className="tag-dock-scroll scroll-hot"
          role="listbox"
          aria-label={t("side.tags")}
          /* 行与分组头都 stopPropagation，所以这里只会接住空白处的右键 */
          onMouseDown={(e) => {
            if (e.button === 2) setMenuHold(true);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenuHold(true);
            dockMenu(e.clientX, e.clientY);
          }}
        >
          {groups.map((g) => {
            if (needle && !hit(g.name) && g.items.length === 0) return null;
            const isClosed = !needle && closed.has(g.name);
            return (
              <div key={g.name} className="tag-group">
                <div
                  className="tag-group-row"
                  onClick={() => toggleGroup(g.name)}
                  onMouseDown={(e) => {
                    if (e.button === 2) setMenuHold(true);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenuHold(true);
                    groupMenu(g.name, e.clientX, e.clientY);
                  }}
                  title={`${g.name} · ${g.items.length}`}
                >
                  <span className={`tag-caret ${isClosed ? "closed" : ""}`}>
                    <ChevronRight size={9} strokeWidth={2} />
                  </span>
                  <span className={`tag-dot ${tagColorClass(g.color)}`} aria-hidden />
                  <span className="tag-row-name">{g.name}</span>
                  <button
                    className="tag-row-more"
                    aria-label={t("tag.groupEdit")}
                    title={t("tag.groupEdit")}
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setEdit({ kind: "group", name: g.name, x: rect.right, y: rect.bottom + 4 });
                    }}
                  >
                    <MoreHorizontal size={12} strokeWidth={2} />
                  </button>
                  <span className="tag-row-count tabular">
                    {g.items.reduce((n, m) => n + m.count, 0)}
                  </span>
                </div>
                {!isClosed && g.items.map((m) => row(m.name, m.count, m.color))}
                {!isClosed && g.items.length === 0 && (
                  <div className="tag-dock-empty tag-dock-empty-inline">{t("tag.emptyGroup")}</div>
                )}
              </div>
            );
          })}

          {tagGroups.length > 0 && ungrouped.length > 0 && (
            <div className="tag-subheading">{t("tag.ungrouped")}</div>
          )}
          {ungrouped.map((m) => row(m.name, m.count, m.color))}

          {manual.length === 0 && shownAuto.length === 0 && (
            <div className="tag-dock-empty">{t("tag.emptyHint")}</div>
          )}

          {shownAuto.length > 0 && (
            <>
              <div
                className="tag-subheading tag-subheading-toggle"
                onClick={() => setAutoOpen((v) => !v)}
                title={t("tag.autoSectionHint")}
              >
                <span className={`tag-caret ${autoOpen ? "" : "closed"}`}>
                  <ChevronRight size={9} strokeWidth={2} />
                </span>
                {t("tag.autoSection")}
              </div>
              {autoOpen &&
                autoSections.map((sec) => (
                  <div key={sec.ns} className="tag-ns">
                    <div className="tag-ns-row">{sec.label}</div>
                    {sec.items.map((a) => row(a.name, a.count, undefined, "auto:", true))}
                  </div>
                ))}
            </>
          )}

          {needle && shownManual.length === 0 && shownAuto.length === 0 && (
            <div className="tag-dock-empty">{t("tag.noMatch", { q: q.trim() })}</div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {edit && (
          <TagEditCard
            key={`${edit.kind}:${edit.name}`}
            target={edit}
            onClose={() => setEdit(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * 标签 / 分组共用一张编辑卡（用户心里它们是同一件事的两个字段）。
 *
 * 纪律（照 AssetManager §8.3）：**改动即时生效，没有「保存」** —— 每项都能一键改回来，
 * 加一层草稿反而让人怀疑「到底存没存」。只有**改名**走回车 / 失焦提交，避免边打字边写库。
 * 改名撞到已有标签 → 后端合并（不是报错）。
 */
function TagEditCard({ target, onClose }: { target: EditTarget; onClose: () => void }) {
  const t = useT();
  const tagMeta = useFontStore((s) => s.tagMeta);
  const tagGroups = useFontStore((s) => s.tagGroups);
  const setTagColor = useFontStore((s) => s.setTagColor);
  const setTagGroup = useFontStore((s) => s.setTagGroup);
  const setTagGroupColor = useFontStore((s) => s.setTagGroupColor);
  const renameTag = useFontStore((s) => s.renameTag);
  const renameTagGroup = useFontStore((s) => s.renameTagGroup);
  const purgeTag = useFontStore((s) => s.purgeTag);
  const deleteTagGroup = useFontStore((s) => s.deleteTagGroup);

  const isTag = target.kind === "tag";
  /**
   * 卡片的「当前名字」。
   *
   * 为什么不能直接用 `target.name`：改名是**失焦即提交**的，而用户改完名字通常会接着点
   * 颜色点 / 分组 —— 点下去时 blur 已经把名字改掉了，如果后续操作还按旧名字写，
   * 就会给一个已经不存在的标签写颜色（加载时被当成孤儿清掉，用户看到的是「颜色点了没用」）。
   */
  const [current, setCurrent] = useState(target.name);
  const meta = isTag ? tagMeta[current] : undefined;
  const group = isTag ? undefined : tagGroups.find((g) => g.name === current);
  const color = isTag ? meta?.color : group?.color;

  const [name, setName] = useState(target.name);
  const [newGroup, setNewGroup] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCurrent(target.name);
    setName(target.name);
    setNewGroup(null);
  }, [target.name, target.kind]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const commitName = () => {
    const next = name.trim();
    if (!next || next === current) {
      setName(current);
      return;
    }
    setCurrent(next);
    if (isTag) void renameTag(current, next);
    else void renameTagGroup(current, next);
  };

  // 位置靠点击点算，贴边时往回收（卡片宽 236）
  const left = Math.max(8, Math.min(target.x - 236, window.innerWidth - 244));
  const top = Math.max(8, Math.min(target.y, window.innerHeight - 300));

  return (
    <motion.div
      ref={boxRef}
      className="tag-edit card-e3"
      style={{ left, top }}
      initial={{ opacity: 0, y: -4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.98 }}
      transition={springSoft}
      role="dialog"
      aria-label={isTag ? t("tag.edit") : t("tag.groupEdit")}
    >
      <div className="tag-edit-head">
        {isTag ? <TagIcon size={12} strokeWidth={1.6} /> : <ChevronRight size={12} strokeWidth={1.8} />}
        <span>{isTag ? t("tag.edit") : t("tag.groupEdit")}</span>
      </div>

      <label className="tag-edit-label" htmlFor="tag-edit-name">
        {t("tag.name")}
      </label>
      <BlinkCaretInput
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={isTag ? t("tag.namePlaceholder") : t("tag.groupNamePlaceholder")}
        aria-label={t("tag.name")}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitName();
        }}
        onBlur={commitName}
        spellCheck={false}
      />

      <div className="tag-edit-label">{t("tag.color")}</div>
      <div className="tag-color-row">
        {TAG_COLORS.map((c) => (
          <button
            key={c}
            className={`tag-color-dot tag-c-${c} ${color === c ? "on" : ""}`}
            aria-label={c}
            title={c}
            onClick={() => {
              const next = color === c ? null : c;
              if (isTag) void setTagColor(current, next);
              else void setTagGroupColor(current, next);
            }}
          />
        ))}
      </div>

      {isTag && (
        <>
          <div className="tag-edit-label">{t("tag.group")}</div>
          <div className="tag-group-pick">
            <button
              className={`tag-group-chip ${!meta?.group ? "on" : ""}`}
              onClick={() => void setTagGroup(current, null)}
            >
              {t("tag.ungrouped")}
            </button>
            {tagGroups.map((g) => (
              <button
                key={g.name}
                className={`tag-group-chip ${meta?.group === g.name ? "on" : ""}`}
                onClick={() => void setTagGroup(current, g.name)}
              >
                <span className={`tag-dot ${tagColorClass(g.color)}`} aria-hidden />
                {g.name}
              </button>
            ))}
            {newGroup === null ? (
              <button className="tag-group-chip" onClick={() => setNewGroup("")}>
                <Plus size={10} strokeWidth={1.8} /> {t("tag.newGroup")}
              </button>
            ) : (
              <BlinkCaretInput
                value={newGroup}
                onChange={(e) => setNewGroup(e.target.value)}
                placeholder={t("tag.newGroupPlaceholder")}
                aria-label={t("tag.newGroup")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newGroup.trim()) {
                    void setTagGroup(current, newGroup.trim());
                    setNewGroup(null);
                  } else if (e.key === "Escape") {
                    e.stopPropagation();
                    setNewGroup(null);
                  }
                }}
                onBlur={() => setNewGroup(null)}
                spellCheck={false}
              />
            )}
          </div>
        </>
      )}

      <div className="tag-edit-foot">
        <button
          className="tag-edit-danger"
          onClick={() => {
            if (isTag) void purgeTag(current);
            else void deleteTagGroup(current);
            onClose();
          }}
        >
          {isTag ? t("tag.delete") : t("tag.groupDissolve")}
        </button>
        <button className="tag-edit-done" onClick={onClose}>
          {t("tag.done")}
        </button>
      </div>
    </motion.div>
  );
}
