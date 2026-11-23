import { motion } from "motion/react";
import { Camera, ChevronDown, ChevronRight, Clock, FileUp, FolderOpen, Globe, History, Info, Keyboard, Library, Monitor, Plus, Power, PowerOff, Star, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { openContextMenu, useContextMenuOpen, type MenuItem } from "../design/primitives/ContextMenu";
import { spring, springSnappy, springSoft, staggerDelay } from "../design/springs";
import { INTRO_OFF, useIntro } from "../lib/useIntro";
import { familiesFor, isSystemFamily, useFontStore, type Nav } from "../state/fontStore";
import { faceKey } from "../lib/snapshotKey";
import { sortContainers } from "../lib/faceContainers";
import { countKnown, navCountText } from "../lib/seedOverrides";
import { snapshotToggleAction } from "../lib/menus";
import { BlinkCaretInput } from "../design/primitives/BlinkCaretInput";
import { DOCK_LEAVE_DELAY, useDockHover } from "../lib/dockHover";
import { useDockOpen } from "../lib/dockOpen";
import { t as translate, useT } from "../lib/i18n";
import { TagDock } from "./TagDock";

function navKey(n: Nav): string {
  if (n.kind === "tag") return `tag:${n.tag}`;
  if (n.kind === "collection") return `col:${n.name}`;
  if (n.kind === "snapshot") return `snap:${n.name}`;
  if (n.kind === "favorites") return "favorites";
  return n.kind;
}

function NavRow({
  nav,
  icon,
  label,
  trailing,
  count,
  index,
  no,
  hint,
  onContextMenu,
}: {
  nav: Nav;
  icon: React.ReactNode;
  label: string;
  /** 计数前的附加小字（标签的到期日期红字） */
  trailing?: React.ReactNode;
  /**
   * 行尾计数。`null` = **还不知道**（读字体期间，渲染 `…`）。
   *
   * 为什么是三态而不是 `countsUnknown` 布尔开关：`0` 会被读成「没有字体」，
   * 而读字体的过程中给出的任何数字都是错的（PRD US-4）。类型上把「未知」挤进
   * `number` 里是做不到的，只能多一档。
   */
  count?: number | null;
  index: number;
  /**
   * 分组 / 快照的序号（从 1 开始）。
   * 字重行胶囊只写「快照4 / 分组2」，用户靠这个号把两边对上，
   * 所以两处必须用同一套排序（`lib/faceContainers.ts::sortContainers`）。
   */
  no?: number;
  /** i18n key：悬停 1 秒解释这一行的数字是「字族数」还是别的口径 */
  hint?: string;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const intro = useIntro();
  const current = useFontStore((s) => s.nav);
  const setNav = useFontStore((s) => s.setNav);
  /**
   * 样张视图下侧栏收成「只有图标」的一条（用户 2026-11-05）。
   * 文字用 CSS 藏掉之后，可读名称和悬停说明都得补回来 —— 否则这一列就剩几个
   * 无法辨认的图标，键盘用户还会失去行名。
   */
  const compact = useFontStore((s) => s.viewMode === "specimen");
  const active = navKey(current) === navKey(nav);
  // `null` → `…`；`undefined` → 这一行根本不显示计数（如「关于」）
  const countText = navCountText(count);
  return (
    <motion.button
      className={`nav-row ${active ? "nav-active" : ""}`}
      // 给全局 Delete 用：焦点停在这一行时才知道要删哪个分组/快照。
      // NavRow 是原生 button，点击和 Tab 都会让它成为 activeElement，
      // 所以 App.tsx 用 closest("[data-nav-kind]") 就能定位，不需要额外的焦点状态。
      data-nav-kind={nav.kind}
      data-nav-name={
        nav.kind === "collection" || nav.kind === "snapshot" ? nav.name : undefined
      }
      data-hint={hint}
      data-hint-text={compact ? label : undefined}
      aria-label={compact ? label : undefined}
      onClick={() => setNav(nav)}
      onContextMenu={onContextMenu}
      initial={intro ? { opacity: 0, x: -12 } : false}
      animate={{ opacity: 1, x: 0 }}
      transition={intro ? { ...springSoft, delay: staggerDelay(index) } : INTRO_OFF}
      whileTap={{ opacity: 0.96, transition: springSnappy }}
    >
      {active && (
        /*
         * 侧栏选中块。这里**保留** layoutId 共享元素（行是全宽块、纵向堆叠，行高与
         * 间距在三个分区之间并不统一，纵向位移没法像顶栏的视图切换那样用序号算出来），
         * 但加上 `layout="position"`：只投影位置、不投影尺寸。
         *
         * 原因：侧栏宽度本身参与动画（切样张视图时 260 → 图标条），每帧都在重排，
         * 尺寸投影正是「指示器短暂跑到行外面」的来源；而这块的 x 恒为 0（行左对齐）、
         * 尺寸由 `inset: 0` 自己跟着行走，只有换行时的 y 需要动画。
         * `layout="position"` 正好把没用的尺寸投影掐掉，行间滑动照旧。
         */
        <motion.span
          className="nav-pill"
          layoutId="nav-pill"
          layout="position"
          transition={spring}
        />
      )}
      <span className="nav-icon">{icon}</span>
      {no !== undefined && <span className="nav-no tabular">{no}</span>}
      <span className="nav-label">{label}</span>
      {trailing}
      {countText !== null && (
        <span className={`nav-count tabular${count === null ? " nav-count-unknown" : ""}`}>
          {countText}
        </span>
      )}
    </motion.button>
  );
}

function NewCollectionInput({ onDone }: { onDone: () => void }) {
  const t = useT();
  const intro = useIntro();
  const createCollection = useFontStore((s) => s.createCollection);
  const [name, setName] = useState("");
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => ref.current?.focus(), []);

  const commit = () => {
    if (name.trim()) void createCollection(name);
    onDone();
  };

  return (
    <motion.div
      className="collection-input"
      initial={intro ? { opacity: 0, y: -6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={intro ? spring : INTRO_OFF}
    >
      <FolderOpen size={15} strokeWidth={1.5} />
      <BlinkCaretInput
        ref={ref}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") onDone();
        }}
        onBlur={commit}
        placeholder={t("side.collectionPlaceholder")}
        aria-label={t("side.newCollectionAria")}
        spellCheck={false}
      />
    </motion.div>
  );
}

function NewSnapshotInput({ onDone }: { onDone: () => void }) {
  const t = useT();
  const createSnapshot = useFontStore((s) => s.createSnapshot);
  const [name, setName] = useState("");
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => ref.current?.focus(), []);

  const commit = () => {
    if (name.trim()) void createSnapshot(name);
    onDone();
  };

  return (
    <motion.div
      className="collection-input"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
    >
      <Camera size={15} strokeWidth={1.5} />
      <BlinkCaretInput
        ref={ref}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") onDone();
        }}
        onBlur={commit}
        placeholder={t("side.snapshotPlaceholder")}
        aria-label={t("side.newSnapshotAria")}
        spellCheck={false}
      />
    </motion.div>
  );
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div className="collection-input">
      <FolderOpen size={15} strokeWidth={1.5} />
      <BlinkCaretInput
        ref={ref}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(name);
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => onCommit(name)}
        aria-label={t("side.renameAria")}
        spellCheck={false}
      />
    </div>
  );
}

export function Sidebar() {
  const t = useT();
  const intro = useIntro();
  const fonts = useFontStore((s) => s.fonts);
  // 分组停靠面板自己画行（不再走 NavRow），这两个要在这一层取
  const nav = useFontStore((s) => s.nav);
  const setNav = useFontStore((s) => s.setNav);
  /**
   * 侧栏数字的可信度**分两档**，不再是一个开关管全部（用户 2026-11-13 指出第一版太粗）。
   *
   * - `seed`（种子落地即可信）：已启用 / 启用至关闭 / 系统字体 / 每个分组。
   *   这几类字体**必然全在种子里** —— 种子就是「系统字体 + 台账与注册表里的启用项 +
   *   分组成员 + 快照成员」拼出来的，所以种子一到它们的数量就确定了。空的就该显示 0，
   *   打 `…` 等于把一个已知事实藏起来。
   * - `whole`（必须等全量）：字体库总数、已停用（= 全库 − 已启用）、标签覆盖的族数。
   *   这三者的分母是整个字库，全量没读完就永远算不准。
   *
   * 为什么都不判 `phase === "scanning"`：`phase` 在**每次**重扫时都会回到 scanning
   * （导入字体、watcher 发现变化、换字体库目录都会触发 rescan），而 2.1.3 那时计数
   * 用的是旧 `fonts`、显示真实数字。跟着 phase 变的话，用户每导入一个字体就会看到
   * 整列数字变成 `…`，第一反应是「数据丢了」。用户要的「读取中用 …」只针对打开软件
   * 后的首次读取。
   *
   * 收藏 / 最近导入 / 快照条目 / 回收站不在此列 —— 它们来自 state.json，不依赖扫描，
   * 由 `init()` 里的 `hydrateMeta()` 在种子到达前就拉回来。
   */
  const fullScanDone = useFontStore((s) => s.fullScanDone);
  const seedLanded = useFontStore((s) => s.seedLanded);
  const countFlags = { fullScanDone, seedLanded };
  /** 种子已覆盖全集的那一类（空的显示 0，不是 `…`） */
  const seedCountsKnown = countKnown("seed", countFlags);
  /** 要等整个字库才准的那一类 */
  const wholeCountsKnown = countKnown("whole", countFlags);
  const collectionFaces = useFontStore((s) => s.collectionFaces);
  /**
   * 分组成员数 = 字族级成员 ∪ 字重级成员所在的字族（0.9.9-13）。
   * 只把某个字重放进分组时，计数也要算上那个字族，否则侧栏显示 0、点进去却有卡片。
   */
  const collectionCount = (name: string): number | null => {
    if (!seedCountsKnown) return null;
    const fams = new Set(collections[name] ?? []);
    const keys = collectionFaces[name] ?? [];
    if (keys.length > 0) {
      const set = new Set(keys);
      for (const f of fonts) if (!fams.has(f.family) && set.has(faceKey(f))) fams.add(f.family);
    }
    return fams.size;
  };
  const tags = useFontStore((s) => s.tags);
  // 自动标签配置（总开关 + 「不再建议」否决名单）不改 `tags`，却会改变 `familiesFor` 的
  // 结果（自动标签是按这两个字段现算出来的）。侧栏的标签计数本来就是每次 render 直接算，
  // 所以这里只需要**订阅**这两个字段、让 store 变更触发一次重渲染，不需要 useMemo。
  //
  // 下面两行**故意不取值**（不是漏写 `const x =`）：订阅的目的只是「store 一变就重渲染」，
  // 取到的值没人读；而 `tsconfig` 开了 `noUnusedLocals`，写成局部变量不读会被 `tsc --noEmit`
  // 判错（TS6133）。不取值调用既完成订阅，又不产生未使用变量 —— 后人别把它「修」成赋值。
  useFontStore((s) => s.autoTagDenied);
  useFontStore((s) => s.autoTagEnabled);
  const collections = useFontStore((s) => s.collections);
  const favorites = useFontStore((s) => s.favorites);
  const lastImported = useFontStore((s) => s.lastImported);
  const trash = useFontStore((s) => s.trash);
  const onlineEnabled = useFontStore((s) => s.settings.onlineFontsEnabled);
  // DEF-1：删除非空分组走确认入口（空组才直接删）
  const requestDeleteCollection = useFontStore((s) => s.requestDeleteCollection);
  const renameCollection = useFontStore((s) => s.renameCollection);
  const pendingCollectionFor = useFontStore((s) => s.pendingCollectionFor);
  const snapshots = useFontStore((s) => s.snapshots);
  // 分组右键：把整组字体一键收进同名新快照（2026-11-04）
  const createSnapshotFromCollection = useFontStore((s) => s.createSnapshotFromCollection);
  const deleteSnapshot = useFontStore((s) => s.deleteSnapshot);
  const renameSnapshot = useFontStore((s) => s.renameSnapshot);
  const applySnapshot = useFontStore((s) => s.applySnapshot);
  // DEF-2：清空快照走确认入口（空快照静默返回）
  const requestClearSnapshot = useFontStore((s) => s.requestClearSnapshot);
  const exportSnapshot = useFontStore((s) => s.exportSnapshot);
  const importSnapshots = useFontStore((s) => s.importSnapshots);
  const pendingSnapshotFor = useFontStore((s) => s.pendingSnapshotFor);

  const [creating, setCreating] = useState(false);
  const [creatingSnapshot, setCreatingSnapshot] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renamingSnapshot, setRenamingSnapshot] = useState<string | null>(null);

  /* ── 分组停靠面板（2.3.0）：与标签面板同一套展开 / 固定 / 搜索逻辑 ──
     用户原话：「将分组的交互方式也和标签一样，但是图标和数字保留，也加入搜索框和固定」。
     三种临时钉住与 TagDock 同源：聚焦过滤框、右键按下（菜单关闭后自动解除），
     外加「正在新建 / 改名」期间必须展开，否则输入框会被收掉。 */
  const COLL_PIN_KEY = "zfm.collections.pinned";
  const [collPinned, setCollPinned] = useState(() => {
    try {
      return localStorage.getItem(COLL_PIN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [collFocusHold, setCollFocusHold] = useState(false);
  const [collMenuHold, setCollMenuHold] = useState(false);
  const [collQ, setCollQ] = useState("");
  const menuOpen = useContextMenuOpen();
  useEffect(() => {
    if (!menuOpen) setCollMenuHold(false);
  }, [menuOpen]);

  /* 悬停由全局单值驱动（lib/dockHover.ts）：两个面板上下相邻，各自 :hover 会互相推走 */
  const activeDock = useDockHover((s) => s.active);
  const setActiveDock = useDockHover((s) => s.setActive);
  const collLeaveTimer = useRef<number | null>(null);

  const collEnter = () => {
    if (collLeaveTimer.current !== null) {
      window.clearTimeout(collLeaveTimer.current);
      collLeaveTimer.current = null;
    }
    setActiveDock("collections");
  };

  const collLeave = () => {
    if (collLeaveTimer.current !== null) window.clearTimeout(collLeaveTimer.current);
    collLeaveTimer.current = window.setTimeout(() => {
      collLeaveTimer.current = null;
      if (useDockHover.getState().active === "collections") setActiveDock(null);
    }, DOCK_LEAVE_DELAY);
  };

  useEffect(
    () => () => {
      if (collLeaveTimer.current !== null) window.clearTimeout(collLeaveTimer.current);
    },
    [],
  );
  /** 正在看某个分组时面板保持展开，切到别的导航自然解除（用户 2026-11-16，与标签面板一致） */
  /* 「已固定」只认用户亲手点的图钉；选中分组不再自动撑开面板（2026-11-23 用户）。 */
  const collShowingPinned = collPinned;
  const collOpen =
    collShowingPinned ||
    activeDock === "collections" ||
    collFocusHold ||
    collMenuHold ||
    creating ||
    renaming !== null;

  // 与标签面板同一口径：收起就清掉过滤词，避免下次展开看到一片「没有匹配」（2026-11-16）
  useEffect(() => {
    if (!collOpen) setCollQ((v) => (v === "" ? v : ""));
  }, [collOpen]);

  // 两个面板同时展开时各让一步（各自降到约 220px），否则目录树会被压没、底栏被挤出可视区
  const setDockOpen = useDockOpen((s) => s.setOpen);
  const tagsOpen = useDockOpen((s) => s.tags);
  useEffect(() => {
    setDockOpen("collections", collOpen);
    return () => setDockOpen("collections", false);
  }, [collOpen, setDockOpen]);

  const toggleCollPin = () => {
    const next = !collPinned;
    setCollPinned(next);
    try {
      localStorage.setItem(COLL_PIN_KEY, next ? "1" : "0");
    } catch {
      // 写不进去也不影响本次会话
    }
  };

  /**
   * 插件中心面板装了没有 —— 入口已搬到标题栏（`Titlebar.tsx` 的
   * `PluginCenterButton`，共用 `useWorkshopInstalled`），这里不再需要。
   */

  useEffect(() => {
    if (pendingCollectionFor) setCreating(true);
  }, [pendingCollectionFor]);

  useEffect(() => {
    if (pendingSnapshotFor) setCreatingSnapshot(true);
  }, [pendingSnapshotFor]);

  const familyCount = wholeCountsKnown ? familiesFor(fonts, tags).size : null;
  const sessionActivated = useFontStore((s) => s.sessionActivated);
  const allFamilies = [...familiesFor(fonts, tags).values()];
  const activatedCount = seedCountsKnown
    ? allFamilies.filter(
        (f) => (f.active || f.partial) && !sessionActivated.includes(f.name),
      ).length
    : null;
  const sessionCount = seedCountsKnown
    ? allFamilies.filter((f) => sessionActivated.includes(f.name)).length
    : null;
  const deactivatedCount = wholeCountsKnown
    ? allFamilies.filter((f) => !f.active).length
    : null;
  // 与「系统字体」列表用同一个口径（isSystemFamily），否则计数和点进去看到的数量对不上
  const systemCount = seedCountsKnown ? allFamilies.filter(isSystemFamily).length : null;
  // 标签计数与面板一起搬到 `TagDock`（它自己按当前库里真实存在的族算，口径不变）
  const collapsed = useFontStore((s) => s.collapsedSections);
  const toggleSection = useFontStore((s) => s.toggleSection);
  // 排序必须与字重行胶囊的序号同源（`sortContainers`），否则「快照 2」会对不上第 2 行
  const collectionNames = sortContainers(Object.keys(collections));
  /** 当前正在筛的分组：头部要显示它，和标签面板的 activeTag 同一个口径 */
  const activeCollection = nav.kind === "collection" ? nav.name : null;
  const collNeedle = collQ.trim().toLowerCase();
  const shownCollections = collectionNames.filter(
    (n) => !collNeedle || n.toLowerCase().includes(collNeedle),
  );
  const snapshotNames = sortContainers(snapshots.map((sn) => sn.name));
  const snapshotByName = new Map(snapshots.map((sn) => [sn.name, sn] as const));

  /**
   * 分组右键菜单。从旧的 NavRow 调用点搬出来 —— 分组改由停靠面板自己画行之后，
   * 行仍然是「分组」这一个东西，菜单项必须一字不差地照旧。
   *
   * 分组**不提供**「只导出字体清单（元数据）」：分组是「一批字体」的集合，
   * 单独把它们的元数据导成一份表会和「导出快照」形成两条互不认识的导出线
   * （用户 2026-11-16 明确要求：分组只允许通过快照导出数据）。
   */
  const collectionMenu = (e: React.MouseEvent, name: string) => {
    const members = collections[name] ?? [];
    // 分组内字体直接加进指定快照（用户 2026-10-30）：
    // 与选择菜单同一个 toggle 逻辑 —— 全在就勾着、再点一次整组移出
    const snapItems: MenuItem[] = snapshots.map((sn) => {
      const keys = fonts.filter((f) => members.includes(f.family)).map(faceKey);
      const entryKeys = new Set(sn.entries.map((en) => en.key));
      return {
        kind: "check",
        label: sn.name,
        checked: keys.length > 0 && keys.every((k) => entryKeys.has(k)),
        action: snapshotToggleAction(sn.name, members),
      };
    });
    openContextMenu(e, [
      { label: translate("menu.rename"), action: () => setRenaming(name) },
      { kind: "separator" },
      {
        label: translate("menu.snapshotFromCollection"),
        action: () => void createSnapshotFromCollection(name),
      },
      {
        kind: "submenu",
        label: translate("menu.snapshots"),
        items:
          snapItems.length > 0
            ? snapItems
            : [
                {
                  label: translate("menu.noSnapshots"),
                  disabled: true,
                  action: () => {},
                } satisfies MenuItem,
              ],
      },
      { kind: "separator" },
      {
        label: translate("menu.deleteCollection"),
        danger: true,
        // DEF-1：非空分组弹确认（组内 N 个字体如何处理），空组直接删
        action: () => requestDeleteCollection(name),
      },
    ]);
  };

  const exportSnapshotFlow = async (name: string) => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const safeName = name.replace(/[\\/:*?"<>|]/g, "_").trim() || "snapshot";
    const dest = await saveFileDialog({
      defaultPath: `FontManager_${safeName}_${ts}.S-FontManager`,
      title: translate("menu.exportSnapshotTitle", { name }),
      filters: [{ name: "FontManager", extensions: ["S-FontManager"] }],
    });
    if (dest) void exportSnapshot(name, dest);
  };

  const importSnapshotsFlow = async (mode: "none" | "switch" | "merge") => {
    const src = await openFileDialog({
      multiple: false,
      title: translate("menu.importSnapshotsTitle"),
      // 新后缀和旧 json 都收：导入端按内容认，后缀被改过也没关系
      filters: [
        { name: "FontManager", extensions: ["S-FontManager"] },
        { name: "JSON", extensions: ["json"] },
      ],
    });
    if (src) void importSnapshots(src as string, mode);
  };


  let i = 0;
  return (
    <motion.aside
      className="sidebar"
      initial={intro ? { x: -48, opacity: 0 } : false}
      animate={{ x: 0, opacity: 1 }}
      transition={intro ? springSoft : INTRO_OFF}
    >
      <div className="sidebar-scroll">
        <div className={`sidebar-section ${collapsed.includes("browse") ? "sidebar-collapsed" : ""}`}>
          <div className="sidebar-heading sidebar-heading-row">
            <button
              data-hint="hint.collapse"
              className="sidebar-toggle"
              onClick={() => toggleSection("browse")}
              aria-expanded={!collapsed.includes("browse")}
            >
              <span className="sidebar-chevron">
                <ChevronDown size={12} strokeWidth={2} />
              </span>
              {/* 计数口径说明走悬停提示（用户 2026-10-31：不要占一行位置，悬停「浏览」时出现） */}
              <span data-hint="side.countNote">{t("side.browse")}</span>
            </button>
          </div>
          {!collapsed.includes("browse") && (
          <>
          <NavRow
            nav={{ kind: "library" }}
            icon={<Library size={15} strokeWidth={1.5} />}
            label={t("side.library")}
            count={familyCount}
            hint="hint.sideLibrary"
            index={i++}
          />
          <NavRow
            nav={{ kind: "favorites" }}
            icon={<Star size={15} strokeWidth={1.5} />}
            label={t("side.favorites")}
            count={favorites.length}
            index={i++}
          />
          <NavRow
            nav={{ kind: "lastImported" }}
            icon={<History size={15} strokeWidth={1.5} />}
            label={t("side.lastImported")}
            count={lastImported.length}
            index={i++}
          />
          <NavRow
            nav={{ kind: "activated" }}
            icon={<Power size={15} strokeWidth={1.5} />}
            label={t("side.activated")}
            count={activatedCount}
            hint="hint.sideActivated"
            index={i++}
          />
          <NavRow
            nav={{ kind: "activatedSession" }}
            icon={<Clock size={15} strokeWidth={1.5} />}
            label={t("side.activatedUntilClose")}
            count={sessionCount}
            index={i++}
          />
          <NavRow
            nav={{ kind: "deactivated" }}
            icon={<PowerOff size={15} strokeWidth={1.5} />}
            label={t("side.deactivated")}
            count={deactivatedCount}
            hint="hint.sideDeactivated"
            index={i++}
          />
          <NavRow
            nav={{ kind: "system" }}
            icon={<Monitor size={15} strokeWidth={1.5} />}
            label={t("side.system")}
            count={systemCount}
            hint="hint.sideSystem"
            index={i++}
          />
          </>
          )}
        </div>

        <div className={`sidebar-section ${collapsed.includes("snapshots") ? "sidebar-collapsed" : ""}`}>
          <div className="sidebar-heading sidebar-heading-row">
            <button
              data-hint="hint.snapshotsSection"
              className="sidebar-toggle"
              onClick={() => toggleSection("snapshots")}
              aria-expanded={!collapsed.includes("snapshots")}
            >
              <span className="sidebar-chevron">
                <ChevronDown size={12} strokeWidth={2} />
              </span>
              <span>{t("side.snapshots")}</span>
            </button>
            <motion.button
              data-hint="hint.importSnapshots"
              className="sidebar-add"
              aria-label={t("side.importSnapshots")}
              onClick={(e) =>
                openContextMenu(e, [
                  {
                    label: translate("side.importOnly"),
                    action: () => void importSnapshotsFlow("none"),
                  },
                  {
                    label: translate("side.importSwitch"),
                    action: () => void importSnapshotsFlow("switch"),
                  },
                  {
                    label: translate("side.importMerge"),
                    action: () => void importSnapshotsFlow("merge"),
                  },
                ])
              }
              whileTap={{ scale: 0.94, transition: springSnappy }}
            >
              <FileUp size={13} strokeWidth={2} />
            </motion.button>
            <motion.button
              data-hint="hint.newSnapshot"
              className="sidebar-add"
              aria-label={t("side.newSnapshot")}
              onClick={() => setCreatingSnapshot(true)}
              whileTap={{ scale: 0.94, transition: springSnappy }}
            >
              <Plus size={13} strokeWidth={2} />
            </motion.button>
          </div>
          {!collapsed.includes("snapshots") && (
          <>
          {creatingSnapshot && (
            <NewSnapshotInput
              onDone={() => {
                setCreatingSnapshot(false);
                useFontStore.setState({ pendingSnapshotFor: null, pendingSnapshotFace: null });
              }}
            />
          )}
          {snapshotNames.map((name, si) =>
            renamingSnapshot === name ? (
              <RenameInput
                key={name}
                initial={name}
                onCommit={(next) => {
                  setRenamingSnapshot(null);
                  void renameSnapshot(name, next);
                }}
                onCancel={() => setRenamingSnapshot(null)}
              />
            ) : (
              <NavRow
                key={name}
                nav={{ kind: "snapshot", name }}
                icon={<Camera size={15} strokeWidth={1.5} />}
                no={si + 1}
                label={name}
                count={snapshotByName.get(name)?.entries.length ?? 0}
                index={i++}
                onContextMenu={(e) =>
                  openContextMenu(e, [
                    {
                      label: translate("menu.applySwitch"),
                      action: () => void applySnapshot(name, "switch"),
                    },
                    {
                      label: translate("menu.applyMerge"),
                      action: () => void applySnapshot(name, "merge"),
                    },
                    { label: translate("menu.rename"), action: () => setRenamingSnapshot(name) },
                    {
                      label: translate("menu.exportSnapshot"),
                      action: () => void exportSnapshotFlow(name),
                    },
                    {
                      label: translate("menu.clearSnapshot"),
                      // DEF-2：非空快照弹确认后再清（测试文档 §4.8）
                      action: () => requestClearSnapshot(name),
                    },
                    { kind: "separator" },
                    {
                      label: translate("menu.deleteSnapshot"),
                      danger: true,
                      action: () => void deleteSnapshot(name),
                    },
                  ])
                }
              />
            ),
          )}
          {snapshotNames.length === 0 && !creatingSnapshot && (
            <button className="sidebar-hint" onClick={() => setCreatingSnapshot(true)}>
              {t("side.firstSnapshot")}
            </button>
          )}
          </>
          )}
        </div>

        {/* 标签分区已搬到 `TagDock`（2.3.0）：它必须钉在底栏上方、头部不动，
            所以不能留在可滚动的 `.sidebar-scroll` 里 —— 见 TagDock.tsx 顶部注释。 */}
      </div>

      {/* 分组面板（2.3.0）：与标签面板同一个壳 —— 头部常驻、悬停展开 / 点击固定、
          带过滤框和「固定」按钮。图标（文件夹）与行尾数字按用户要求保留。 */}
      <div
        className={`tag-dock coll-dock ${collOpen ? "open" : ""} ${collPinned ? "pinned" : ""} ${collOpen && tagsOpen ? "half" : ""}`}
        onMouseEnter={collEnter}
        onMouseLeave={collLeave}
      >
        <div
          className="tag-dock-head"
          role="button"
          tabIndex={0}
          aria-expanded={collOpen}
          aria-label={collShowingPinned ? translate("tag.unpinAria") : translate("tag.pinAria")}
          title={collShowingPinned ? translate("tag.pinnedHint") : translate("tag.pinHint")}
          onClick={toggleCollPin}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleCollPin();
            }
          }}
        >
          <FolderOpen size={15} strokeWidth={1.5} className="tag-dock-icon" />
          <span className="tag-dock-title">{t("side.collections")}</span>
          {/* 有选中分组时，头部显示「分组名 + ×」，与标签面板的 activeTag 一致；
              没有选中才显示数量。收起状态下也能看见当前在筛哪个分组。 */}
          {activeCollection ? (
            <span className="tag-dock-filter coll-filter">
              <FolderOpen size={10} strokeWidth={1.8} />
              <span className="tag-dock-filter-name">{activeCollection}</span>
              <span
                className="tag-dock-filter-x"
                role="button"
                tabIndex={0}
                aria-label={translate("tag.filterClear")}
                title={translate("tag.filterClear")}
                onClick={(e) => {
                  e.stopPropagation();
                  setNav({ kind: "library" });
                }}
              >
                <X size={9} strokeWidth={2.4} />
              </span>
            </span>
          ) : (
            collectionNames.length > 0 && (
              <span className="tag-dock-count tabular">{collectionNames.length}</span>
            )
          )}
          <span className={`tag-dock-caret ${collOpen ? "" : "closed"}`}>
            <ChevronRight size={10} strokeWidth={2} />
          </span>
        </div>

        <div className="tag-dock-body">
          <div className="tag-dock-tools">
            <BlinkCaretInput
              value={collQ}
              onChange={(e) => setCollQ(e.target.value)}
              placeholder={translate("side.collectionSearch")}
              aria-label={translate("side.collectionSearch")}
              fieldClassName="tag-dock-search"
              spellCheck={false}
              onFocus={() => setCollFocusHold(true)}
              onBlur={() => setCollFocusHold(false)}
            />
            <button
              className={`tag-tool-btn ${collShowingPinned ? "on" : ""}`}
              title={collShowingPinned ? translate("tag.pinnedHint") : translate("tag.pinHint")}
              aria-pressed={collShowingPinned}
              onClick={toggleCollPin}
            >
              <span className="tag-pin-dot" aria-hidden />
              <span>{collShowingPinned ? translate("tag.pinned") : translate("tag.pin")}</span>
            </button>
            <button
              className="tag-tool-btn"
              title={t("side.newCollection")}
              aria-label={t("side.newCollection")}
              onClick={() => {
                setCreating(true);
                setCollQ("");
              }}
            >
              <Plus size={11} strokeWidth={1.8} />
              <span>{translate("tag.groupShort")}</span>
            </button>
          </div>

          <div className="tag-dock-scroll scroll-hot" role="listbox" aria-label={t("side.collections")}>
            {creating && (
              <NewCollectionInput
                onDone={() => {
                  setCreating(false);
                  useFontStore.setState({ pendingCollectionFor: null, pendingCollectionFace: null });
                }}
              />
            )}
            {shownCollections.map((name, ci) =>
              renaming === name ? (
                <RenameInput
                  key={name}
                  initial={name}
                  onCommit={(next) => {
                    setRenaming(null);
                    void renameCollection(name, next);
                  }}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <motion.div
                  key={name}
                  className={`tag-row coll-row ${
                    nav.kind === "collection" && nav.name === name ? "sel" : ""
                  }`}
                  /* 按压动效必须和标签行**逐字一致**（2026-11-19 用户第三次反馈）：
                     上一轮只对齐了 CSS 的选中态（底色/竖线/行名位移/锚点），但标签行是
                     `motion.div` + `whileTap` 弹簧，分组行是普通 div —— 按下去一个会「压一下再
                     弹回来」，另一个毫无反应，用户的原话是「标签的动画会慢一点，分组是硬切」。
                     这里直接抄 TagDock 那一行的 motion 参数，CSS 里不再重复实现按压。 */
                  whileTap={{ scale: 0.985, transition: springSnappy }}
                  transition={spring}
                  /* 与标签行同一套无障碍语义：容器是 listbox，行是 option */
                  role="option"
                  tabIndex={0}
                  aria-selected={nav.kind === "collection" && nav.name === name}
                  onClick={() => setNav({ kind: "collection", name })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setNav({ kind: "collection", name });
                    } else if (e.key === "F2") {
                      e.preventDefault();
                      setRenaming(name);
                    }
                  }}
                  // 右键**按下**就钉住：面板一收，行从渲染树里消失，contextmenu 就收不到了
                  onMouseDown={(e) => {
                    if (e.button === 2) setCollMenuHold(true);
                  }}
                  onContextMenu={(e) => {
                    setCollMenuHold(true);
                    collectionMenu(e, name);
                  }}
                  title={name}
                >
                  <span className="coll-icon">
                    <FolderOpen size={13} strokeWidth={1.6} />
                  </span>
                  <span className="coll-no tabular">{ci + 1}</span>
                  <span className="tag-row-name">{name}</span>
                  <span className="tag-row-count tabular">
                    {navCountText(collectionCount(name))}
                  </span>
                </motion.div>
              ),
            )}
            {shownCollections.length === 0 && (
              <div className="tag-dock-empty">
                {collectionNames.length === 0
                  ? t("side.firstCollection")
                  : translate("side.noCollectionMatch", { q: collQ.trim() })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 标签面板：钉在底栏上方的一个独立分区（悬停展开 / 点击固定） */}
      <TagDock />

      <div className="sidebar-footer">
        {/* 插件中心入口已挪到标题栏（2026-11-15 用户要求）：侧栏这一行会混在
            「在线 / 回收站 / 关于 / 快捷键」里，而插件中心是窗口级动作
            （点开是一个独立面板窗口）—— 现在是标题栏上的纯图标按钮，
            悬停出「插件中心」，**没装面板就不显示**。 */}
        {onlineEnabled && (
          <NavRow
            nav={{ kind: "online" }}
            icon={<Globe size={15} strokeWidth={1.5} />}
            label={t("side.online")}
            index={i++}
          />
        )}
        <NavRow
          nav={{ kind: "trash" }}
          icon={<Trash2 size={15} strokeWidth={1.5} />}
          label={t("side.trash")}
          count={trash.length}
          index={i++}
        />
        <NavRow
          nav={{ kind: "about" }}
          icon={<Info size={15} strokeWidth={1.5} />}
          label={t("side.about")}
          index={i++}
        />

        <motion.button
          className="nav-row"
          onClick={() => useFontStore.getState().setHelpOpen(true)}
          initial={intro ? { opacity: 0, x: -12 } : false}
          animate={{ opacity: 1, x: 0 }}
          transition={intro ? { ...springSoft, delay: staggerDelay(i++) } : INTRO_OFF}
          whileTap={{ opacity: 0.96, transition: springSnappy }}
        >
          <span className="nav-icon">
            <Keyboard size={15} strokeWidth={1.5} />
          </span>
          <span className="nav-label">{t("side.shortcuts")}</span>
          <kbd className="kbd nav-kbd">?</kbd>
        </motion.button>
      </div>
    </motion.aside>
  );
}
