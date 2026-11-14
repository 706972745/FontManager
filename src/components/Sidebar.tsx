import { motion } from "motion/react";
import { Camera, ChevronDown, Clock, FileUp, FolderOpen, Globe, History, Info, Keyboard, Library, Monitor, Plus, Power, PowerOff, Star, Tag, Trash2, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { openContextMenu, type MenuItem } from "../design/primitives/ContextMenu";
import { spring, springSnappy, springSoft, staggerDelay } from "../design/springs";
import { INTRO_OFF, useIntro } from "../lib/useIntro";
import { familiesFor, familyTagCounts, isSystemFamily, useFontStore, type Family, type Nav } from "../state/fontStore";
import { tagLabel } from "../lib/tagLabels";
import { isAutoTagId } from "../lib/tagVocabulary";
import { faceKey } from "../lib/snapshotKey";
import { sortContainers } from "../lib/faceContainers";
import { countKnown, navCountText } from "../lib/seedOverrides";
import { exportFontList, snapshotToggleAction } from "../lib/menus";
import { t as translate, useT } from "../lib/i18n";
import { formatTagExpiry } from "../lib/tagExpiry";

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
      <input
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
      <input
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
      <input
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
  // 标签计数按**当前库里真实存在的族**算，并且把自动标签一起算进来。
  // 不能再用 `allTags(tags)`：那是 state.json 里的原始记录，删掉的字体、移走的字体库
  // 留下的标签都还在里面，会数出「侧栏 20 个、点进去 0 个」。
  const { counts: tagCounts } = familyTagCounts(allFamilies);
  const collapsed = useFontStore((s) => s.collapsedSections);
  const toggleSection = useFontStore((s) => s.toggleSection);
  // 排序必须与字重行胶囊的序号同源（`sortContainers`），否则「快照 2」会对不上第 2 行
  const collectionNames = sortContainers(Object.keys(collections));
  const snapshotNames = sortContainers(snapshots.map((sn) => sn.name));
  const snapshotByName = new Map(snapshots.map((sn) => [sn.name, sn] as const));

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

  const tagExpiry = useFontStore((s) => s.tagExpiry);
  const removeTagEverywhere = (tag: string) => {
    // 交给 store：它按最新状态逐族串行写、失败只报一次（§5 第 36 条）。
    // 以前在这里遍历渲染期的 tags 快照并发、失败逐族弹 toast，会把期间新加的标签覆盖掉。
    void useFontStore.getState().removeTagEverywhere(tag);
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

        <div className={`sidebar-section ${collapsed.includes("collections") ? "sidebar-collapsed" : ""}`}>
          <div className="sidebar-heading sidebar-heading-row">
            <button
              data-hint="hint.collectionsSection"
              className="sidebar-toggle"
              onClick={() => toggleSection("collections")}
              aria-expanded={!collapsed.includes("collections")}
            >
              <span className="sidebar-chevron">
                <ChevronDown size={12} strokeWidth={2} />
              </span>
              <span>{t("side.collections")}</span>
            </button>
            <motion.button
              data-hint="hint.newCollection"
              className="sidebar-add"
              aria-label={t("side.newCollection")}
              onClick={() => setCreating(true)}
              whileTap={{ scale: 0.94, transition: springSnappy }}
            >
              <Plus size={13} strokeWidth={2} />
            </motion.button>
          </div>
          {!collapsed.includes("collections") && (
          <>
          {creating && (
            <NewCollectionInput
              onDone={() => {
                setCreating(false);
                useFontStore.setState({ pendingCollectionFor: null, pendingCollectionFace: null });
              }}
            />
          )}
          {collectionNames.map((name, ci) =>
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
              <NavRow
                key={name}
                nav={{ kind: "collection", name }}
                icon={<FolderOpen size={15} strokeWidth={1.5} />}
                no={ci + 1}
                label={name}
                count={collectionCount(name)}
                index={i++}
                onContextMenu={(e) => {
                  const members = collections[name] ?? [];
                  // 分组内字体直接加进指定快照（用户 2026-10-30）：
                  // 与选择菜单同一个 toggle 逻辑 —— 全在就勾着、再点一次整组移出
                  const snapItems: MenuItem[] = snapshots.map((sn) => {
                    const keys = fonts
                      .filter((f) => members.includes(f.family))
                      .map(faceKey);
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
                    {
                      label: translate("menu.exportFontList"),
                      action: () => {
                        const map = familiesFor(fonts, tags);
                        const fams = members
                          .map((n) => map.get(n))
                          .filter((f): f is Family => Boolean(f));
                        void exportFontList(fams, name);
                      },
                    },
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
                }}
              />
            ),
          )}
          {collectionNames.length === 0 && !creating && (
            <button className="sidebar-hint" onClick={() => setCreating(true)}>
              {t("side.firstCollection")}
            </button>
          )}
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

        {tagCounts.size > 0 && (
          <div className={`sidebar-section ${collapsed.includes("tags") ? "sidebar-collapsed" : ""}`}>
            <div className="sidebar-heading sidebar-heading-row">
              <button
                data-hint="hint.collapse"
                className="sidebar-toggle"
                onClick={() => toggleSection("tags")}
                aria-expanded={!collapsed.includes("tags")}
              >
                <span className="sidebar-chevron">
                  <ChevronDown size={12} strokeWidth={2} />
                </span>
                <span>{t("side.tags")}</span>
              </button>
            </div>
            {!collapsed.includes("tags") &&
              [...tagCounts.entries()].map(([tag, count]) => (
              <NavRow
                key={tag}
                nav={{ kind: "tag", tag }}
                // 图标按**名字**判定（`isAutoTagId`），不按「这条标签是手工存的还是运行时推的」：
                // 软件词表里的名字永远用魔棒，哪怕用户已经把它认可成手工标签、或删掉后又手打了一遍。
                icon={
                  isAutoTagId(tag) ? (
                    <Sparkles size={15} strokeWidth={1.5} />
                  ) : (
                    <Tag size={15} strokeWidth={1.5} />
                  )
                }
                label={tagLabel(tag, t)}
                trailing={
                  // 自动标签不参与到期（用户 2026-11-14），小字只给手工标签
                  !isAutoTagId(tag) && tagExpiry[tag] ? (
                    <span
                      className="tag-expiry-date"
                      title={`${translate("tag.expiryDate")}: ${tagExpiry[tag]}`}
                    >
                      {formatTagExpiry(tagExpiry[tag])}
                    </span>
                  ) : undefined
                }
                // 标签覆盖的是「任意带这个标签的族」，它们的字体大多不在种子里，
                // 只能等全量（见上文 seedCountsKnown / wholeCountsKnown 的分档）
                count={wholeCountsKnown ? count : null}
                index={i++}
                onContextMenu={(e) =>
                  openContextMenu(e, [
                    {
                      label: translate("menu.removeTagEverywhere", { tag }),
                      danger: true,
                      action: () => removeTagEverywhere(tag),
                    },
                  ])
                }
              />
            ))}
          </div>
        )}
      </div>

      <div className="sidebar-footer">
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
