import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  ipc,
  type AdobeApp,
  type AffinityConnection,
  type AppSettings,
  type Classification,
  type FontFace,
  type FontFormat,
  type InstallMode,
  type OnlineFamily,
  type OnlineFamilyDetail,
  type OnlineProgress,
  type ScanProgress,
  type Snapshot,
  type SnapshotEntry,
  type TrashEntry,
} from "../lib/ipc";
import { matchAffinityFonts, type AffinityEvent } from "../lib/affinity";
import { familyActivation, pathsToToggle } from "../lib/familyState";
import { toast } from "../design/primitives/Toast";
import { setSoundLevel, type SoundLevel } from "../lib/sound";
import { applyTheme, type ThemePref } from "../lib/theme";
import {
  getLocalePref,
  hydrateLocalePref,
  isLocalePref,
  setLocalePref as applyLocalePref,
  t,
  type LocalePref,
} from "../lib/i18n";

export const SIZES = [8, 14, 18, 24, 32, 48, 64, 96] as const;

let initStarted = false;

export type ViewMode = "grid" | "list" | "waterfall";
export type MotionPref = "system" | "reduced";
export type TransparencyPref = "full" | "reduced";
export type UiScale = "auto" | number;
export type SortMode = "name" | "styles" | "size" | "glyphs";
/** 快照应用方式：switch = 切换为快照（停用其他）；merge = 合并到当前启用 */
export type SnapshotApplyMode = "switch" | "merge";
export type SourceFilter = "all" | "system" | "user";

export type Nav =
  | { kind: "library" }
  | { kind: "trash" }
  | { kind: "about" }
  | { kind: "tag"; tag: string }
  | { kind: "collection"; name: string }
  | { kind: "snapshot"; name: string }
  | { kind: "favorites" }
  | { kind: "activated" }
  | { kind: "activatedSession" }
  | { kind: "deactivated" }
  | { kind: "system" }
  | { kind: "lastImported" }
  | { kind: "online" };

export interface Family {
  name: string;
  faces: FontFace[];
  formats: string[];
  isVariable: boolean;
  active: boolean;
  partial: boolean;
  activeCount: number;
  deactivatable: boolean;
  tags: string[];
  totalSize: number;
  foundry: string | null;
  classification: Classification;
  scripts: string[];
  features: string[];
  glyphCount: number;
}

interface FontStore {
  phase: "scanning" | "ready" | "error";
  scanProgress: ScanProgress;
  fonts: FontFace[];
  tags: Record<string, string[]>;
  collections: Record<string, string[]>;
  favorites: string[];
  sessionActivated: string[];
  lastImported: string[];
  notes: Record<string, string>;
  trash: TrashEntry[];
  snapshots: Snapshot[];
  panelWidth: number;

  selection: string[];

  visibleOrder: string[];

  compare: string[] | null;

  comparePicking: boolean;
  settingsOpen: boolean;
  helpOpen: boolean;
  paletteOpen: boolean;
  settings: AppSettings;
  affinityConnection: AffinityConnection | null;
  onlineFamilies: OnlineFamily[] | null;
  onlineFetchedAt: number | null;
  onlineLoading: boolean;
  onlineError: string | null;
  onlineQuery: string;
  onlineCategory: string | null;
  onlineLicense: string | null;
  onlineVariableOnly: boolean;
  onlineDetail: OnlineFamilyDetail | null;
  onlineDetailLoading: boolean;
  onlinePreviewPath: string | null;
  onlineDownloading: string | null;
  onlineProgress: OnlineProgress | null;

  adobeAvailable: boolean;
  motionPref: MotionPref;
  transparencyPref: TransparencyPref;
  closeToTray: boolean;
  startMinimized: boolean;
  restoreOnLaunch: boolean;
  lastActivePaths: string[];
  uiScale: UiScale;
  appliedScale: number;
  soundPref: SoundLevel;
  themePref: ThemePref;
  localePref: LocalePref;

  bulkTagFor: string[] | null;

  onboarded: boolean;

  tourStep: number | null;

  sampleText: string;
  sizeIndex: number;
  viewMode: ViewMode;
  sort: SortMode;
  search: string;

  classFilter: Classification[];

  scriptFilter: string[];
  formatFilter: FontFormat[];
  featureFilter: string[];
  sourceFilter: SourceFilter;
  charFilter: string;
  charMatches: string[] | null;
  charSearching: boolean;
  collapsedSections: string[];
  variableOnly: boolean;
  toggleableOnly: boolean;
  nav: Nav;
  selectedFamily: string | null;

  pendingCollectionFor: string | null;

  pendingSnapshotFor: string | null;

  duplicateReport: { names: string[]; at: number } | null;

  init: () => Promise<void>;
  rescan: () => Promise<void>;
  restoreLastActivation: () => Promise<void>;
  setFamilyActive: (family: string, active: boolean) => Promise<void>;
  activateFamilySession: (family: string) => Promise<void>;
  setFontFileActive: (path: string, active: boolean) => Promise<void>;
  uninstallFontFile: (path: string) => Promise<void>;
  installPaths: (paths: string[], mode: InstallMode) => Promise<void>;
  uninstallFamily: (family: string) => Promise<void>;
  restoreTrash: (entryId: string) => Promise<void>;
  deleteTrashEntry: (entryId: string) => Promise<void>;
  emptyTrash: () => Promise<void>;
  setFamilyTags: (family: string, tags: string[]) => Promise<void>;
  createCollection: (name: string) => Promise<void>;
  deleteCollection: (name: string) => Promise<void>;
  renameCollection: (from: string, to: string) => Promise<void>;
  toggleFamilyInCollection: (collection: string, family: string) => Promise<void>;
  createSnapshot: (name: string) => Promise<void>;
  deleteSnapshot: (name: string) => Promise<void>;
  renameSnapshot: (from: string, to: string) => Promise<void>;
  toggleFamilyInSnapshot: (snapshot: string, family: string) => Promise<void>;
  addActiveToSnapshot: (snapshot: string) => Promise<void>;
  /** 应用快照：switch = 关掉其他字体只留快照内的；merge = 在当前启用基础上叠加快照内的字体 */
  applySnapshot: (name: string, mode: SnapshotApplyMode) => Promise<void>;
  removeMissingFromSnapshot: (name: string) => Promise<void>;
  /** 清空快照内所有字体（快照本身保留） */
  clearSnapshot: (name: string) => Promise<void>;
  exportSnapshot: (name: string, dest: string) => Promise<void>;
  /** mode: none = 仅导入；switch = 导入并切换；merge = 导入并合并到当前启用 */
  importSnapshots: (src: string, mode?: SnapshotApplyMode | "none") => Promise<void>;
  toggleFavorite: (family: string) => Promise<void>;
  setFamilyNote: (family: string, note: string) => Promise<void>;
  setFamiliesActiveBulk: (families: string[], active: boolean) => Promise<void>;
  applyFamilyInApp: (family: string, app: AdobeApp) => Promise<void>;
  setPanelWidth: (w: number) => void;
  selectWith: (family: string, mode: "single" | "toggle" | "range", order: string[]) => void;
  selectAll: () => void;
  openCompare: (families: string[]) => void;
  closeCompare: () => void;
  setComparePicking: (on: boolean) => void;
  togglePick: (family: string) => void;
  setSettingsOpen: (open: boolean) => void;
  setHelpOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  updateSettings: (settings: AppSettings) => Promise<void>;
  refreshAffinityConnection: () => Promise<void>;
  pollAffinityLink: () => Promise<void>;
  loadOnlineCatalogue: (force: boolean) => Promise<void>;
  setOnlineQuery: (q: string) => void;
  setOnlineCategory: (c: string | null) => void;
  setOnlineLicense: (l: string | null) => void;
  setOnlineVariableOnly: (on: boolean) => void;
  openOnlineFamily: (id: string) => Promise<void>;
  closeOnlineFamily: () => void;
  installOnlineFamily: (id: string) => Promise<void>;
  setMotionPref: (pref: MotionPref) => void;
  setTransparencyPref: (pref: TransparencyPref) => void;
  setCloseToTray: (v: boolean) => void;
  setStartMinimized: (v: boolean) => void;
  setRestoreOnLaunch: (v: boolean) => void;
  setUiScale: (scale: UiScale) => void;
  toggleFormat: (f: FontFormat) => void;
  toggleFeature: (tag: string) => void;
  setSourceFilter: (v: SourceFilter) => void;
  setCharFilter: (ch: string) => void;
  toggleSection: (id: string) => void;
  setSoundPref: (pref: SoundLevel) => void;
  setThemePref: (pref: ThemePref) => void;
  setLocalePref: (pref: LocalePref) => void;
  startTour: () => void;
  setTourStep: (step: number) => void;
  endTour: () => void;
  setBulkTagFor: (families: string[] | null) => void;
  applyTagToFamilies: (tag: string, families: string[]) => Promise<void>;
  setDuplicateReport: (r: { names: string[]; at: number } | null) => void;

  setSampleText: (t: string) => void;
  setSizeIndex: (i: number) => void;
  setViewMode: (m: ViewMode) => void;
  setSort: (s: SortMode) => void;
  setSearch: (s: string) => void;
  toggleClassFilter: (c: Classification) => void;
  toggleScriptFilter: (s: string) => void;
  setVariableOnly: (on: boolean) => void;
  setToggleableOnly: (on: boolean) => void;
  exportLibraryData: (dest: string) => Promise<void>;
  importLibraryData: (src: string) => Promise<void>;
  setNav: (n: Nav) => void;
  select: (family: string | null) => void;
}

function applyMotionPref(pref: MotionPref) {
  document.documentElement.dataset.motion = pref;
}

function applyTransparencyPref(pref: TransparencyPref) {
  document.documentElement.dataset.transparency = pref;
}

let prefsTimer: ReturnType<typeof setTimeout> | undefined;
function persistPrefs(get: () => FontStore) {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    const s = get();
    void ipc.setPrefs({
      sampleText: s.sampleText,
      sizeIndex: s.sizeIndex,
      viewMode: s.viewMode,
      sort: s.sort,
      panelWidth: s.panelWidth,
      motionPref: s.motionPref,
      transparencyPref: s.transparencyPref,
      closeToTray: s.closeToTray,
      startMinimized: s.startMinimized,
      uiScale: s.uiScale === "auto" ? null : s.uiScale,
      collapsedSections: s.collapsedSections,
      soundPref: s.soundPref,
      themePref: s.themePref,
      localePref: s.localePref,
      onboarded: s.onboarded,
      lastImported: s.lastImported,
      restoreOnLaunch: s.restoreOnLaunch,
      lastActivePaths: s.fonts.filter((f) => f.active).map((f) => f.path),
    });
  }, 600);
}

function entryFromFace(f: FontFace): SnapshotEntry {
  return { path: f.path, family: f.family, system: f.source === "system" };
}

/**
 * 应用一组快照条目（applySnapshot 与导入后应用共用）。
 * 系统安装的字体（system=true）只做记录与标注，无论何种模式都绝不会被停用。
 */
async function applyEntries(
  entries: SnapshotEntry[],
  mode: SnapshotApplyMode,
  label: string,
): Promise<void> {
  const paths = [...new Set(entries.map((e) => e.path))];
  if (paths.length === 0) return;
  const s = useFontStore.getState();
  const byPath = new Map(s.fonts.map((f) => [f.path, f] as const));
  const snapshotSet = new Set(paths);
  const toActivate = paths.filter((p) => {
    const f = byPath.get(p);
    return !!f && f.deactivatable && !f.active;
  });
  const toDeactivate =
    mode === "switch"
      ? s.fonts
          .filter((f) => f.active && f.deactivatable && !snapshotSet.has(f.path))
          .map((f) => f.path)
      : [];
  if (toActivate.length === 0 && toDeactivate.length === 0) {
    toast.success(t("snap.alreadyActive"));
    return;
  }
  try {
    if (toDeactivate.length > 0) await ipc.setFontsActive(toDeactivate, false);
    if (toActivate.length > 0) await ipc.setFontsActive(toActivate, true);
    await useFontStore.getState().rescan();
    persistPrefs(useFontStore.getState);
    toast.success(
      mode === "switch"
        ? t("snap.switchDone", {
            count: toActivate.length,
            deactivated: toDeactivate.length,
            name: label,
          })
        : t("snap.mergeDone", { count: toActivate.length, name: label }),
      undefined,
      "activate",
    );
  } catch (e) {
    toast.error(t("toast.couldntActivate"), String(e));
  }
}

export const useFontStore = create<FontStore>((set, get) => ({
  phase: "scanning",
  scanProgress: { done: 0, total: 0 },
  fonts: [],
  tags: {},
  collections: {},
  snapshots: [],
  favorites: [],
  sessionActivated: [],
  lastImported: [],
  notes: {},
  trash: [],
  panelWidth: 348,
  selection: [],
  visibleOrder: [],
  compare: null,
  comparePicking: false,
  settingsOpen: false,
  helpOpen: false,
  paletteOpen: false,
  settings: { extraDirs: [], watchEnabled: false, autoActivateImports: false, libraryDir: null, libraryDirEnabled: false, affinityEnabled: false, affinityDeactivateOnQuit: true, onlineFontsEnabled: false },
  affinityConnection: null,
  onlineFamilies: null,
  onlineFetchedAt: null,
  onlineLoading: false,
  onlineError: null,
  onlineQuery: "",
  onlineCategory: null,
  onlineLicense: null,
  onlineVariableOnly: false,
  onlineDetail: null,
  onlineDetailLoading: false,
  onlinePreviewPath: null,
  onlineDownloading: null,
  onlineProgress: null,
  adobeAvailable: false,
  motionPref: "system",
  soundPref: "off",
  themePref: "dark",
  transparencyPref: "full",
  closeToTray: false,
  startMinimized: false,
  restoreOnLaunch: true,
  lastActivePaths: [],
  uiScale: "auto",
  appliedScale: 1,
  localePref: getLocalePref(),
  bulkTagFor: null,
  onboarded: false,
  tourStep: null,

  sampleText: t("preview.defaultSample"),
  sizeIndex: 3,
  viewMode: "grid",
  sort: "name",
  search: "",
  classFilter: [],
  scriptFilter: [],
  formatFilter: [],
  featureFilter: [],
  sourceFilter: "all",
  charFilter: "",
  charMatches: null,
  charSearching: false,
  variableOnly: false,
  collapsedSections: [],
  toggleableOnly: false,
  nav: { kind: "library" },
  selectedFamily: null,
  pendingCollectionFor: null,
  pendingSnapshotFor: null,
  duplicateReport: null,

  init: async () => {
    if (initStarted) return;
    initStarted = true;
    await listen<ScanProgress>("scan:progress", (e) => {
      set({ scanProgress: e.payload });
    });
    try {
      const prefs = (await ipc.getPrefs()) ?? {};
      set({
        sampleText: typeof prefs.sampleText === "string" ? prefs.sampleText : get().sampleText,
        sizeIndex: typeof prefs.sizeIndex === "number" ? prefs.sizeIndex : get().sizeIndex,
        viewMode: (["grid", "list", "waterfall"] as const).includes(
          prefs.viewMode as ViewMode,
        )
          ? (prefs.viewMode as ViewMode)
          : "grid",
        sort: (["name", "styles", "size", "glyphs"] as const).includes(prefs.sort as SortMode)
          ? (prefs.sort as SortMode)
          : "name",
        panelWidth:
          typeof prefs.panelWidth === "number"
            ? Math.min(560, Math.max(300, prefs.panelWidth))
            : 348,
        motionPref: prefs.motionPref === "reduced" ? "reduced" : "system",
        transparencyPref: prefs.transparencyPref === "reduced" ? "reduced" : "full",
        closeToTray: prefs.closeToTray === true,
        startMinimized: prefs.startMinimized === true,
        restoreOnLaunch: prefs.restoreOnLaunch !== false,
        uiScale: typeof prefs.uiScale === "number" ? prefs.uiScale : "auto",
        collapsedSections: Array.isArray(prefs.collapsedSections)
          ? (prefs.collapsedSections as unknown[]).filter((n): n is string => typeof n === "string")
          : [],
        soundPref: (["off", "subtle", "on"] as const).includes(prefs.soundPref as SoundLevel)
          ? (prefs.soundPref as SoundLevel)
          : "off",
        themePref: (["dark", "light", "system"] as const).includes(prefs.themePref as ThemePref)
          ? (prefs.themePref as ThemePref)
          : "dark",
        onboarded: prefs.onboarded === true,
        localePref: isLocalePref(prefs.localePref) ? prefs.localePref : get().localePref,
        lastImported: Array.isArray(prefs.lastImported)
          ? (prefs.lastImported as unknown[]).filter((n): n is string => typeof n === "string")
          : [],
        lastActivePaths: Array.isArray(prefs.lastActivePaths)
          ? (prefs.lastActivePaths as unknown[]).filter((n): n is string => typeof n === "string")
          : [],
      });
      setSoundLevel(get().soundPref);
      hydrateLocalePref(get().localePref);
    } catch {
    }
    applyTheme(get().themePref);
    applyMotionPref(get().motionPref);
    applyTransparencyPref(get().transparencyPref);
    try {
      const scale = get().uiScale;
      set({ appliedScale: await ipc.setUiScale(scale === "auto" ? null : scale) });
    } catch {
    }
    try {
      set({ settings: await ipc.getSettings() });
    } catch {
    }
    try {
      set({ adobeAvailable: await ipc.adobeAvailable() });
    } catch {
    }

    let watchTimer: ReturnType<typeof setTimeout> | undefined;
    await listen("fonts:changed", () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        if (get().phase === "scanning") return;
        const before = get().fonts.length;
        void get()
          .rescan()
          .then(() => {
            const after = get().fonts.length;
            if (after !== before) {
              toast.success(
                t("toast.libraryUpdated"),
                after > before
                  ? t("toast.newFontsFound", { count: after - before })
                  : t("toast.fontsRemoved", { count: before - after }),
              );
            }
          });
      }, 1500);
    });
    await listen<AffinityEvent>("affinity:event", (e) => {
      const evt = e.payload;
      if (evt.kind === "needs") {
        const paths = matchAffinityFonts(
          get().fonts,
          evt.docs.flatMap((d) => d.fonts),
        );
        if (paths.length === 0) return;
        void (async () => {
          try {
            const activated = await ipc.affinitySessionActivate(paths);
            if (activated.length === 0) return;
            const titles = [...new Set(evt.docs.map((d) => d.title))].join(", ");
            toast.success(
              t("toast.affinityActivated", { count: activated.length, docs: titles }),
              undefined,
              "activate",
            );
            await get().rescan();
          } catch (err) {
            toast.error(t("toast.affinityError"), String(err));
          }
        })();
      } else if (evt.kind === "deactivated") {
        toast.success(t("toast.affinityDeactivated"), undefined, "activate");
        void get().rescan();
      } else if (evt.kind === "error") {
        toast.error(t("toast.affinityError"), evt.message ?? "");
      }
    });
    await listen<OnlineProgress>("online:progress", (e) => {
      set({ onlineProgress: e.payload });
    });
    await get().rescan();
    await get().restoreLastActivation();
  },

  restoreLastActivation: async () => {
    if (!get().restoreOnLaunch) return;
    const saved = get().lastActivePaths;
    if (saved.length === 0) return;
    const byPath = new Map(get().fonts.map((f) => [f.path, f] as const));
    const missing = [
      ...new Set(
        saved.filter((p) => {
          const face = byPath.get(p);
          return face ? face.deactivatable && !face.active : false;
        }),
      ),
    ];
    if (missing.length === 0) return;
    try {
      await ipc.setFontsActive(missing, true);
      await get().rescan();
      persistPrefs(get);
      toast.success(t("toast.restoredLast", { count: missing.length }), undefined, "activate");
    } catch (e) {
      toast.error(t("toast.couldntRestoreLast"), String(e));
    }
  },

  rescan: async () => {
    set({ phase: "scanning" });
    try {
      const [fonts, tags, collections, snapshots, favorites, notes, trash] = await Promise.all([
        ipc.scanFonts(),
        ipc.getTags(),
        ipc.getCollections(),
        ipc.getSnapshots(),
        ipc.getFavorites(),
        ipc.getNotes(),
        ipc.listTrash(),
      ]);
      set({ fonts, tags, collections, snapshots, favorites, notes, trash, phase: "ready" });
      const names = new Set(fonts.map((f) => f.family));
      const keptImported = get().lastImported.filter((n) => names.has(n));
      if (get().charFilter) set({ charMatches: null, charSearching: false });
      if (keptImported.length !== get().lastImported.length) set({ lastImported: keptImported });
      const alive = new Set(fonts.filter((f) => f.active).map((f) => f.family));
      const kept = get().sessionActivated.filter((n) => alive.has(n));
      if (kept.length !== get().sessionActivated.length) set({ sessionActivated: kept });
    } catch (e) {
      set({ phase: "error" });
      toast.error(t("toast.couldntScan"), String(e));
    }
  },

  setFamilyActive: async (family, active) => {
    const faces = get().fonts.filter((f) => f.family === family && f.deactivatable);
    const paths = pathsToToggle(faces, active);
    if (paths.length === 0) return;

    const prevSession = get().sessionActivated;
    set({
      fonts: get().fonts.map((f) =>
        f.family === family && f.deactivatable ? { ...f, active } : f,
      ),
      sessionActivated: prevSession.filter((n) => n !== family),
    });
    try {
      await ipc.setFontsActive(paths, active);
      persistPrefs(get);
    } catch (e) {
      set({ sessionActivated: prevSession });
      toast.error(t(active ? "toast.couldntActivate" : "toast.couldntDeactivate"), String(e));
      await get().rescan();
      persistPrefs(get);
    }
  },

  activateFamilySession: async (family) => {
    const faces = get().fonts.filter((f) => f.family === family && f.deactivatable);
    const paths = pathsToToggle(faces, true);
    if (paths.length === 0) return;
    set({
      fonts: get().fonts.map((f) =>
        f.family === family && f.deactivatable ? { ...f, active: true } : f,
      ),
    });
    try {
      await ipc.setFontsActiveSession(paths);
      set({ sessionActivated: [...new Set([...get().sessionActivated, family])] });
      toast.success(
        t("toast.activeUntilClose", { family }),
        t("toast.activeUntilCloseSub"),
        "toggle-on",
      );
    } catch (e) {
      toast.error(t("toast.couldntActivate"), String(e));
      await get().rescan();
    }
  },

  setFontFileActive: async (path, active) => {
    const faces = get().fonts.filter((f) => f.path === path);
    if (faces.length === 0) return;
    if (faces.every((f) => f.source === "system")) {
      toast.error(t("toast.cantUninstallSystem"), t("toast.cantUninstallSystemSub"));
      return;
    }
    const targets = faces.filter((f) => f.deactivatable);
    if (targets.length === 0) return;
    const prevFonts = get().fonts;
    set({
      fonts: prevFonts.map((f) =>
        f.path === path && f.deactivatable ? { ...f, active } : f,
      ),
    });
    try {
      await ipc.setFontsActive([path], active);
      persistPrefs(get);
    } catch (e) {
      set({ fonts: prevFonts });
      toast.error(t(active ? "toast.couldntActivate" : "toast.couldntDeactivate"), String(e));
    }
  },

  uninstallFontFile: async (path) => {
    const faces = get().fonts.filter((f) => f.path === path);
    if (faces.length === 0) return;
    if (faces.some((f) => f.source === "system")) {
      toast.error(t("toast.cantUninstallSystem"), t("toast.cantUninstallSystemSub"));
      return;
    }
    const family = faces[0].family;
    try {
      const entry = await ipc.uninstallFont(path, family);
      const remaining = get().fonts.filter((f) => f.path !== path);
      const familyAlive = remaining.some((f) => f.family === family);
      set({
        fonts: remaining,
        trash: await ipc.listTrash(),
        selectedFamily: !familyAlive && get().selectedFamily === family ? null : get().selectedFamily,
        selection: !familyAlive ? get().selection.filter((f) => f !== family) : get().selection,
        lastImported: !familyAlive
          ? get().lastImported.filter((f) => f !== family)
          : get().lastImported,
      });

      if (!familyAlive) {
        const { tags, favorites, collections } = get();
        if (tags[family]) void get().setFamilyTags(family, []);
        if (favorites.includes(family)) void get().toggleFavorite(family);
        for (const [name, members] of Object.entries(collections)) {
          if (members.includes(family)) {
            const next = members.filter((m) => m !== family);
            set({ collections: { ...get().collections, [name]: next } });
            void ipc.setCollection(name, next);
          }
        }
      }
      toast.success(t("toast.movedToTrash", { family }), t("toast.movedToTrashSub"), "trash", {
        label: t("toast.undo"),
        run: () => {
          void (async () => {
            try {
              await ipc.restoreFromTrash(entry.id);
              set({ trash: await ipc.listTrash() });
              await get().rescan();
              toast.success(t("toast.restoredFamily", { family }), undefined, "restore");
            } catch (e) {
              toast.error(t("toast.couldntRestore"), String(e));
            }
          })();
        },
      });
    } catch (e) {
      toast.error(t("toast.couldntMoveToTrash"), String(e));
    }
  },

  installPaths: async (paths, mode) => {
    try {
      const dupKeyOf = (f: { postscriptName: string | null; family: string; style: string }) =>
        f.postscriptName ?? `${f.family} ${f.style}`;
      const existing = get().fonts.map(dupKeyOf);
      const result = await ipc.installFonts(paths, existing, mode);
      if (result.installed.length > 0) {
        const families = [...new Set(result.installed.map((f) => f.family))];
        set({ fonts: [...get().fonts, ...result.installed], lastImported: families });
        persistPrefs(get);
        toast.success(
          families.length === 1
            ? t("toast.installedOne", { name: families[0] })
            : t("toast.installedMany", { count: families.length }),
          undefined,
          "install",
        );
      }
      for (const err of result.errors) toast.error(t("toast.installFailed"), err);
      if (
        result.installed.length === 0 &&
        result.errors.length === 0 &&
        result.duplicates.length === 0
      ) {
        toast.error(t("toast.nothingToInstall"), t("toast.nothingToInstallSub"));
      }
      if (result.duplicates.length > 0) {
        set({
          duplicateReport: { names: [...result.duplicates], at: Date.now() },
        });
      }
    } catch (e) {
      toast.error(t("toast.installFailed"), String(e));
    }
  },

  uninstallFamily: async (family) => {
    const faces = get().fonts.filter(
      (f) => f.family === family && f.source !== "system",
    );
    if (faces.length === 0) {
      toast.error(t("toast.cantUninstallSystem"), t("toast.cantUninstallSystemSub"));
      return;
    }
    const paths = [...new Set(faces.map((f) => f.path))];
    try {
      const entryIds: string[] = [];
      for (const path of paths) {
        entryIds.push((await ipc.uninstallFont(path, family)).id);
      }
      set({
        fonts: get().fonts.filter((f) => !paths.includes(f.path)),
        trash: await ipc.listTrash(),
        selectedFamily: get().selectedFamily === family ? null : get().selectedFamily,
        selection: get().selection.filter((f) => f !== family),
        lastImported: get().lastImported.filter((f) => f !== family),
      });

      const { tags, favorites, collections } = get();
      if (tags[family]) void get().setFamilyTags(family, []);
      if (favorites.includes(family)) void get().toggleFavorite(family);
      for (const [name, members] of Object.entries(collections)) {
        if (members.includes(family)) {
          const next = members.filter((m) => m !== family);
          set({ collections: { ...get().collections, [name]: next } });
          void ipc.setCollection(name, next);
        }
      }
      toast.success(t("toast.movedToTrash", { family }), t("toast.movedToTrashSub"), "trash", {
        label: t("toast.undo"),
        run: () => {
          void (async () => {
            try {
              for (const id of entryIds) await ipc.restoreFromTrash(id);
              set({ trash: await ipc.listTrash() });
              await get().rescan();
              toast.success(t("toast.restoredFamily", { family }), undefined, "restore");
            } catch (e) {
              toast.error(t("toast.couldntRestore"), String(e));
            }
          })();
        },
      });
    } catch (e) {
      toast.error(t("toast.couldntMoveToTrash"), String(e));
    }
  },

  restoreTrash: async (entryId) => {
    try {
      await ipc.restoreFromTrash(entryId);
      set({ trash: await ipc.listTrash() });
      await get().rescan();
      toast.success(t("toast.fontRestored"), undefined, "restore");
    } catch (e) {
      toast.error(t("toast.couldntRestore"), String(e));
    }
  },

  deleteTrashEntry: async (entryId) => {
    try {
      await ipc.deleteTrashEntry(entryId);
      set({ trash: await ipc.listTrash() });
    } catch (e) {
      toast.error(t("toast.couldntDelete"), String(e));
    }
  },

  emptyTrash: async () => {
    try {
      await ipc.emptyTrash();
      set({ trash: [] });
      toast.success(t("toast.trashEmptied"), undefined, "trash-empty");
    } catch (e) {
      toast.error(t("toast.couldntEmptyTrash"), String(e));
    }
  },

  setFamilyTags: async (family, tags) => {
    const prev = get().tags;
    const next = { ...prev };
    if (tags.length === 0) delete next[family];
    else next[family] = tags;
    set({ tags: next });
    try {
      await ipc.setTags(family, tags);
    } catch (e) {
      set({ tags: prev });
      toast.error(t("toast.couldntSaveTags"), String(e));
    }
  },

  createCollection: async (name) => {
    const clean = name.trim();
    if (!clean) return;
    if (get().collections[clean]) {
      toast.error(t("toast.collectionExists"), t("toast.collectionExistsSub", { name: clean }));
      return;
    }
    const prev = get().collections;
    const pending = get().pendingCollectionFor;
    const families = pending ? [pending] : [];
    set({
      collections: { ...prev, [clean]: families },
      pendingCollectionFor: null,
    });
    try {
      await ipc.setCollection(clean, families);
      toast.success(
        t("toast.createdCollection", { name: clean }),
        pending ? t("toast.familyAdded", { name: pending }) : t("toast.rightClickToAdd"),
      );
    } catch (e) {
      set({ collections: prev });
      toast.error(t("toast.couldntCreateCollection"), String(e));
    }
  },

  deleteCollection: async (name) => {
    const prev = get().collections;
    const next = { ...prev };
    delete next[name];
    const nav = get().nav;
    set({
      collections: next,
      nav: nav.kind === "collection" && nav.name === name ? { kind: "library" } : nav,
    });
    try {
      await ipc.deleteCollection(name);
    } catch (e) {
      set({ collections: prev });
      toast.error(t("toast.couldntDeleteCollection"), String(e));
    }
  },

  renameCollection: async (from, to) => {
    const clean = to.trim();
    if (!clean || clean === from) return;
    const prev = get().collections;
    if (prev[clean]) {
      toast.error(t("toast.nameTaken"), t("toast.nameTakenSub", { name: clean }));
      return;
    }
    const next = { ...prev, [clean]: prev[from] ?? [] };
    delete next[from];
    const nav = get().nav;
    set({
      collections: next,
      nav:
        nav.kind === "collection" && nav.name === from
          ? { kind: "collection", name: clean }
          : nav,
    });
    try {
      await ipc.renameCollection(from, clean);
    } catch (e) {
      set({ collections: prev });
      toast.error(t("toast.couldntRenameCollection"), String(e));
    }
  },

  toggleFamilyInCollection: async (collection, family) => {
    const prev = get().collections;
    const current = prev[collection] ?? [];
    const families = current.includes(family)
      ? current.filter((f) => f !== family)
      : [...current, family];
    set({ collections: { ...prev, [collection]: families } });
    try {
      await ipc.setCollection(collection, families);
    } catch (e) {
      set({ collections: prev });
      toast.error(t("toast.couldntUpdateCollection"), String(e));
    }
  },

  createSnapshot: async (name) => {
    const clean = name.trim();
    if (!clean) return;
    if (get().snapshots.some((s) => s.name === clean)) {
      toast.error(t("toast.snapshotExists"), t("toast.nameTakenSub", { name: clean }));
      return;
    }
    const prev = get().snapshots;
    const prevPending = get().pendingSnapshotFor;
    const family = prevPending;
    const seen = new Set<string>();
    const entries: SnapshotEntry[] = [];
    for (const f of get().fonts) {
      const wanted = family ? f.family === family && f.deactivatable : f.active;
      if (!wanted || seen.has(f.path)) continue;
      seen.add(f.path);
      entries.push({ path: f.path, family: f.family, system: f.source === "system" });
    }
    set({ snapshots: [...prev, { name: clean, createdAt: Date.now(), entries }], pendingSnapshotFor: null });
    try {
      const saved = await ipc.saveSnapshot({ name: clean, createdAt: Date.now(), entries });
      set({ snapshots: saved });
      const systemCount = entries.filter((e) => e.system).length;
      toast.success(
        t("toast.createdSnapshot", { name: clean }),
        family
          ? t("toast.familyAdded", { name: family })
          : systemCount > 0
            ? t("snap.systemNote", { count: systemCount })
            : t("toast.rightClickToAdd"),
      );
    } catch (e) {
      set({ snapshots: prev, pendingSnapshotFor: prevPending });
      toast.error(t("toast.couldntCreateSnapshot"), String(e));
    }
  },

  deleteSnapshot: async (name) => {
    const prev = get().snapshots;
    const next = prev.filter((s) => s.name !== name);
    const nav = get().nav;
    set({
      snapshots: next,
      nav: nav.kind === "snapshot" && nav.name === name ? { kind: "library" } : nav,
    });
    try {
      await ipc.deleteSnapshot(name);
    } catch (e) {
      set({ snapshots: prev });
      toast.error(t("toast.couldntDeleteSnapshot"), String(e));
    }
  },

  renameSnapshot: async (from, to) => {
    const clean = to.trim();
    if (!clean || clean === from) return;
    const prev = get().snapshots;
    if (prev.some((s) => s.name === clean)) {
      toast.error(t("toast.nameTaken"), t("toast.nameTakenSub", { name: clean }));
      return;
    }
    const next = prev.map((s) => (s.name === from ? { ...s, name: clean } : s));
    const nav = get().nav;
    set({
      snapshots: next,
      nav: nav.kind === "snapshot" && nav.name === from ? { kind: "snapshot", name: clean } : nav,
    });
    try {
      await ipc.renameSnapshot(from, clean);
    } catch (e) {
      set({ snapshots: prev });
      toast.error(t("toast.couldntRenameSnapshot"), String(e));
    }
  },

  toggleFamilyInSnapshot: async (snapshot, family) => {
    const prev = get().snapshots;
    const snap = prev.find((s) => s.name === snapshot);
    if (!snap) return;
    // 包含系统字体（system 标注），应用快照时系统字体不受影响
    const familyFaces = get().fonts.filter((f) => f.family === family);
    if (familyFaces.length === 0) return;
    const inPaths = new Set(snap.entries.map((e) => e.path));
    const allIn = familyFaces.every((f) => inPaths.has(f.path));
    const entries: SnapshotEntry[] = allIn
      ? snap.entries.filter((e) => !familyFaces.some((f) => f.path === e.path))
      : [...snap.entries, ...familyFaces.filter((f) => !inPaths.has(f.path)).map(entryFromFace)];
    set({ snapshots: prev.map((s) => (s.name === snapshot ? { ...s, entries } : s)) });
    try {
      const saved = await ipc.saveSnapshot({ ...snap, entries });
      set({ snapshots: saved });
    } catch (e) {
      set({ snapshots: prev });
      toast.error(t("toast.couldntUpdateSnapshot"), String(e));
    }
  },

  addActiveToSnapshot: async (snapshot) => {
    const prev = get().snapshots;
    const snap = prev.find((s) => s.name === snapshot);
    if (!snap) return;
    const inPaths = new Set(snap.entries.map((e) => e.path));
    const add = get().fonts.filter((f) => f.active && !inPaths.has(f.path)).map(entryFromFace);
    if (add.length === 0) {
      toast.info?.(t("snap.alreadyActive"));
      return;
    }
    const entries = [...snap.entries, ...add];
    set({ snapshots: prev.map((s) => (s.name === snapshot ? { ...s, entries } : s)) });
    try {
      const saved = await ipc.saveSnapshot({ ...snap, entries });
      set({ snapshots: saved });
      toast.success(
        t("toast.addedToSnapshot", { count: add.length, name: snapshot }),
        undefined,
        "install",
      );
    } catch (e) {
      set({ snapshots: prev });
      toast.error(t("toast.couldntUpdateSnapshot"), String(e));
    }
  },

  applySnapshot: async (name, mode = "merge") => {
    const snap = get().snapshots.find((s) => s.name === name);
    if (!snap) return;
    await applyEntries(snap.entries, mode, name);
  },

  removeMissingFromSnapshot: async (name) => {
    const prev = get().snapshots;
    const snap = prev.find((s) => s.name === name);
    if (!snap) return;
    const alive = new Set(get().fonts.map((f) => f.path));
    const entries = snap.entries.filter((e) => alive.has(e.path));
    if (entries.length === snap.entries.length) return;
    set({ snapshots: prev.map((s) => (s.name === name ? { ...s, entries } : s)) });
    try {
      await ipc.saveSnapshot({ ...snap, entries });
      toast.success(t("toast.removedMissing", { count: snap.entries.length - entries.length }));
    } catch (e) {
      set({ snapshots: prev });
      toast.error(t("toast.couldntUpdateSnapshot"), String(e));
    }
  },

  clearSnapshot: async (name) => {
    const prev = get().snapshots;
    const snap = prev.find((s) => s.name === name);
    if (!snap || snap.entries.length === 0) return;
    set({ snapshots: prev.map((s) => (s.name === name ? { ...s, entries: [] } : s)) });
    try {
      const saved = await ipc.saveSnapshot({ ...snap, entries: [] });
      set({ snapshots: saved });
      toast.success(t("toast.snapshotCleared", { name }));
    } catch (e) {
      set({ snapshots: prev });
      toast.error(t("toast.couldntUpdateSnapshot"), String(e));
    }
  },

  exportSnapshot: async (name, dest) => {
    const snap = get().snapshots.find((s) => s.name === name);
    const payload = {
      app: "ZFontManager",
      kind: "snapshots",
      version: 2,
      exportedAt: new Date().toISOString(),
      snapshots: snap ? [snap] : [],
    };
    try {
      await ipc.writeTextFile(dest, JSON.stringify(payload, null, 2));
      toast.success(t("toast.snapshotExported"), dest, "install");
    } catch (e) {
      toast.error(t("toast.exportFailed"), String(e));
    }
  },

  importSnapshots: async (src, mode = "none") => {
    try {
      const raw: unknown = JSON.parse(await ipc.readTextFile(src));
      const d = raw as Partial<{ app: string; kind: string; snapshots: unknown }>;
      if (d?.app !== "ZFontManager" || !d.snapshots || typeof d.snapshots !== "object") {
        toast.error(t("toast.notAnExport"), t("toast.notAnExportSub"));
        return;
      }
      // v2 格式：snapshots: Snapshot[]；兼容 v1 旧格式：snapshots: Record<string, string[]>
      let list: Snapshot[];
      if (Array.isArray(d.snapshots)) {
        list = (d.snapshots as Snapshot[])
          .filter((s) => s && typeof s.name === "string" && Array.isArray(s.entries))
          .map((s) => ({
            name: s.name,
            createdAt: typeof s.createdAt === "number" ? s.createdAt : Date.now(),
            entries: s.entries
              .filter((e) => e && typeof e.path === "string")
              .map((e) => ({
                path: e.path,
                family: typeof e.family === "string" ? e.family : "",
                system: !!e.system,
              })),
          }));
      } else {
        list = Object.entries(d.snapshots as Record<string, unknown>).flatMap(
          ([origName, value]) =>
            Array.isArray(value)
              ? [
                  {
                    name: origName,
                    createdAt: Date.now(),
                    entries: value
                      .filter((p): p is string => typeof p === "string")
                      .map((path) => ({ path, family: "", system: false })),
                  },
                ]
              : [],
        );
      }
      if (list.length === 0) {
        toast.error(t("toast.importFailed"), t("toast.notAnExportSub"));
        return;
      }
      const imported: Snapshot[] = [];
      for (const snap of list) {
        let name = snap.name;
        let n = 2;
        while (get().snapshots.some((s) => s.name === name)) {
          name = `${snap.name} (${n++})`;
        }
        const prev = get().snapshots;
        set({ snapshots: [...prev, { ...snap, name }] });
        try {
          const saved = await ipc.saveSnapshot({ ...snap, name });
          set({ snapshots: saved });
          imported.push({ ...snap, name });
        } catch {
          set({ snapshots: prev });
        }
      }
      if (imported.length > 0) {
        if (mode === "none") {
          toast.success(
            t("toast.snapshotsImported", { count: imported.length }),
            undefined,
            "restore",
          );
        } else {
          // 合并所有导入快照的条目后应用（切换 / 合并到当前启用）
          const seen = new Set<string>();
          const entries: SnapshotEntry[] = [];
          for (const snap of imported) {
            for (const e of snap.entries) {
              if (!seen.has(e.path)) {
                seen.add(e.path);
                entries.push(e);
              }
            }
          }
          await applyEntries(entries, mode, imported.map((s) => s.name).join(", "));
        }
      } else {
        toast.error(t("toast.importFailed"), t("toast.notAnExportSub"));
      }
    } catch (e) {
      toast.error(t("toast.importFailed"), String(e));
    }
  },

  toggleFavorite: async (family) => {
    const prev = get().favorites;
    const favorite = !prev.includes(family);
    set({ favorites: favorite ? [...prev, family] : prev.filter((f) => f !== family) });
    try {
      await ipc.setFavorite(family, favorite);
    } catch (e) {
      set({ favorites: prev });
      toast.error(t("toast.couldntUpdateFavorites"), String(e));
    }
  },

  setFamilyNote: async (family, note) => {
    const prev = get().notes;
    const next = { ...prev };
    if (note.trim()) next[family] = note;
    else delete next[family];
    set({ notes: next });
    try {
      await ipc.setNote(family, note);
    } catch (e) {
      set({ notes: prev });
      toast.error(t("toast.couldntSaveNote"), String(e));
    }
  },

  setFamiliesActiveBulk: async (families, active) => {
    const paths = pathsToToggle(
      get().fonts.filter((f) => families.includes(f.family)),
      active,
    );
    if (paths.length === 0) return;
    const prevFonts = get().fonts;
    const prevSession = get().sessionActivated;
    set({
      fonts: prevFonts.map((f) =>
        families.includes(f.family) && f.deactivatable ? { ...f, active } : f,
      ),
      sessionActivated: prevSession.filter((n) => !families.includes(n)),
    });
    try {
      await ipc.setFontsActive(paths, active);
      persistPrefs(get);
      toast.success(
        t(active ? "toast.activatedCount" : "toast.deactivatedCount", {
          count: families.length,
        }),
        undefined,
        undefined,
        { label: t("toast.undo"), run: () => void get().setFamiliesActiveBulk(families, !active) },
      );
    } catch (e) {
      set({ sessionActivated: prevSession });
      toast.error(t("toast.bulkUpdateFailed"), String(e));
      await get().rescan();
      persistPrefs(get);
    }
  },

  applyFamilyInApp: async (family, app) => {
    const appName = t(`adobe.${app}`);
    const fam = familiesFor(get().fonts, get().tags).get(family);
    if (!fam) return;
    const lead = fam.faces.find((f) => f.style === "Regular") ?? fam.faces[0];
    if (!lead.postscriptName) {
      toast.error(t("toast.noPostScriptName"), t("toast.noPostScriptNameSub", { app: appName }));
      return;
    }

    if (!fam.active) {
      if (!fam.deactivatable) return;
      await get().activateFamilySession(family);
      if (!familiesFor(get().fonts, get().tags).get(family)?.active) return;
      await new Promise((r) => setTimeout(r, 600));
    }
    try {
      const outcome = await ipc.applyFontInApp(app, lead.postscriptName, family);
      if (outcome.startsWith("applied:")) {
        const count = Number(outcome.slice("applied:".length)) || 1;
        toast.success(
          t("toast.appliedInApp", { family, app: appName }),
          t("toast.appliedLayers", { count }),
          "success",
        );
      } else if (outcome === "created") {
        toast.success(
          t("toast.createdInApp", { app: appName }),
          t("toast.createdInAppSub", { family }),
          "success",
        );
      } else if (outcome === "not-running") {
        toast.error(t("toast.appNotRunning", { app: appName }), t("toast.appNotRunningSub"));
      } else if (outcome === "no-document") {
        toast.error(t("toast.noDocumentInApp", { app: appName }), t("toast.noDocumentInAppSub"));
      } else if (outcome === "font-not-found") {
        toast.error(
          t("toast.fontUnknownToApp", { app: appName, family }),
          t("toast.fontUnknownToAppSub"),
        );
      } else {
        toast.error(t("toast.couldntApplyIn", { app: appName }), outcome);
      }
    } catch (e) {
      toast.error(t("toast.couldntApplyIn", { app: appName }), String(e));
    }
  },

  selectWith: (family, mode, order) => {
    const { selection, selectedFamily } = get();
    if (mode === "single" && selectedFamily === family && selection.length <= 1) {
      set({ selection: [], selectedFamily: null });
      return;
    }
    if (mode === "toggle") {
      const next = selection.includes(family)
        ? selection.filter((f) => f !== family)
        : [...selection, family];
      set({ selection: next, selectedFamily: family });
      return;
    }
    if (mode === "range" && selectedFamily) {
      const a = order.indexOf(selectedFamily);
      const b = order.indexOf(family);
      if (a !== -1 && b !== -1) {
        const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
        set({ selection: [...new Set([...selection, ...range])], selectedFamily: family });
        return;
      }
    }
    set({ selection: [family], selectedFamily: family });
  },

  selectAll: () => {
    const order = get().visibleOrder;
    if (order.length === 0) return;
    set({ selection: [...order], selectedFamily: order[order.length - 1] });
  },

  openCompare: (families) => set({ compare: families.slice(0, 4), comparePicking: false }),
  closeCompare: () => set({ compare: null }),
  setComparePicking: (comparePicking) => set({ comparePicking }),

  togglePick: (family) =>
    set((s) => ({
      selection: s.selection.includes(family)
        ? s.selection.filter((f) => f !== family)
        : [...s.selection, family],
    })),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),

  updateSettings: async (settings) => {
    const prev = get().settings;
    set({ settings });
    try {
      await ipc.setSettings(settings);
    } catch (e) {
      set({ settings: prev });
      toast.error(t("toast.couldntSaveSettings"), String(e));
      return;
    }

    const dirsChanged =
      prev.extraDirs.length !== settings.extraDirs.length ||
      prev.extraDirs.some((d, i) => d !== settings.extraDirs[i]) ||
      prev.libraryDir !== settings.libraryDir ||
      prev.libraryDirEnabled !== settings.libraryDirEnabled;
    if (!dirsChanged || get().phase === "scanning") return;
    const before = get().fonts.length;
    await get().rescan();
    if (get().phase !== "ready") return;
    const after = get().fonts.length;
    const added = settings.extraDirs.length > prev.extraDirs.length;
    toast.success(
      t("toast.libraryUpdated"),
      after > before
        ? t("toast.newFontsFound", { count: after - before })
        : after < before
          ? t("toast.fontsRemoved", { count: before - after })
          : added
            ? t("toast.noFontsInFolder")
            : t("toast.libraryUnchanged"),
    );
  },

  pollAffinityLink: async () => {
    try {
      const link = await ipc.affinityLink();
      if (link) set({ affinityConnection: link });
    } catch {
      return;
    }
  },
  refreshAffinityConnection: async () => {
    try {
      set({ affinityConnection: await ipc.affinityConnection() });
    } catch {
      set({
        affinityConnection: { reachable: false, version: null, docCount: 0, error: null },
      });
    }
  },

  loadOnlineCatalogue: async (force) => {
    if (!get().settings.onlineFontsEnabled) return;
    if (get().onlineLoading) return;
    set({ onlineLoading: true, onlineError: null });
    try {
      const cat = await ipc.onlineCatalogue(force);
      set({ onlineFamilies: cat.families, onlineFetchedAt: cat.fetchedAt, onlineLoading: false });
    } catch (e) {
      set({ onlineLoading: false, onlineError: String(e) });
    }
  },

  setOnlineQuery: (onlineQuery) => set({ onlineQuery }),
  setOnlineCategory: (onlineCategory) => set({ onlineCategory }),
  setOnlineLicense: (onlineLicense) => set({ onlineLicense }),
  setOnlineVariableOnly: (onlineVariableOnly) => set({ onlineVariableOnly }),

  openOnlineFamily: async (id) => {
    set({ onlineDetailLoading: true, onlineDetail: null, onlinePreviewPath: null });
    try {
      const detail = await ipc.onlineFamily(id);
      set({ onlineDetail: detail, onlineDetailLoading: false });
    } catch (e) {
      set({ onlineDetailLoading: false });
      toast.error(t("toast.onlineDetailFailed"), String(e));
      return;
    }
    try {
      const path = await ipc.onlinePreview(id);
      if (get().onlineDetail?.id === id) set({ onlinePreviewPath: path });
    } catch {
      set({ onlinePreviewPath: null });
    }
  },

  closeOnlineFamily: () => {
    const { onlineDetail, onlineDownloading } = get();
    if (onlineDetail && onlineDownloading !== onlineDetail.id) {
      void ipc.onlineClearStaging(onlineDetail.id);
    }
    set({ onlineDetail: null, onlinePreviewPath: null });
  },

  installOnlineFamily: async (id) => {
    if (get().onlineDownloading) return;
    set({ onlineDownloading: id, onlineProgress: null });
    try {
      const res = await ipc.onlineDownload(id);
      await get().installPaths(res.paths, "move");
      const existing = get().tags[res.family] ?? [];
      if (!existing.includes("Online")) {
        await get().setFamilyTags(res.family, [...existing, "Online"]);
      }
      await ipc.onlineClearStaging(id);
      set({ onlineDetail: null, onlinePreviewPath: null });
    } catch (e) {
      toast.error(t("toast.onlineDownloadFailed"), String(e));
    } finally {
      set({ onlineDownloading: null, onlineProgress: null });
    }
  },

  setMotionPref: (motionPref) => {
    set({ motionPref });
    applyMotionPref(motionPref);
    persistPrefs(get);
  },

  setSoundPref: (soundPref) => {
    set({ soundPref });
    setSoundLevel(soundPref);
    persistPrefs(get);
  },

  setThemePref: (themePref) => {
    set({ themePref });
    applyTheme(themePref, true);
    persistPrefs(get);
  },

  setLocalePref: (localePref) => {
    set({ localePref });
    applyLocalePref(localePref);
    persistPrefs(get);
  },

  setBulkTagFor: (bulkTagFor) => set({ bulkTagFor }),

  startTour: () => set({ tourStep: 0 }),
  setTourStep: (tourStep) => set({ tourStep }),
  endTour: () => {
    set({ tourStep: null, onboarded: true, selectedFamily: null, selection: [] });
    persistPrefs(get);
  },

  applyTagToFamilies: async (tag, families) => {
    const clean = tag.trim().toLowerCase();
    if (!clean) return;
    const all = families.every((f) => (get().tags[f] ?? []).includes(clean));
    for (const family of families) {
      const current = get().tags[family] ?? [];
      const next = all
        ? current.filter((t) => t !== clean)
        : current.includes(clean)
          ? current
          : [...current, clean];
      if (next !== current) await get().setFamilyTags(family, next);
    }
  },

  setDuplicateReport: (duplicateReport) => set({ duplicateReport }),

  setPanelWidth: (panelWidth) => {
    set({ panelWidth: Math.min(560, Math.max(300, panelWidth)) });
    persistPrefs(get);
  },

  setSampleText: (sampleText) => {
    set({ sampleText });
    persistPrefs(get);
  },
  setSizeIndex: (sizeIndex) => {
    set({ sizeIndex });
    persistPrefs(get);
  },
  setViewMode: (viewMode) => {
    set({ viewMode });
    persistPrefs(get);
  },
  setSort: (sort) => {
    set({ sort });
    persistPrefs(get);
  },
  setSearch: (search) => set({ search }),
  toggleClassFilter: (c) => {
    const cur = get().classFilter;
    set({ classFilter: cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c] });
  },
  toggleScriptFilter: (s) => {
    const cur = get().scriptFilter;
    set({ scriptFilter: cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s] });
  },
  setVariableOnly: (variableOnly) => set({ variableOnly }),
  toggleFormat: (f) => {
    const cur = get().formatFilter;
    set({ formatFilter: cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f] });
  },
  toggleFeature: (tag) => {
    const cur = get().featureFilter;
    set({ featureFilter: cur.includes(tag) ? cur.filter((x) => x !== tag) : [...cur, tag] });
  },
  setSourceFilter: (v) => {
    set({ sourceFilter: v });
  },
  setCharFilter: (ch) => {
    const first = [...ch.trim()][0] ?? "";
    if (!first) {
      set({ charFilter: "", charMatches: null, charSearching: false });
      return;
    }
    const cp = first.codePointAt(0);
    if (cp === undefined) return;
    set({ charFilter: first, charSearching: true });
    const paths = [...new Set(get().fonts.map((f) => f.path))];
    void ipc
      .fontsWithChar(paths, cp)
      .then((hits) => {
        if (get().charFilter !== first) return;
        const hitSet = new Set(hits);
        const families = new Set(
          get().fonts.filter((f) => hitSet.has(f.path)).map((f) => f.family),
        );
        set({ charMatches: [...families], charSearching: false });
      })
      .catch((e) => {
        if (get().charFilter !== first) return;
        set({ charMatches: [], charSearching: false });
        toast.error(t("toast.charSearchFailed"), String(e));
      });
  },
  toggleSection: (id) => {
    const cur = get().collapsedSections;
    set({ collapsedSections: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
    persistPrefs(get);
  },
  setTransparencyPref: (transparencyPref) => {
    set({ transparencyPref });
    applyTransparencyPref(transparencyPref);
    persistPrefs(get);
  },
  setCloseToTray: (closeToTray) => {
    set({ closeToTray });
    persistPrefs(get);
  },
  setStartMinimized: (startMinimized) => {
    set({ startMinimized });
    persistPrefs(get);
  },
  setRestoreOnLaunch: (restoreOnLaunch) => {
    set({ restoreOnLaunch });
    persistPrefs(get);
  },
  setUiScale: (uiScale) => {
    set({ uiScale });
    persistPrefs(get);
    void ipc
      .setUiScale(uiScale === "auto" ? null : uiScale)
      .then((applied) => set({ appliedScale: applied }))
      .catch(() => {
      });
  },
  setToggleableOnly: (toggleableOnly) => set({ toggleableOnly }),

  exportLibraryData: async (dest) => {
    const { tags, collections, favorites, notes } = get();
    const payload = {
      app: "ZFontManager",
      version: 1,
      exportedAt: new Date().toISOString(),
      tags,
      collections,
      favorites,
      notes,
    };
    try {
      await ipc.writeTextFile(dest, JSON.stringify(payload, null, 2));
      toast.success(t("toast.libraryDataExported"), dest, "install");
    } catch (e) {
      toast.error(t("toast.exportFailed"), String(e));
    }
  },

  importLibraryData: async (src) => {
    try {
      const raw: unknown = JSON.parse(await ipc.readTextFile(src));
      const d = raw as Partial<{
        app: string;
        tags: Record<string, string[]>;
        collections: Record<string, string[]>;
        favorites: string[];
        notes: Record<string, string>;
      }>;
      if (d?.app !== "ZFontManager") {
        toast.error(t("toast.notAnExport"), t("toast.notAnExportSub"));
        return;
      }
      let touched = 0;
      const state = get();
      if (d.tags) {
        for (const [family, list] of Object.entries(d.tags)) {
          if (!Array.isArray(list)) continue;
          const existing = state.tags[family] ?? [];
          const merged = [...new Set([...existing, ...list.map(String)])];
          if (merged.length === existing.length) continue;
          await get().setFamilyTags(family, merged);
          touched++;
        }
      }
      if (d.collections) {
        for (const [name, members] of Object.entries(d.collections)) {
          if (!Array.isArray(members)) continue;
          const existing = get().collections[name];
          const merged = [...new Set([...(existing ?? []), ...members.map(String)])];
          if (existing && merged.length === existing.length) continue;
          set({ collections: { ...get().collections, [name]: merged } });
          await ipc.setCollection(name, merged);
          touched++;
        }
      }
      if (Array.isArray(d.favorites)) {
        for (const family of d.favorites.map(String)) {
          if (!get().favorites.includes(family)) {
            set({ favorites: [...get().favorites, family] });
            await ipc.setFavorite(family, true);
            touched++;
          }
        }
      }
      if (d.notes) {
        for (const [family, note] of Object.entries(d.notes)) {
          if (typeof note !== "string" || get().notes[family]) continue;
          await get().setFamilyNote(family, note);
          touched++;
        }
      }
      toast.success(
        t("toast.libraryDataImported"),
        t("toast.entriesMerged", { count: touched }),
        "restore",
      );
    } catch (e) {
      toast.error(t("toast.importFailed"), String(e));
    }
  },
  setNav: (nav) => set({ nav, selectedFamily: null, selection: [] }),
  select: (selectedFamily) =>
    set({ selectedFamily, selection: selectedFamily ? [selectedFamily] : [] }),
}));

const styleOrder = (f: FontFace) => f.weight * 2 + (f.italic ? 1 : 0);

export function computeFamilies(
  fonts: FontFace[],
  tags: Record<string, string[]>,
): Map<string, Family> {
  const map = new Map<string, Family>();
  for (const f of fonts) {
    let fam = map.get(f.family);
    if (!fam) {
      fam = {
        name: f.family,
        faces: [],
        formats: [],
        isVariable: false,
        active: false,
        partial: false,
        activeCount: 0,
        deactivatable: false,
        tags: tags[f.family] ?? [],
        totalSize: 0,
        foundry: null,
        classification: "unknown",
        scripts: [],
        features: [],
        glyphCount: 0,
      };
      map.set(f.family, fam);
    }
    fam.faces.push(f);
    if (!fam.formats.includes(f.format)) fam.formats.push(f.format);
    fam.isVariable ||= f.isVariable;
    fam.foundry ??= f.foundry;

    if (fam.classification === "unknown") fam.classification = f.classification;
    for (const s of f.scripts ?? []) {
      if (!fam.scripts.includes(s)) fam.scripts.push(s);
    }
    for (const ft of f.features ?? []) {
      if (!fam.features.includes(ft)) fam.features.push(ft);
    }
    fam.glyphCount = Math.max(fam.glyphCount, f.glyphCount ?? 0);
    fam.deactivatable ||= f.deactivatable;
    fam.totalSize += f.fileSize;
  }
  for (const fam of map.values()) {
    fam.faces.sort((a, b) => styleOrder(a) - styleOrder(b));
    Object.assign(fam, familyActivation(fam.faces));
  }
  return map;
}

export function selectVisibleFamilies(s: {
  fonts: FontFace[];
  tags: Record<string, string[]>;
  collections: Record<string, string[]>;
  snapshots: Snapshot[];
  favorites: string[];
  sessionActivated: string[];
  lastImported: string[];
  notes: Record<string, string>;
  search: string;
  classFilter: Classification[];
  scriptFilter: string[];
  formatFilter: FontFormat[];
  featureFilter: string[];
  sourceFilter: SourceFilter;
  charFilter: string;
  charMatches: string[] | null;
  variableOnly: boolean;
  toggleableOnly: boolean;
  nav: Nav;
  sort: SortMode;
}): Family[] {
  const families = [...familiesFor(s.fonts, s.tags).values()];
  const q = s.search.trim().toLowerCase();
  let out = families;
  if (s.classFilter.length > 0) {
    out = out.filter((f) => s.classFilter.includes(f.classification));
  }
  if (s.scriptFilter.length > 0) {
    out = out.filter((f) => s.scriptFilter.every((sc) => f.scripts.includes(sc)));
  }
  if (s.formatFilter.length > 0) {
    out = out.filter((f) => f.formats.some((fmt) => s.formatFilter.includes(fmt as FontFormat)));
  }
  if (s.featureFilter.length > 0) {
    out = out.filter((f) => s.featureFilter.every((tag) => f.features.includes(tag)));
  }
  if (s.sourceFilter === "system") {
    out = out.filter((f) => f.faces.length > 0 && f.faces.every((fc) => fc.source === "system"));
  }
  if (s.sourceFilter === "user") {
    out = out.filter((f) => f.faces.some((fc) => fc.source !== "system"));
  }
  if (s.charFilter) {
    const hits = s.charMatches;
    out = hits === null ? [] : out.filter((f) => hits.includes(f.name));
  }
  if (s.variableOnly) {
    out = out.filter((f) => f.isVariable);
  }
  if (s.toggleableOnly) {
    out = out.filter((f) => f.deactivatable);
  }
  if (s.nav.kind === "tag") {
    const tag = s.nav.tag;
    out = out.filter((f) => f.tags.includes(tag));
  }
  if (s.nav.kind === "collection") {
    const members = s.collections[s.nav.name] ?? [];
    out = out.filter((f) => members.includes(f.name));
  }
  if (s.nav.kind === "snapshot") {
    const snapshotName = s.nav.name;
    const snap = s.snapshots.find((sn) => sn.name === snapshotName);
    const members = snap?.entries.map((e) => e.path) ?? [];
    const memberSet = new Set(members);
    out = out.filter((f) => f.faces.some((fc) => memberSet.has(fc.path)));
    const order = new Map(members.map((p, i) => [p, i] as const));
    const firstIndex = (f: Family) =>
      f.faces.reduce(
        (min, fc) => Math.min(min, order.get(fc.path) ?? Number.MAX_SAFE_INTEGER),
        Number.MAX_SAFE_INTEGER,
      );
    out.sort((a, b) => firstIndex(a) - firstIndex(b) || a.name.localeCompare(b.name));
    return out;
  }
  if (s.nav.kind === "favorites") {
    out = out.filter((f) => s.favorites.includes(f.name));
  }
  if (s.nav.kind === "lastImported") {
    out = out.filter((f) => s.lastImported.includes(f.name));
  }
  if (s.nav.kind === "activated") {
    out = out.filter((f) => (f.active || f.partial) && !s.sessionActivated.includes(f.name));
  }
  if (s.nav.kind === "activatedSession") {
    out = out.filter((f) => s.sessionActivated.includes(f.name));
  }
  if (s.nav.kind === "deactivated") {
    out = out.filter((f) => !f.active);
  }
  if (s.nav.kind === "system") {
    out = out.filter((f) => f.faces.length > 0 && f.faces.every((face) => face.source === "system"));
  }
  if (q) {
    out = out.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.tags.some((t) => t.toLowerCase().includes(q)) ||
        f.formats.some((fmt) => fmt.includes(q)) ||
        (f.foundry?.toLowerCase().includes(q) ?? false) ||
        (s.notes[f.name]?.toLowerCase().includes(q) ?? false),
    );
  }
  switch (s.sort) {
    case "styles":
      out.sort((a, b) => b.faces.length - a.faces.length || a.name.localeCompare(b.name));
      break;
    case "size":
      out.sort((a, b) => b.totalSize - a.totalSize || a.name.localeCompare(b.name));
      break;
    case "glyphs":
      out.sort((a, b) => b.glyphCount - a.glyphCount || a.name.localeCompare(b.name));
      break;
    default:
      out.sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}

export function allTags(tags: Record<string, string[]>): Map<string, number> {
  const m = new Map<string, number>();
  for (const list of Object.values(tags)) {
    for (const t of list) m.set(t, (m.get(t) ?? 0) + 1);
  }
  return new Map([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

export interface FontConflict {
  key: string;
  paths: string[];
}

const familyCache = new WeakMap<FontFace[], WeakMap<object, Map<string, Family>>>();

export function familiesFor(
  fonts: FontFace[],
  tags: Record<string, string[]>,
): Map<string, Family> {
  let byTags = familyCache.get(fonts);
  if (!byTags) {
    byTags = new WeakMap();
    familyCache.set(fonts, byTags);
  }
  let result = byTags.get(tags);
  if (!result) {
    result = computeFamilies(fonts, tags);
    byTags.set(tags, result);
  }
  return result;
}

const conflictCache = new WeakMap<FontFace[], Map<string, FontConflict[]>>();

const activeConflictCache = new WeakMap<FontFace[], Map<string, FontConflict[]>>();

export function activeConflictsFor(fonts: FontFace[]): Map<string, FontConflict[]> {
  let cached = activeConflictCache.get(fonts);
  if (!cached) {
    cached = computeConflicts(fonts.filter((f) => f.active));
    activeConflictCache.set(fonts, cached);
  }
  return cached;
}

export function conflictsFor(fonts: FontFace[]): Map<string, FontConflict[]> {
  let cached = conflictCache.get(fonts);
  if (!cached) {
    cached = computeConflicts(fonts);
    conflictCache.set(fonts, cached);
  }
  return cached;
}

export function computeConflicts(fonts: FontFace[]): Map<string, FontConflict[]> {
  const byKey = new Map<string, { paths: Set<string>; families: Set<string> }>();
  for (const f of fonts) {
    const key = f.postscriptName ?? `${f.family} ${f.style}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { paths: new Set(), families: new Set() };
      byKey.set(key, entry);
    }
    entry.paths.add(f.path);
    entry.families.add(f.family);
  }
  const out = new Map<string, FontConflict[]>();
  for (const [key, { paths, families }] of byKey) {
    if (paths.size < 2) continue;
    for (const fam of families) {
      const list = out.get(fam) ?? [];
      list.push({ key, paths: [...paths] });
      out.set(fam, list);
    }
  }
  return out;
}
