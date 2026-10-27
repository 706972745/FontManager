import { motion } from "motion/react";
import { Camera, ChevronDown, Clock, FileUp, FolderOpen, Globe, History, Info, Keyboard, Library, Monitor, Plus, Power, PowerOff, Star, Tag, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { openContextMenu } from "../design/primitives/ContextMenu";
import { spring, springSoft, staggerDelay } from "../design/springs";
import { INTRO_OFF, useIntro } from "../lib/useIntro";
import { allTags, familiesFor, useFontStore, type Family, type Nav } from "../state/fontStore";
import { exportFontList } from "../lib/menus";
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
  onContextMenu,
}: {
  nav: Nav;
  icon: React.ReactNode;
  label: string;
  count?: number;
  index: number;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const intro = useIntro();
  const current = useFontStore((s) => s.nav);
  const setNav = useFontStore((s) => s.setNav);
  const active = navKey(current) === navKey(nav);
  return (
    <motion.button
      className={`nav-row ${active ? "nav-active" : ""}`}
      onClick={() => setNav(nav)}
      onContextMenu={onContextMenu}
      initial={intro ? { opacity: 0, x: -12 } : false}
      animate={{ opacity: 1, x: 0 }}
      transition={intro ? { ...springSoft, delay: staggerDelay(index) } : INTRO_OFF}
      whileTap={{ scale: 0.97 }}
    >
      {active && (
        <motion.span className="nav-pill" layoutId="nav-pill" transition={spring} />
      )}
      <span className="nav-icon">{icon}</span>
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
  const tags = useFontStore((s) => s.tags);
  const collections = useFontStore((s) => s.collections);
  const favorites = useFontStore((s) => s.favorites);
  const lastImported = useFontStore((s) => s.lastImported);
  const trash = useFontStore((s) => s.trash);
  const onlineEnabled = useFontStore((s) => s.settings.onlineFontsEnabled);
  const deleteCollection = useFontStore((s) => s.deleteCollection);
  const renameCollection = useFontStore((s) => s.renameCollection);
  const setFamilyTags = useFontStore((s) => s.setFamilyTags);
  const pendingCollectionFor = useFontStore((s) => s.pendingCollectionFor);
  const snapshots = useFontStore((s) => s.snapshots);
  const deleteSnapshot = useFontStore((s) => s.deleteSnapshot);
  const renameSnapshot = useFontStore((s) => s.renameSnapshot);
  const applySnapshot = useFontStore((s) => s.applySnapshot);
  const clearSnapshot = useFontStore((s) => s.clearSnapshot);
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
  const systemCount = allFamilies.filter(
    (f) => f.faces.length > 0 && f.faces.every((face) => face.source === "system"),
  ).length;
  const tagCounts = allTags(tags);
  const collapsed = useFontStore((s) => s.collapsedSections);
  const toggleSection = useFontStore((s) => s.toggleSection);
  const collectionNames = Object.keys(collections).sort((a, b) => a.localeCompare(b));
  const snapshotNames = snapshots.map((sn) => sn.name).sort((a, b) => a.localeCompare(b));
  const snapshotByName = new Map(snapshots.map((sn) => [sn.name, sn] as const));

  const exportSnapshotFlow = async (name: string) => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const safeName = name.replace(/[\\/:*?"<>|]/g, "_").trim() || "snapshot";
    const dest = await saveFileDialog({
      defaultPath: `ZFontManager_${safeName}_${ts}.json`,
      title: translate("menu.exportSnapshotTitle", { name }),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (dest) void exportSnapshot(name, dest);
  };

  const importSnapshotsFlow = async (mode: "none" | "switch" | "merge") => {
    const src = await openFileDialog({
      multiple: false,
      title: translate("menu.importSnapshotsTitle"),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (src) void importSnapshots(src as string, mode);
  };

  const removeTagEverywhere = (tag: string) => {
    for (const [family, list] of Object.entries(tags)) {
      if (list.includes(tag)) {
        void setFamilyTags(family, list.filter((t) => t !== tag));
      }
    }
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
              className="sidebar-toggle"
              onClick={() => toggleSection("browse")}
              aria-expanded={!collapsed.includes("browse")}
            >
              <span className="sidebar-chevron">
                <ChevronDown size={12} strokeWidth={2} />
              </span>
              <span>{t("side.browse")}</span>
            </button>
          </div>
          {!collapsed.includes("browse") && (
          <>
          <NavRow
            nav={{ kind: "library" }}
            icon={<Library size={15} strokeWidth={1.5} />}
            label={t("side.library")}
            count={familyCount}
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
            index={i++}
          />
          <NavRow
            nav={{ kind: "system" }}
            icon={<Monitor size={15} strokeWidth={1.5} />}
            label={t("side.system")}
            count={systemCount}
            index={i++}
          />
          </>
          )}
        </div>

        <div className={`sidebar-section ${collapsed.includes("collections") ? "sidebar-collapsed" : ""}`}>
          <div className="sidebar-heading sidebar-heading-row">
            <button
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
              className="sidebar-add"
              aria-label={t("side.newCollection")}
              onClick={() => setCreating(true)}
              whileTap={{ scale: 0.9 }}
            >
              <Plus size={13} strokeWidth={2} />
            </motion.button>
          </div>
          {creating && (
            <NewCollectionInput
              onDone={() => {
                setCreating(false);
                useFontStore.setState({ pendingCollectionFor: null });
              }}
            />
          )}
          {collectionNames.map((name) =>
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
                label={name}
                count={(collections[name] ?? []).length}
                index={i++}
                onContextMenu={(e) =>
                  openContextMenu(e, [
                    { label: translate("menu.rename"), action: () => setRenaming(name) },
                    {
                      label: translate("menu.exportFontList"),
                      action: () => {
                        const map = familiesFor(fonts, tags);
                        const fams = (collections[name] ?? [])
                          .map((n) => map.get(n))
                          .filter((f): f is Family => Boolean(f));
                        void exportFontList(fams, name);
                      },
                    },
                    { kind: "separator" },
                    {
                      label: translate("menu.deleteCollection"),
                      danger: true,
                      action: () => void deleteCollection(name),
                    },
                  ])
                }
              />
            ),
          )}
          {collectionNames.length === 0 && !creating && (
            <button className="sidebar-hint" onClick={() => setCreating(true)}>
              {t("side.firstCollection")}
            </button>
          )}
        </div>

        <div className={`sidebar-section ${collapsed.includes("snapshots") ? "sidebar-collapsed" : ""}`}>
          <div className="sidebar-heading sidebar-heading-row">
            <button
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
              className="sidebar-add"
              aria-label={t("side.importSnapshots")}
              title={t("side.importSnapshots")}
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
              whileTap={{ scale: 0.9 }}
            >
              <FileUp size={13} strokeWidth={2} />
            </motion.button>
            <motion.button
              className="sidebar-add"
              aria-label={t("side.newSnapshot")}
              onClick={() => setCreatingSnapshot(true)}
              whileTap={{ scale: 0.9 }}
            >
              <Plus size={13} strokeWidth={2} />
            </motion.button>
          </div>
          {creatingSnapshot && (
            <NewSnapshotInput
              onDone={() => {
                setCreatingSnapshot(false);
                useFontStore.setState({ pendingSnapshotFor: null });
              }}
            />
          )}
          {snapshotNames.map((name) =>
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
                      action: () => void clearSnapshot(name),
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
        </div>

        {tagCounts.size > 0 && (
          <div className={`sidebar-section ${collapsed.includes("tags") ? "sidebar-collapsed" : ""}`}>
            <div className="sidebar-heading sidebar-heading-row">
              <button
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
          whileTap={{ scale: 0.97 }}
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
