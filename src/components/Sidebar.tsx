import { motion } from "motion/react";
import { Camera, ChevronDown, Clock, FileUp, FolderOpen, Globe, History, Info, Keyboard, Library, Monitor, Plus, Power, PowerOff, Star, Tag, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { openContextMenu, type MenuItem } from "../design/primitives/ContextMenu";
import { spring, springSnappy, springSoft, staggerDelay } from "../design/springs";
import { INTRO_OFF, useIntro } from "../lib/useIntro";
import { allTags, familiesFor, isSystemFamily, useFontStore, type Family, type Nav } from "../state/fontStore";
import { faceKey } from "../lib/snapshotKey";
import { sortContainers } from "../lib/faceContainers";
import { exportFontList, snapshotToggleAction } from "../lib/menus";
import { t as translate, useT } from "../lib/i18n";

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
  count,
  index,
  no,
  hint,
  onContextMenu,
}: {
  nav: Nav;
  icon: React.ReactNode;
  label: string;
  count?: number;
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
        <motion.span className="nav-pill" layoutId="nav-pill" transition={spring} />
      )}
      <span className="nav-icon">{icon}</span>
      {no !== undefined && <span className="nav-no tabular">{no}</span>}
      <span className="nav-label">{label}</span>
      {count !== undefined && <span className="nav-count tabular">{count}</span>}
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
  const collectionFaces = useFontStore((s) => s.collectionFaces);
  /**
   * 分组成员数 = 字族级成员 ∪ 字重级成员所在的字族（0.9.9-13）。
   * 只把某个字重放进分组时，计数也要算上那个字族，否则侧栏显示 0、点进去却有卡片。
   */
  const collectionCount = (name: string) => {
    const fams = new Set(collections[name] ?? []);
    const keys = collectionFaces[name] ?? [];
    if (keys.length > 0) {
      const set = new Set(keys);
      for (const f of fonts) if (!fams.has(f.family) && set.has(faceKey(f))) fams.add(f.family);
    }
    return fams.size;
  };
  const tags = useFontStore((s) => s.tags);
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

  const familyCount = familiesFor(fonts, tags).size;
  const sessionActivated = useFontStore((s) => s.sessionActivated);
  const allFamilies = [...familiesFor(fonts, tags).values()];
  const activatedCount = allFamilies.filter(
    (f) => (f.active || f.partial) && !sessionActivated.includes(f.name),
  ).length;
  const sessionCount = allFamilies.filter((f) =>
    sessionActivated.includes(f.name),
  ).length;
  const deactivatedCount = allFamilies.filter((f) => !f.active).length;
  // 与「系统字体」列表用同一个口径（isSystemFamily），否则计数和点进去看到的数量对不上
  const systemCount = allFamilies.filter(isSystemFamily).length;
  const tagCounts = allTags(tags);
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
                icon={<Tag size={15} strokeWidth={1.5} />}
                label={tag}
                count={count}
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
