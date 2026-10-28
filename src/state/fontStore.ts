import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { adoptQuickbarDock, DOCK_HEIGHT_HINT, restoreQuickbarDock } from "../lib/useQuickbarDock";
import {
  currentMonitor,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
  PhysicalSize,
} from "@tauri-apps/api/window";
import { MORPH_MS, morphWindow } from "../lib/windowMorph";
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
  type OnlineInstallScope,
  type OnlineProgress,
  type ScanProgress,
  type Snapshot,
  type SnapshotEntry,
  type TrashEntry,
} from "../lib/ipc";
import { matchAffinityFonts, type AffinityEvent } from "../lib/affinity";
import { familyActivation, pathsToToggle } from "../lib/familyState";
import { DEFAULT_HOTKEY, normalizeHotkey, type HotkeySpec } from "../lib/hotkey";
import { cjkKnown } from "../lib/cjk";
import { effectiveCopyrightClass } from "../lib/license";
import { contextMenuSize } from "../lib/menuMetrics";
import { parentDir } from "../lib/onlineCoverage";
import {
  buildFaceIndex,
  entryFromFace,
  entryPaths,
  faceKey,
  migrateEntry,
  missingEntries,
} from "../lib/snapshotKey";
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

/**
 * 导入后看看新落盘的目录里有没有版权文件（LICENSE / OFL 这类），缺了就提醒一次。
 * 只是提醒：不挡导入、不改任何东西。系统字体目录不参与。
 */
async function warnMissingLicenses(faces: FontFace[]) {
  const dirs = [
    ...new Set(
      faces.filter((f) => f.source !== "system").map((f) => parentDir(f.path)),
    ),
  ].filter((d) => d.length > 0);
  if (dirs.length === 0) return;
  try {
    const map = await ipc.infoFiles(dirs);
    const missing = dirs.filter((d) => !map[d] || map[d].length === 0);
    if (missing.length === 0) return;
    toast.info(t("toast.importNoLicense"), t("toast.importNoLicenseSub"));
  } catch {
    // 读不到目录就安静跳过，别为了提醒再弹一个错误
  }
}

let initStarted = false;

export type ViewMode = "grid" | "list" | "waterfall";
export type MotionPref = "system" | "reduced";
export type TransparencyPref = "full" | "reduced";
export type UiScale = "auto" | number;
export type SortMode = "name" | "styles" | "size" | "glyphs" | "added";
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
  /** 版权信息（取自首个字面） */
  license: string | null;
  /** 版权声明文本（取自首个字面） */
  copyright: string | null;
  /** 文件夹备注 / 版权信息文件判定的版权（free/paid/timelimited/unknown），非字体库字体为 null */
  dirCopyrightClass: string | null;
  /** 入库时间（Unix 秒，取所有字面中最早/最大值），0 = 未知 */
  addedAt: number;
}

interface FontStore {
  phase: "scanning" | "ready" | "error";
  scanProgress: ScanProgress;
  /**
   * 扫描途中陆续到达的字体（原生侧每解析一批就推过来）。
   * 只用于「边读边显示」，扫描结束会被权威结果整体覆盖。
   */
  scanFonts: FontFace[];
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
  /** 版权筛选（free/paid/timelimited/unknown），空 = 全部 */
  licenseFilter: string[];
  /** 速览界面：只显示已启用的字体，窗口压缩成一条，贴顶时自动隐藏 */
  quickbar: boolean;
  /** 速览界面里是否启用「贴顶自动隐藏」 */
  quickbarAutoHide: boolean;
  /** 唤出速览的全局快捷键（可在设置里改，默认 Alt + `） */
  quickbarHotkey: HotkeySpec;
  /**
   * 停在完整界面时按快捷键，是否「直接切进速览并自动展开」。
   * 关掉之后快捷键只在速览里生效（展开 / 收起），不会把用户从完整界面拽走。
   */
  quickbarHotkeyOpens: boolean;
  /**
   * 速览 ↔ 完整界面切换期间（毫秒级窗口形变）把内容钉在目标尺寸上（逻辑像素），
   * 这样窗口在形变时内容不会被反复重排，而是被逐步裁切 / 露出来。
   */
  morph: { width: number; height: number } | null;
  /** 用户手动设置的版权状态：family → "free_commercial" | "free_personal" | "paid" | "timelimited"（缺省 = 自动识别） */
  copyrightStatus: Record<string, string>;
  /** 时间限制版权的到期日期：family → "YYYY-MM-DD"（缺省 = 未设置） */
  copyrightExpiry: Record<string, string>;
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
  uninstallFamily: (family: string, opts?: { silent?: boolean; keepMeta?: boolean }) => Promise<void>;
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
  /** 单独应用某个字重（faceId = FontFace.id） */
  applyFaceInApp: (family: string, faceId: string, app: AdobeApp) => Promise<void>;
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
  /**
   * 把在线字族装进字库。
   * scope 不传 = 全部文件 + 许可证；传了则只下 files 里的文件、按 license 决定要不要版权文件。
   */
  installOnlineFamily: (id: string, scope?: OnlineInstallScope) => Promise<void>;
  /** 删除字库里的该字族（进回收站）后重新从在线栏目下载 */
  reinstallOnlineFamily: (id: string) => Promise<void>;
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
  /** 切换速览界面（会压缩/还原窗口大小与位置） */
  setQuickbar: (on: boolean) => Promise<void>;
  setQuickbarAutoHide: (on: boolean) => void;
  /** 改快捷键：本地立即生效并重新注册系统级热键 */
  setQuickbarHotkey: (hk: HotkeySpec) => Promise<void>;
  setQuickbarHotkeyOpens: (on: boolean) => void;
  setSort: (s: SortMode) => void;
  setSearch: (s: string) => void;
  toggleClassFilter: (c: Classification) => void;
  toggleScriptFilter: (s: string) => void;
  setVariableOnly: (on: boolean) => void;
  setToggleableOnly: (on: boolean) => void;
  toggleLicenseFilter: (c: string) => void;
  /** status 为 null / "auto" 时恢复为按版权信息自动识别 */
  setCopyrightStatus: (family: string, status: string | null) => void;
  /** date 为 null 时清除到期日期 */
  setCopyrightExpiry: (family: string, date: string | null) => void;
  exportLibraryData: (dest: string) => Promise<void>;
  importLibraryData: (src: string) => Promise<void>;
  setNav: (n: Nav) => void;
  select: (family: string | null) => void;
}

/** 速览界面窗口尺寸（逻辑像素）：窄竖排面板，高度再翻一倍，靠滚动展示更多字体 */
const QUICKBAR_WIDTH = 400;
const QUICKBAR_HEIGHT = 992;

/**
 * 速览界面里右键菜单必须能被完整放下，窗口最小尺寸由此推导：
 * 最小宽度 = 菜单宽 × 1.5，最小高度 = 菜单高 × 1.5（留出上下滚动的余量）。
 */
const QUICKBAR_MENU_WIDTH_RATIO = 1.5;
const QUICKBAR_MENU_HEIGHT_RATIO = 1.5;
/** setMinSize 算的是窗口外框，菜单宽高是 webview 内容尺寸，这里补偿边框与阴影 */
const QUICKBAR_FRAME_ALLOWANCE = 16;
/** 与屏幕边缘留出的余量，避免窗口压到任务栏 */
const QUICKBAR_SCREEN_MARGIN = 64;

/**
 * 主界面的最小窗口尺寸（逻辑像素），必须与 tauri.conf.json 的 minWidth / minHeight 一致。
 * 速览界面比这个高度矮得多，进入前要解除最小尺寸限制，退出时再还原，否则 setSize 会被系统夹住。
 */
const MAIN_MIN_WIDTH = 900;
const MAIN_MIN_HEIGHT = 600;

/** 由右键菜单尺寸推导速览窗口的最小尺寸（窗口外框，逻辑像素） */
function quickbarMinSize(menu: { width: number; height: number }) {
  return {
    width: Math.ceil(menu.width * QUICKBAR_MENU_WIDTH_RATIO) + QUICKBAR_FRAME_ALLOWANCE,
    height: Math.ceil(menu.height * QUICKBAR_MENU_HEIGHT_RATIO) + QUICKBAR_FRAME_ALLOWANCE,
  };
}

interface WindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

/** 进入速览界面前的主界面窗口几何，退出时还原 */
let quickbarGeometry: WindowGeometry | null = null;

/**
 * 速览 ↔ 完整界面的切换是否正在跑。
 * 两个方向的过渡都是几百毫秒的多段异步操作（形变 / 藏窗口 / 摆几何 / 再显示），
 * 期间的第二次调用如果各跑一套，窗口会被两套流程抢着改几何，最后停在错误的尺寸上。
 */
let quickbarBusy = false;
/** 过渡进行中用户最后一次表达的意图；跑完按它决定要不要再走一趟 */
let quickbarWant: boolean | null = null;

/** 用户关了动效就直接切，不做窗口形变 */
function morphDuration(): number {
  return useFontStore.getState().motionPref === "reduced" ? 0 : MORPH_MS;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 旧版本写进 prefs 的默认示例文本：升级后一律换成当前默认句。
 * （用户自己输入过的内容不会命中这里，原样保留。）
 */
const LEGACY_SAMPLE_TEXTS = new Set(["The quick brown fox jumps over the lazy dog"]);

/** 退出速览时「窗口收走 → 换界面」之间留的一小段时间：让消失这一下先完成 */
const HIDE_SETTLE_MS = 140;
/** 换好界面后到「展开显示」之间留的一小段时间：给主界面渲染一帧 */
const SHOW_SETTLE_MS = 150;
/** 进入速览前旧界面渐隐的时长：和窗口形变衔接成「淡出 → 收起 → 淡入」 */
const UI_FADE_OUT_MS = 150;

async function enterQuickbar() {
  const win = getCurrentWindow();
  try {
    // 上一次可能停在收起状态（或刚从收起里退出），先还原再改几何
    await restoreQuickbarDock();
    // 告诉原生侧进入速览：屏蔽「拖到屏幕顶部就最大化」，改由前端收起窗口
    await ipc.setQuickbarMode(true).catch((e) => console.warn("[quickbar] 切换速览模式失败", e));
    const maximized = await win.isMaximized();
    if (maximized) await win.unmaximize();
    const [pos, size, scale, monitor] = await Promise.all([
      win.outerPosition(),
      win.innerSize(),
      win.scaleFactor(),
      currentMonitor(),
    ]);
    quickbarGeometry = { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized };

    // 目标尺寸：按设计尺寸（400 × 992），但不小于「放得下右键菜单」的下限，也不超出屏幕可用区
    const menuMin = quickbarMinSize(contextMenuSize());
    const availWidth = monitor ? monitor.size.width / scale : QUICKBAR_WIDTH;
    const availHeight = monitor
      ? monitor.size.height / scale - QUICKBAR_SCREEN_MARGIN
      : QUICKBAR_HEIGHT;
    const targetWidth = Math.min(Math.max(QUICKBAR_WIDTH, menuMin.width), availWidth);
    const targetHeight = Math.min(Math.max(QUICKBAR_HEIGHT, menuMin.height), availHeight);
    const width = Math.round(targetWidth * scale);
    // 展开后的速览高度（物理像素），收起态收进顶部一条时记下来用于还原
    const fullHeight = Math.round(targetHeight * scale);
    // 进入速览 = 直接收到屏幕顶部的一条：一次形变到位，不再「先变成完整速览面板」
    const dockHeight = Math.round(DOCK_HEIGHT_HINT * scale);
    let x = pos.x;
    // 顶边对齐到工作区顶（避开任务栏）
    const y = monitor
      ? Math.round(monitor.workArea?.position?.y ?? monitor.position.y)
      : pos.y;
    if (monitor) {
      const maxX = monitor.position.x + monitor.size.width - width;
      x = Math.min(Math.max(x, monitor.position.x), Math.max(monitor.position.x, maxX));
    }

    // 收起成一条后远小于「放得下右键菜单」的最小尺寸，先解除；展开时再补回来
    await win.setMinSize(null);

    // 窗口形变：从主界面几何直接收成「屏幕顶部的一条」，期间内容钉在速览尺寸上
    const ms = morphDuration();
    // 先让旧界面渐隐再形变：不然完整界面会被越缩越小的窗口现场重排（顶栏、搜索框
    // 挤成一条），等 React 换装速览内容时又啪地跳变。淡出走合成器线程的 CSS 动画，
    // 主线程这时正忙着渲染速览内容也卡不住它；旧内容隐掉后再收窗口，跳变就看不见了。
    if (ms > 0) {
      document.body.classList.add("ui-fade-out");
      await sleep(UI_FADE_OUT_MS);
    }
    // 先切界面再把窗口收过来：内容一上来就以速览的尺寸渲染（钉住），
    // 窗口只是逐步裁掉多余的部分，不会看到内容被挤压重排。
    useFontStore.setState({
      quickbar: true,
      morph: ms > 0 ? { width: targetWidth, height: targetHeight } : null,
    });
    await morphWindow(
      { x: pos.x, y: pos.y, width: size.width, height: size.height },
      { x, y, width, height: dockHeight },
      ms,
    );
    // 形变是逐帧动画，窗口被别的程序挡住 / 刚被隐藏过时，个别帧的 setSize/setPosition
    // 会被系统吞掉，最后停在「半路」的几何上：宽度已经是速览的、位置还留在主界面。
    // 所以动画结束后显式落一次终态，保证 dock 状态机接管时的窗口真的贴着顶边。
    await win.setSize(new PhysicalSize(width, dockHeight)).catch(() => {});
    await win.setPosition(new PhysicalPosition(x, y)).catch(() => {});
    // 窗口已经是顶部一条：把收起态交给 dock，展开时还原成完整的速览尺寸
    await adoptQuickbarDock(width, fullHeight).catch((e) =>
      console.warn("[quickbar] 接管收起态失败", e),
    );
    // 速览界面置顶在所有窗口之上，回到完整界面时再取消
    await win.setAlwaysOnTop(true);
  } catch (e) {
    // 窗口几何调不动也要让界面切过去（顶多是全尺寸的速览），不能整个功能失效
    console.warn("[quickbar] 调整窗口几何失败，仅切换界面", e);
    useFontStore.setState({ quickbar: true });
  } finally {
    // 渐隐类只在「完整界面还在场上」时有意义，速览挂载后规则命中不到任何元素；
    // 但必须摘掉，否则下次回到完整界面会被它瞬间隐身
    document.body.classList.remove("ui-fade-out");
    useFontStore.setState({ morph: null });
  }
}

/**
 * 速览状态下按右键菜单的实测尺寸校准窗口最小尺寸（菜单项随上下文变化）。
 * 只在不会触发窗口 resize 的前提下收紧——取与当前尺寸的较小者，
 * 否则菜单显示中窗口被 resize 会立刻把菜单关掉。
 */
export async function syncQuickbarMinSize(): Promise<void> {
  if (!useFontStore.getState().quickbar) return;
  const menuMin = quickbarMinSize(contextMenuSize());
  const win = getCurrentWindow();
  try {
    const [size, scale] = await Promise.all([win.outerSize(), win.scaleFactor()]);
    await win.setMinSize(
      new LogicalSize(
        Math.round(Math.min(menuMin.width, size.width / scale)),
        Math.round(Math.min(menuMin.height, size.height / scale)),
      ),
    );
  } catch (e) {
    console.warn("[quickbar] 同步最小尺寸失败", e);
  }
}

/**
 * 退出速览：先把窗口收走，藏起来之后再换界面、还原几何，最后再展开显示出来
 * ——来回切换时的大跨度变化不需要暴露给用户。
 */
async function exitQuickbar() {
  const win = getCurrentWindow();
  const geometry = quickbarGeometry;
  quickbarGeometry = null;
  try {
    // 先把窗口收走（用 hide 而不是 minimize：最小化状态下改窗口几何会被系统记在
    // 「还原位置」之外，一显示又变回速览的大小），藏起来之后换界面、还原几何，
    // 最后再显示出来——来回切换的大跨度变化用户全程看不到。
    await win.hide().catch(() => {});
    await sleep(HIDE_SETTLE_MS);

    // 收起着就先还原展开尺寸，否则 dock 状态残留
    await restoreQuickbarDock();
    await ipc.setQuickbarMode(false).catch((e) => console.warn("[quickbar] 还原速览模式失败", e));
    const scale = await win.scaleFactor().catch(() => 1);
    if (geometry) {
      // 窗口此刻是隐藏的，几何直接落位，不做形变
      await win.setSize(new PhysicalSize(geometry.width, geometry.height)).catch(() => {});
      await win.setPosition(new PhysicalPosition(geometry.x, geometry.y)).catch(() => {});
    }
    // 还原主界面的最小尺寸限制（提前设会被系统直接夹成 900x600）
    await win.setMinSize(new LogicalSize(MAIN_MIN_WIDTH, MAIN_MIN_HEIGHT));
    await win.setAlwaysOnTop(false).catch(() => {});
    // 切回主界面：内容钉在还原后的尺寸上并淡入，显示出来的就是最终布局
    useFontStore.setState({
      quickbar: false,
      morph: geometry
        ? { width: geometry.width / scale, height: geometry.height / scale }
        : null,
    });
    if (geometry?.maximized) await win.maximize().catch(() => {});
    // 给主界面渲染一帧的时间，再把它展开显示出来
    await sleep(SHOW_SETTLE_MS);
    await win.show().catch(() => {});
    await win.setFocus().catch(() => {});
    // 淡入走完再解除内容钉住
    await sleep(MORPH_MS);
    useFontStore.setState({ morph: null });
    // 显示之后读回一次几何：窗口隐藏期间的 setSize/setPosition 有可能被系统吞掉，
    // 结果就是「人已经回到完整界面了，窗口还留着速览的尺寸」——快速来回切换时最容易撞上。
    // 这里做一次读回校验，不对就补写。
    if (geometry && !geometry.maximized) {
      try {
        const [size, pos] = await Promise.all([win.innerSize(), win.outerPosition()]);
        const off =
          (pos.x !== geometry.x || pos.y !== geometry.y) ||
          Math.abs(size.width - geometry.width) > 8 ||
          Math.abs(size.height - geometry.height) > 8;
        if (off) {
          await win.setSize(new PhysicalSize(geometry.width, geometry.height)).catch(() => {});
          await win.setPosition(new PhysicalPosition(geometry.x, geometry.y)).catch(() => {});
        }
      } catch {
        /* 读不到几何就算了，用户再点一次切速览会重新记录 */
      }
    }
    return;
  } catch (e) {
    console.warn("[quickbar] 还原窗口几何失败", e);
    useFontStore.setState({ quickbar: false, morph: null });
    await win.show().catch(() => {});
    await win.unminimize().catch(() => {});
  } finally {
    // 无论几何还原是否成功，回到完整界面都要取消置顶
    void win
      .setAlwaysOnTop(false)
      .catch((e) => console.warn("[quickbar] 取消置顶失败", e));
    useFontStore.setState({ quickbar: false, morph: null });
  }
}

function applyMotionPref(pref: MotionPref) {
  document.documentElement.dataset.motion = pref;
}

function applyTransparencyPref(pref: TransparencyPref) {
  document.documentElement.dataset.transparency = pref;
}

/**
 * 版权状态同步改了字族目录名后重扫一次：目录改名 = 字体路径变了，
 * 不重扫的话列表里还是旧路径（启用/停用会找不到文件）。合并 1 秒内的多次改动。
 */
let copyrightRescanTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleCopyrightRescan(get: () => FontStore) {
  clearTimeout(copyrightRescanTimer);
  copyrightRescanTimer = setTimeout(() => {
    copyrightRescanTimer = undefined;
    void get().rescan();
  }, 1000);
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
      copyrightStatus: s.copyrightStatus,
      copyrightExpiry: s.copyrightExpiry,
      quickbarHotkey: s.quickbarHotkey,
      quickbarHotkeyOpens: s.quickbarHotkeyOpens,
    });
  }, 600);
}/**
 * 应用一组快照条目（applySnapshot 与导入后应用共用）。
 * 条目本身不含路径，先按可移植标识解析到本机字体，再执行启用/停用。
 * 系统安装的字体（system=true）只做记录与标注，无论何种模式都绝不会被停用。
 */
async function applyEntries(
  entries: SnapshotEntry[],
  mode: SnapshotApplyMode,
  label: string,
): Promise<void> {
  const s = useFontStore.getState();
  const paths = entryPaths(entries, buildFaceIndex(s.fonts));
  if (paths.length === 0) return;
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

/**
 * 把「应用字体」的各种返回值翻译成提示。
 * 字族级和字重级应用走的是同一套后端命令，结果文案也要一致，
 * 所以抽出来共用（label 是被应用的那个字体名：字族名或「字族 字重」）。
 */
function reportApplyOutcome(outcome: string, family: string, app: AdobeApp) {
  const appName = t(`adobe.${app}`);
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
      } else if (outcome === "not-installed") {
  toast.error(t("toast.appNotInstalled", { app: appName }), t("toast.appNotInstalledSub", { app: appName }));
      } else if (outcome === "launch-timeout") {
  toast.error(t("toast.appLaunchTimeout", { app: appName }), t("toast.appLaunchTimeoutSub", { app: appName }));
      } else if (outcome === "app-no-response") {
  // 宿主重连一次仍然超时：CorelDRAW 那一侧真的没应答
  toast.error(
    t("toast.appNoResponse", { app: appName }),
    t("toast.appNoResponseSub", { app: appName }),
  );
      } else if (outcome === "no-document") {
  toast.error(t("toast.noDocumentInApp", { app: appName }), t("toast.noDocumentInAppSub"));
      } else if (outcome === "font-not-found") {
  toast.error(
    t("toast.fontUnknownToApp", { app: appName, family }),
    t("toast.fontUnknownToAppSub"),
  );
      } else if (outcome === "font-rejected") {
  // 字体在目标软件的字体列表里，但赋值被它静默拒绝
  // （最常见：给中文文字套用不含中文字形的西文字体）
  toast.error(
    t("toast.fontRejected", { app: appName, family }),
    t("toast.fontRejectedSub"),
  );
      } else if (outcome === "apply-failed") {
  toast.error(
    t("toast.applyFailed", { app: appName }),
    t("toast.applyFailedSub", { app: appName }),
  );
      } else if (outcome === "no-text-selected") {
  toast.error(
    t("toast.noTextSelected", { app: appName }),
    t("toast.noTextSelectedSub", { app: appName }),
  );
      } else if (outcome.startsWith("ps-error:")) {
  toast.error(t("toast.couldntApplyIn", { app: appName }), outcome.slice("ps-error:".length).trim());
      } else {
  toast.error(t("toast.couldntApplyIn", { app: appName }), outcome);
      }
}

/**
 * 本地化族名的候选串（给「应用到 PS / AI / CDR」用）。
 *
 * 中文字体在字体文件里通常同时写了英文名（Source Han Serif CN）和本地化名（思源宋体 CN），
 * 而 CorelDRAW 一律按本地化名登记字体 —— 只报英文名会成片地 font-not-found。
 * 这里把每个本地化名原样和「本地化名 + 字重」都带上，后端按顺序逐个试。
 */
function localizedAliases(face: FontFace): string[] {
  const out: string[] = [];
  const style = face.style?.trim();
  for (const loc of face.localizedNames ?? []) {
    const name = (loc.name ?? "").trim();
    if (!name || out.includes(name)) continue;
    out.push(name);
    if (style && !out.includes(`${name} ${style}`)) out.push(`${name} ${style}`);
  }
  return out;
}

/**
 * 字体里没有汉字时提醒一句。
 *
 * 不提醒的后果很具体：用户给中文段落套一款西文字体，PS/AI/CDR 全都「成功」了，
 * 但画面一点没变（或变成方块），于是判定「应用字体这个功能坏了」。
 * 这里在真正应用前问一下后端，没有汉字就明说，再照常应用。
 */
async function warnIfNoCjk(face: { path: string; faceIndex: number }, name: string) {
  const has = await cjkKnown(face);
  if (!has) {
    toast.info(t("toast.noCjkGlyphs", { name }), t("toast.noCjkGlyphsSub"));
  }
}

export const useFontStore = create<FontStore>((set, get) => ({
  phase: "scanning",
  scanProgress: { done: 0, total: 0 },
  scanFonts: [],
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
  quickbar: false,
  quickbarAutoHide: true,
  quickbarHotkey: DEFAULT_HOTKEY,
  quickbarHotkeyOpens: true,
  morph: null,
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
  licenseFilter: [],
  copyrightStatus: {},
  copyrightExpiry: {},
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
    // 边扫边显示：原生侧每解析一批就推一批过来，界面立刻能铺卡片，
    // 不用等整库扫完（几千个字体要好几秒）才「啪」地一次性出现。
    await listen<FontFace[]>("scan:batch", (e) => {
      const cur = get().scanFonts;
      set({ scanFonts: cur.concat(e.payload) });
    });
    try {
      const prefs = (await ipc.getPrefs()) ?? {};
      set({
        // 老版本把默认示例文本也存进了 prefs，升级后要换成新的默认句；
        // 用户自己改过的（不是那句默认）原样保留。
        sampleText:
          typeof prefs.sampleText === "string" && !LEGACY_SAMPLE_TEXTS.has(prefs.sampleText)
            ? prefs.sampleText
            : get().sampleText,
        sizeIndex: typeof prefs.sizeIndex === "number" ? prefs.sizeIndex : get().sizeIndex,
        viewMode: (["grid", "list", "waterfall"] as const).includes(
          prefs.viewMode as ViewMode,
        )
          ? (prefs.viewMode as ViewMode)
          : "grid",
        sort: (["name", "styles", "size", "glyphs", "added"] as const).includes(prefs.sort as SortMode)
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
        copyrightStatus:
          prefs.copyrightStatus && typeof prefs.copyrightStatus === "object"
            ? Object.fromEntries(
                Object.entries(prefs.copyrightStatus as Record<string, unknown>)
                  .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
              )
            : get().copyrightStatus,
        copyrightExpiry:
          prefs.copyrightExpiry && typeof prefs.copyrightExpiry === "object"
            ? Object.fromEntries(
                Object.entries(prefs.copyrightExpiry as Record<string, unknown>)
                  .filter(
                    (entry): entry is [string, string] =>
                      typeof entry[1] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry[1]),
                  ),
              )
            : get().copyrightExpiry,
        quickbarHotkey: normalizeHotkey(prefs.quickbarHotkey),
        quickbarHotkeyOpens: prefs.quickbarHotkeyOpens !== false,
      });
      setSoundLevel(get().soundPref);
      hydrateLocalePref(get().localePref);
      // 把偏好里的快捷键再同步给原生侧一次：
      // 启动时原生已经按偏好注册过，但这一趟同时也覆盖「上次注册被占用、
      // 用户后来把占用方关了」的情况，并保证前后端配置不会因为某次写入失败而错位。
      void ipc.setQuickbarHotkey(get().quickbarHotkey).catch(() => {});
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
    // 字库扫描（几千个字体）要好几秒甚至十几秒。原来窗口是「扫描完成之后才显示」，
    // 这段时间用户对着空桌面干等，什么反馈都没有。先把窗口亮出来——里面是骨架屏 +
    // 底部百分比进度条，扫完自然换成字体库（见 components/LoadProgress.tsx）。
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
      // 原来这里会整库 rescan：注册表刚写完又要重扫一遍、重判一遍激活，
      // 界面就会在「读取 100%」之后再闪一次骨架屏，看起来像卡住了。
      // 注册表已经落好了，本地把对应字面标成激活即可，剩下的交给下次扫描。
      const revived = new Set(missing);
      set({
        fonts: get().fonts.map((f) => (revived.has(f.path) ? { ...f, active: true } : f)),
      });
      persistPrefs(get);
      toast.success(t("toast.restoredLast", { count: missing.length }), undefined, "activate");
    } catch (e) {
      toast.error(t("toast.couldntRestoreLast"), String(e));
    }
  },

  rescan: async () => {
    set({ phase: "scanning", scanFonts: [] });
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
      set({
        fonts,
        tags,
        collections,
        snapshots,
        favorites,
        notes,
        trash,
        phase: "ready",
        // 权威结果已到位，临时列表可以丢了（否则会多占一份内存）
        scanFonts: [],
      });
      // 旧版快照记录的是绝对路径（换电脑/改字体库路径就失效）：
      // 扫描完手头字体后统一迁移成可移植标识，并回写 state.json
      const index = buildFaceIndex(fonts);
      for (const snap of snapshots) {
        const entries = snap.entries.map((e) => migrateEntry(e, index));
        const changed = entries.some((e, i) => {
          const old = snap.entries[i];
          return (
            old.path !== undefined ||
            e.key !== old.key ||
            e.family !== old.family ||
            e.style !== old.style ||
            !!e.system !== !!old.system
          );
        });
        if (!changed) continue;
        const next = { ...snap, entries };
        set({ snapshots: get().snapshots.map((s) => (s.name === snap.name ? next : s)) });
        try {
          await ipc.saveSnapshot(next);
        } catch {
          /* 迁移回写失败不影响本次使用 */
        }
      }
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
        void warnMissingLicenses(result.installed);
      }
      for (const err of result.errors) toast.error(t("toast.installFailed"), err);
      // WOFF 判重：同字体已有 ttf/otf（或 woff2 不受支持）被跳过的个数
      if (result.webfontsSkipped) {
        toast.info(t("toast.webfontsSkipped", { count: result.webfontsSkipped }));
      }
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

  uninstallFamily: async (family, opts) => {
    const silent = opts?.silent === true;
    const keepMeta = opts?.keepMeta === true;
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

      if (!keepMeta) {
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
      if (silent) return;
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
      const entry = entryFromFace(f);
      if (!wanted || seen.has(entry.key)) continue;
      seen.add(entry.key);
      entries.push(entry);
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
    const familyKeys = familyFaces.map(faceKey);
    const inKeys = new Set(snap.entries.map((e) => e.key));
    const allIn = familyKeys.every((k) => inKeys.has(k));
    const entries: SnapshotEntry[] = allIn
      ? snap.entries.filter((e) => !familyKeys.includes(e.key))
      : [
          ...snap.entries,
          ...familyFaces.filter((_, i) => !inKeys.has(familyKeys[i])).map(entryFromFace),
        ];
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
    const inKeys = new Set(snap.entries.map((e) => e.key));
    const add = get()
      .fonts.filter((f) => f.active)
      .map(entryFromFace)
      .filter((e) => !inKeys.has(e.key));
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
    const missing = new Set(missingEntries(snap.entries, buildFaceIndex(get().fonts)));
    const entries = snap.entries.filter((e) => !missing.has(e));
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
    // 导出的条目只保留可移植字段：不含路径、不含字体文件，换电脑可直接导入
    const entries = (snap?.entries ?? []).map((e) => ({
      key: e.key,
      family: e.family,
      style: e.style,
      system: !!e.system,
    }));
    const payload = {
      app: "ZFontManager",
      kind: "snapshots",
      version: 3,
      portable: true,
      exportedAt: new Date().toISOString(),
      snapshots: snap ? [{ name: snap.name, createdAt: snap.createdAt, entries }] : [],
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
      // v3/v2 格式：snapshots: Snapshot[]；兼容 v1 旧格式：snapshots: Record<string, string[]>
      // 旧格式条目只有绝对路径 → 导入时立刻按本机字体迁移为可移植 key
      const index = buildFaceIndex(get().fonts);
      const normalize = (e: Partial<SnapshotEntry>): SnapshotEntry =>
        migrateEntry(
          {
            key: typeof e.key === "string" ? e.key : "",
            path: typeof e.path === "string" ? e.path : undefined,
            family: typeof e.family === "string" ? e.family : "",
            style: typeof e.style === "string" ? e.style : "",
            system: !!e.system,
          },
          index,
        );
      let list: Snapshot[];
      if (Array.isArray(d.snapshots)) {
        list = (d.snapshots as Snapshot[])
          .filter((s) => s && typeof s.name === "string" && Array.isArray(s.entries))
          .map((s) => ({
            name: s.name,
            createdAt: typeof s.createdAt === "number" ? s.createdAt : Date.now(),
            entries: (s.entries as Partial<SnapshotEntry>[])
              .filter((e) => e && (typeof e.key === "string" || typeof e.path === "string"))
              .map(normalize),
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
                      .map((path) => normalize({ path })),
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
          // 快照只记字体清单、不含字体文件：把「有多少条在本机真的落地」当场说清楚，
          // 否则用户会以为「导入了快照 = 字体也装回来了」。
          const index = buildFaceIndex(get().fonts);
          let total = 0;
          let missing = 0;
          for (const snap of imported) {
            total += snap.entries.length;
            missing += missingEntries(snap.entries, index).length;
          }
          toast.success(
            t("toast.snapshotsImported", { count: imported.length }),
            missing > 0
              ? t("toast.snapshotsImportedPartial", { total, missing })
              : t("toast.snapshotsImportedAll", { total }),
            "restore",
          );
        } else {
          // 合并所有导入快照的条目后应用（切换 / 合并到当前启用）
          const seen = new Set<string>();
          const entries: SnapshotEntry[] = [];
          for (const snap of imported) {
            for (const e of snap.entries) {
              const id = e.key || `${e.family}|${e.style}`;
              if (seen.has(id)) continue;
              seen.add(id);
              entries.push(e);
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

    // 应用前先说清楚「这个字重里没有汉字」，免得用户对着没变化的文档猜
    await warnIfNoCjk(lead, family);

    if (!fam.active) {
      if (!fam.deactivatable) return;
      await get().activateFamilySession(family);
      if (!familiesFor(get().fonts, get().tags).get(family)?.active) return;
      await new Promise((r) => setTimeout(r, 600));
    }
    try {
      const outcome = await ipc.applyFontInApp(
        app,
        lead.postscriptName,
        family,
        family,
        localizedAliases(lead),
      );
      reportApplyOutcome(outcome, family, app);
    } catch (e) {
      toast.error(t("toast.couldntApplyIn", { app: appName }), String(e));
    }
  },

  /**
   * 把某个「字重」单独应用到目标软件。
   * 一个字体族里每个字重都是独立的 PostScript 名（如 SourceHanSansSC-Bold），
   * 以前只能整族套用，想给选中文字单独换粗体做不到。
   */
  applyFaceInApp: async (family, faceId, app) => {
    const appName = t(`adobe.${app}`);
    const fam = familiesFor(get().fonts, get().tags).get(family);
    const face = fam?.faces.find((f) => f.id === faceId);
    if (!fam || !face) return;
    const label = `${family} ${face.style}`.trim();
    if (!face.postscriptName) {
      toast.error(t("toast.noPostScriptName"), t("toast.noPostScriptNameSub", { app: appName }));
      return;
    }
    // 字重里没有汉字时先提醒（仍然会应用，只是让用户知道中文不会变）
    await warnIfNoCjk(face, label);

    if (!fam.active) {
      if (!fam.deactivatable) return;
      await get().activateFamilySession(family);
      if (!familiesFor(get().fonts, get().tags).get(family)?.active) return;
      await new Promise((r) => setTimeout(r, 600));
    }
    try {
      const outcome = await ipc.applyFontInApp(
        app,
        face.postscriptName,
        label,
        family,
        localizedAliases(face),
      );
      reportApplyOutcome(outcome, label, app);
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

  installOnlineFamily: async (id, scope) => {
    if (get().onlineDownloading) return;
    // 只补版权文件时一个字体都不下；没传 scope 就是整套重下
    const files = scope ? scope.files : null;
    const wantLicense = scope ? scope.license : true;
    if (files !== null && files.length === 0 && !wantLicense) return;
    set({ onlineDownloading: id, onlineProgress: null });
    try {
      const res = await ipc.onlineDownload(id, files, wantLicense);
      // 安装到 <库目录>/在线栏目/<来源>/<家族（版权后缀）>/，含许可证文件
      const dupKeyOf = (f: { postscriptName: string | null; family: string; style: string }) =>
        f.postscriptName ?? `${f.family} ${f.style}`;
      const existing = get().fonts.map(dupKeyOf);
      // 字库里已有的同名字族：许可证也补一份进去（补齐缺失的版权文件）
      const familyKey = res.family.toLowerCase();
      const familyFaces = get().fonts.filter(
        (f) => f.family.toLowerCase() === familyKey && f.source !== "system",
      );
      const licenseDirs = [
        ...new Set(familyFaces.map((f) => parentDir(f.path)).filter((d) => d.length > 0)),
      ];
      const familyExisted = familyFaces.length > 0;
      const result = await ipc.installOnline(
        res.paths,
        existing,
        res.family,
        res.licensePath,
        res.source,
        licenseDirs,
      );
      if (result.installed.length > 0) {
        set({ fonts: [...get().fonts, ...result.installed], lastImported: [res.family] });
        persistPrefs(get);
        toast.success(t("toast.installedOne", { name: res.family }), undefined, "install");
      }
      for (const err of result.errors) toast.error(t("toast.installFailed"), err);
      if (
        result.installed.length === 0 &&
        familyExisted &&
        result.errors.length === 0
      ) {
        // 字体本来就有，这次只把版权文件补了进去
        toast.success(t("toast.licenseAdded"), t("toast.licenseAddedSub"), "install");
      } else if (result.duplicates.length > 0) {
        set({
          duplicateReport: { names: [...result.duplicates], at: Date.now() },
        });
      }
      const tags = get().tags[res.family] ?? [];
      if (!tags.includes("Online")) {
        await get().setFamilyTags(res.family, [...tags, "Online"]);
      }
      set({ onlineDetail: null, onlinePreviewPath: null });
    } catch (e) {
      toast.error(t("toast.onlineDownloadFailed"), String(e));
    } finally {
      set({ onlineDownloading: null, onlineProgress: null });
    }
  },

  reinstallOnlineFamily: async (id) => {
    const detail = get().onlineDetail;
    if (!detail || get().onlineDownloading) return;
    const family = detail.family;
    const sameFamily = (f: { family: string; source: string }) =>
      f.family.toLowerCase() === family.toLowerCase() && f.source !== "system";
    const faces = get().fonts.filter(sameFamily);
    if (faces.length === 0) {
      // 字库里本来就没有（或是系统字体），直接下载即可
      await get().installOnlineFamily(id, { files: null, license: true });
      return;
    }
    // 保留标签/收藏/合集：删除时不清元数据，重新入库后仍然有效
    await get().uninstallFamily(family, { silent: true, keepMeta: true });
    const leftovers = get().fonts.filter(sameFamily);
    if (leftovers.length > 0) {
      toast.error(t("toast.redownloadFailed"), t("toast.cantUninstallSystemSub"));
      return;
    }

    // 重下是「整套重来」，不受补全逻辑影响
    await get().installOnlineFamily(id, { files: null, license: true });
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
  setQuickbar: async (on) => {
    // 两个方向的切换都是「多段异步改几何 + 换界面」：形变 → 藏窗口 → 换装 → 摆几何 →
    // 再显示出来，全程好几百毫秒。原来只靠「on 和当前状态不等就开跑」来挡重复调用，
    // 但状态是在流程中段才翻的（进速览在形变前翻、退速览在显示前翻），
    // 于是「连着点两下 / 快捷键连按」就能让两套流程同时跑：
    // 一套收窗口、一套摆几何，最后窗口停在半截尺寸，看起来就是「界面展开了但显示不对」。
    // 现在串行化：同一时刻只有一个流程在跑，期间的新请求只记「最终想去哪」，跑完再补。
    quickbarWant = on;
    if (quickbarBusy) return;
    quickbarBusy = true;
    try {
      while (quickbarWant !== null && quickbarWant !== get().quickbar) {
        const target = quickbarWant;
        quickbarWant = null;
        if (target) await enterQuickbar();
        else await exitQuickbar();
      }
    } catch (e) {
      toast.error(t("toast.quickbarFailed"), String(e));
    } finally {
      quickbarBusy = false;
      quickbarWant = null;
    }
  },
  setQuickbarAutoHide: (quickbarAutoHide) => set({ quickbarAutoHide }),
  setQuickbarHotkey: async (quickbarHotkey) => {
    set({ quickbarHotkey });
    persistPrefs(get);
    try {
      await ipc.setQuickbarHotkey(quickbarHotkey);
    } catch (e) {
      // 原生注册失败（被别人占用）也要让用户知道，否则「按了没反应」无从排查
      toast.error(t("toast.hotkeyFailed"), String(e));
    }
  },
  setQuickbarHotkeyOpens: (quickbarHotkeyOpens) => {
    set({ quickbarHotkeyOpens });
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
  toggleLicenseFilter: (c) => {
    const cur = get().licenseFilter;
    set({ licenseFilter: cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c] });
  },
  setCopyrightStatus: (family, status) => {
    const next = { ...get().copyrightStatus };
    if (!status || status === "auto") {
      delete next[family];
    } else {
      next[family] = status;
    }
    set({ copyrightStatus: next });
    persistPrefs(get);
    // 同步到字体库里的字族目录：目录名后缀（"Lora（免费字体）"）跟着一起改。
    // 目录改了名，字体路径也变了，所以要重扫一次让列表对上号。
    void ipc
      .syncFamilyCopyright(family, status || "auto")
      .then((res) => {
        if (res.renamed > 0) {
          scheduleCopyrightRescan(get);
          toast.success(t("toast.copyrightRenamed", { count: String(res.renamed) }));
        }
        // 目录没改成：以前只写日志，用户只觉得「字体不见了」，现在直接说清楚
        if (res.errors.length > 0) {
          toast.error(t("toast.copyrightFailed"), `${res.errors[0]}\n${t("toast.copyrightFailedSub")}`);
        }
        if (res.reactivateFailed.length > 0) {
          const list = res.reactivateFailed
            .slice(0, 3)
            .map((p) => p.split(/[\\/]/).pop() ?? p)
            .join("、");
          toast.error(
            t("toast.copyrightFailed"),
            t("toast.copyrightReactivateSub", { list }),
          );
        }
      })
      .catch((e) => {
        console.warn("[copyright] 同步字族目录失败", e);
        toast.error(t("toast.copyrightFailed"), String(e));
      });
  },
  setCopyrightExpiry: (family, date) => {
    const next = { ...get().copyrightExpiry };
    if (!date) {
      delete next[family];
    } else {
      next[family] = date;
    }
    set({ copyrightExpiry: next });
    persistPrefs(get);
  },
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
        license: null,
        copyright: null,
        dirCopyrightClass: null,
        addedAt: 0,
      };
      map.set(f.family, fam);
    }
    fam.faces.push(f);
    if (!fam.formats.includes(f.format)) fam.formats.push(f.format);
    fam.isVariable ||= f.isVariable;
    fam.foundry ??= f.foundry;
    fam.license ??= f.license;
    fam.copyright ??= f.copyright;
    fam.dirCopyrightClass ??= f.copyrightClass ?? null;
    fam.addedAt = Math.max(fam.addedAt, f.addedAt ?? 0);

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

/** 与完整界面列表一致的族排序（主视图与速览界面共用） */
export function sortFamilies(families: Family[], sort: SortMode): Family[] {
  const out = [...families];
  switch (sort) {
    case "styles":
      out.sort((a, b) => b.faces.length - a.faces.length || a.name.localeCompare(b.name));
      break;
    case "size":
      out.sort((a, b) => b.totalSize - a.totalSize || a.name.localeCompare(b.name));
      break;
    case "glyphs":
      out.sort((a, b) => b.glyphCount - a.glyphCount || a.name.localeCompare(b.name));
      break;
    case "added":
      out.sort((a, b) => b.addedAt - a.addedAt || a.name.localeCompare(b.name));
      break;
    default:
      out.sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
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
  licenseFilter: string[];
  copyrightStatus: Record<string, string>;
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
  if (s.licenseFilter.length > 0) {
    out = out.filter((f) =>
      s.licenseFilter.includes(
        effectiveCopyrightClass(f.license, s.copyrightStatus[f.name], f.dirCopyrightClass),
      ),
    );
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
    // 条目是可移植标识，需先解析成当前机器上的字体路径
    const members = entryPaths(snap?.entries ?? [], buildFaceIndex(s.fonts));
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
        (s.notes[f.name]?.toLowerCase().includes(q) ?? false) ||
        (f.license?.toLowerCase().includes(q) ?? false) ||
        (f.copyright?.toLowerCase().includes(q) ?? false),
    );
  }
  return sortFamilies(out, s.sort);
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
