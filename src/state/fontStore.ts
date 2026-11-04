import { create } from "zustand";
import { formatBytes, setUnpreviewableHook } from "../lib/fontLoader";
import { pickRemovedFamilyNames, withoutFamilies } from "../lib/containerRemove";

/** 快照数量上限（与后端 MAX_SNAPSHOTS 一致）：超过就拒绝，不再悄悄淘汰最旧的 */
export const SNAPSHOT_LIMIT = 5;

/** 与后端 parser::UNPREVIEWABLE_REASON 保持一致（用前缀判断，别改一半） */
export const UNPREVIEWABLE_REASON = "软件里无法预览（字体格式不受支持）";
import { listen } from "@tauri-apps/api/event";
import {
  adoptQuickbarDock,
  DOCK_HEIGHT_HINT,
  OFFSCREEN_PAD,
  restoreQuickbarDock,
  RETRACT_IN_MS,
  RETRACT_OUT_MS,
} from "../lib/useQuickbarDock";
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
  type PendingBatch,
  type PackProgress,
  type ScanProgress,
  type Snapshot,
  type SnapshotEntry,
  type TrashEntry,
} from "../lib/ipc";
import { normalizeFaces } from "../lib/ipc";
import { matchAffinityFonts, type AffinityEvent } from "../lib/affinity";
import {
  familyActivation,
  familyClassification,
  pathsToToggle,
} from "../lib/familyState";
import { DEFAULT_HOTKEY, normalizeHotkey, type HotkeySpec } from "../lib/hotkey";
import { cjkKnown } from "../lib/cjk";
import { familyCopyrightClass } from "../lib/license";
import {
  APPLY_CHUNK,
  dropRedundantCopies,
  planBatches,
  reverseBatches,
  runBatches,
  trashItems,
  type ApplyBatch,
} from "../lib/applyPlan";
import { contextMenuSize } from "../lib/menuMetrics";
import { parentDir } from "../lib/onlineCoverage";
import {
  curationFile,
  isPackPath,
  mergeCuration,
  parseCuration,
  type CurationData,
} from "../lib/libraryData";
import {
  buildFaceIndex,
  buildFaceIndexCached,
  entryFromFace,
  entryPaths,
  entryFaceIds,
  faceKey,
  migrateEntry,
  missingEntries,
  systemBackedEntries,
} from "../lib/snapshotKey";
import { toast } from "../design/primitives/Toast";
import { setSoundLevel, type SoundLevel } from "../lib/sound";
import { applyTheme, type ThemePref } from "../lib/theme";
import {
  activeLocale,
  getLocalePref,
  hydrateLocalePref,
  isLocalePref,
  setLocalePref as applyLocalePref,
  t,
  type LocalePref,
  type TKey,
} from "../lib/i18n";
import { familyMatches, searchTokens, type LabelMaps } from "../lib/familySearch";

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
  /**
   * 同一个字面在本机出现两份时（系统目录一份 + 字体库里一份，PostScript 名相同）
   * 只留一条，用于**展示**：详情面板「每种样式」和卡片上的「N 种样式」。
   *
   * 不直接对 `faces` 去重是因为启停、部分启用判定都按文件走，两份文件都得留着。
   * 优先保留可启停的那一份（库内副本），这样点样式能真的动到它。
   */
  uniqueFaces?: FontFace[];
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
  /**
   * 这个字族里有损坏 / 不完整的字面（解析失败、缺 name 表、0 字形、缺 cmap…）。
   * 只对字库 / 用户字体有意义，系统字体不标记。
   */
  incomplete: boolean;
  /** 第一个不完整字面的原因，用于详情面板说明 */
  incompleteReason: string | null;
  /**
   * 坏字面的个数与是否全坏。
   *
   * 判定是**字面级**的：一个 5 字重的字族坏了 1 个，另外 4 个照常可用。
   * 所以「坏」和「整个字族不可用」必须分开说：
   *   brokenFaces > 0 && !brokenAll → 部分字重损坏（字族仍然能用）
   *   brokenAll                     → 整个字族不可用，会被归到「非完整字体」目录
   */
  brokenFaces: number;
  brokenAll: boolean;
}

interface FontStore {
  phase: "scanning" | "ready" | "error";
  scanProgress: ScanProgress;
  /**
   * 整包（`.ZFontManager`）打包/解包进度。
   *
   * 和 `scanProgress` 分开存：那个是「读字库」，这个是「自己写/解 6GB 的包」，
   * 两者可能同时进行（导入完会 rescan），混一个槽位就会互相覆盖。
   * null = 当前没有打包/解包任务。
   */
  packProgress: PackProgress | null;
  /**
   * 应用快照（启用/停用一大批字体）的进度。
   *
   * 为什么需要它：切换快照要动上千个字面，Windows 上 `AddFontResourceW` 在字体表
   * 很大时单次就要 0.4 秒左右，整批要几分钟。以前是一个 IPC 调用把上千个一起丢给
   * 后端、整批持锁，界面在这几分钟里完全不响应 —— 用户看到的就是「点一下就卡死」。
   * 现在前端分批调用、每批之间让出事件循环，并把这个进度摆到底部，用户能看到
   * 「正在应用 320 / 1349」，不会以为程序死了。
   */
  applyProgress: { done: number; total: number; undo?: boolean } | null;
  /** 是否有一次快照应用正在跑（含撤销）：用于互斥，避免两次操作抢同一个进度条 */
  applyBusy: boolean;
  /**
   * 「刚才那次应用被取消了」的常驻提示。
   *
   * 为什么不用 toast：取消往往发生在一个几分钟的操作之后，用户的眼睛在字体列表上，
   * 6 秒就消失的提示根本来不及点；而且 toast 只是个浮层，撤销这种「要改系统状态」
   * 的动作需要一个看得见、点得到、不会自己跑掉的落点。
   */
  applyNotice: { done: number; total: number } | null;
  /** 撤销「被取消的那次应用」已经做过的部分 */
  undoLastApply: () => void;
  dismissApplyNotice: () => void;
  /** 快照应用过程中用户点了「取消」 */
  applyCancelled: boolean;
  /** 请求取消正在进行的快照应用 */
  cancelApply: () => void;
  /**
   * 扫描途中陆续到达的字体（原生侧每解析一批就推过来）。
   * 只用于「边读边显示」，扫描结束会被权威结果整体覆盖。
   */
  scanFonts: FontFace[];
  fonts: FontFace[];
  tags: Record<string, string[]>;
  collections: Record<string, string[]>;
  /**
   * 分组里的**字重级**成员（0.9.9-13）：分组名 → `faceKey` 列表。
   *
   * 分组本身按字族记（`collections`），但用户会想「只把这一族的某个字重放进去」。
   * 取并集：字族在 `collections` 里、或它的某个字面在 `collectionFaces` 里，这个字族就属于该分组。
   * 存在 prefs（`prefs.collectionFaces`）里，不动 state.json 的结构。
   */
  collectionFaces: Record<string, string[]>;
  favorites: string[];
  sessionActivated: string[];
  lastImported: string[];
  notes: Record<string, string>;
  trash: TrashEntry[];
  snapshots: Snapshot[];
  panelWidth: number;

  selection: string[];

  /**
   * Shift+方向键连续选取时的锚点（第一次扩展前选中的那个字族）。
   *
   * 没有它就只能做并集 —— 按 Shift+↑ 往回缩时区间其实变小了，但并集永远不减，
   * 表现就是「只能越选越多，缩不回去」（0.9.9-1 实测确认）。有锚点才能把
   * 每次 Shift+方向解释成「从锚点到当前项的区间」并整体替换。
   */
  rangeAnchor: string | null;

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
  /** 只看损坏 / 不完整的字族（解析失败、缺 name 表、0 字形、缺 cmap） */
  incompleteOnly: boolean;
  /** 版权筛选（free/paid/timelimited/unknown），空 = 全部 */
  licenseFilter: string[];
  /** 速览界面「范围」筛选：只看收藏的字族 */
  favoriteOnly: boolean;
  /** 速览界面「范围」筛选：只看属于这些分组的字族（空 = 不限） */
  collectionFilter: string[];
  /** 速览界面「范围」筛选：只看属于这些快照的字族（按快照名，空 = 不限） */
  snapshotFilter: string[];
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
  /** 从字重菜单「新建分组…」进来的那个字重（faceKey）：建组时只放它，不放整族 */
  pendingCollectionFace: string | null;

  pendingSnapshotFor: string | null;
  /** 从字重菜单「新建快照…」进来的那个字重（faceKey）：建快照时只放它，不放整族 */
  pendingSnapshotFace: string | null;

  duplicateReport: { names: string[]; at: number } | null;

  /** 待确认的批量「移到回收站」清单（C9）：非 null 时前端弹确认框 */
  trashConfirm: string[] | null;

  /**
   * DEF-1/DEF-2：待确认的「删除非空分组 / 清空快照」，非 null 时弹确认框。
   * `count` 在发起时就算好（分组成员 = 整族 + 字重两级），对话框不再自己算。
   */
  pendingDestructive: { kind: "collection" | "snapshot"; name: string; count: number } | null;

  /** E2：上次没跑完的批量断点（启动时从 state.pending_batch 读入），非 null 时弹「继续吗」 */
  pendingResume: PendingBatch | null;

  init: () => Promise<void>;
  rescan: () => Promise<void>;
  restoreLastActivation: () => Promise<void>;
  setFamilyActive: (family: string, active: boolean) => Promise<void>;
  activateFamilySession: (family: string) => Promise<void>;
  setFontFileActive: (path: string, active: boolean) => Promise<void>;
  /**
   * 单独启用 / 停用某个字重（`faceId` = `FontFace.id`）。
   *
   * 启停真源是**文件级**（`state.deactivated` 按路径记，GDI 也是按文件注册的），
   * 所以这里先把「用户点的这一行」翻译成能动的那个文件：
   * 详情面板里展示的可能是系统那一份（`uniqueFaces` 系统优先），真正能动的是同 PS 名的库内副本。
   */
  setFaceActive: (faceId: string, active: boolean) => Promise<void>;
  uninstallFontFile: (path: string) => Promise<void>;
  installPaths: (paths: string[], mode: InstallMode) => Promise<void>;
  uninstallFamily: (family: string, opts?: { silent?: boolean; keepMeta?: boolean }) => Promise<void>;
  /** 批量移到回收站：一次 IPC、一次落盘、一次状态更新（C8） */
  uninstallFamilies: (
    families: string[],
    opts?: { silent?: boolean; keepMeta?: boolean },
  ) => Promise<void>;
  /** 「移到回收站」的统一入口：少量直接删，超过 `TRASH_CONFIRM_THRESHOLD` 先弹确认（C9） */
  requestTrash: (families: string[]) => void;
  confirmTrash: () => Promise<void>;
  cancelTrash: () => void;
  restoreTrash: (entryId: string) => Promise<void>;
  deleteTrashEntry: (entryId: string) => Promise<void>;
  emptyTrash: () => Promise<void>;
  setFamilyTags: (family: string, tags: string[]) => Promise<void>;
  removeTagEverywhere: (tag: string) => Promise<void>;
  createCollection: (name: string) => Promise<void>;
  deleteCollection: (name: string) => Promise<void>;
  /**
   * DEF-1：删除分组的统一入口。空组直接删；非空先弹确认框——
   * 测试文档 §3.7 要求「组内 N 个字体如何处理」必须有明确提示。
   * 分组关系（元数据）的丢失不可撤销，字体本身不受影响，对话框里要说清。
   */
  requestDeleteCollection: (name: string) => void;
  renameCollection: (from: string, to: string) => Promise<void>;
  toggleFamilyInCollection: (collection: string, family: string) => Promise<void>;
  /** 批量把字族移出分组（只删成员关系，不删字体）。一条都没命中时静默返回。 */
  removeFamiliesFromCollection: (collection: string, families: string[]) => Promise<void>;
  createSnapshot: (name: string) => Promise<void>;
  /**
   * 把某个分组的字体一次性收进一个**同名新快照**（2026-11-04 用户需求）。
   * 「分组里的字体」按分组视图的口径算，见实现处注释。
   */
  createSnapshotFromCollection: (collection: string) => Promise<void>;
  deleteSnapshot: (name: string) => Promise<void>;
  renameSnapshot: (from: string, to: string) => Promise<void>;
  toggleFamilyInSnapshot: (snapshot: string, family: string) => Promise<void>;
  /** 单独把某个字重加入 / 移出快照（不改同族其它字重） */
  toggleFaceInSnapshot: (snapshot: string, faceId: string) => Promise<void>;
  /** 单独把某个字重加入 / 移出分组（不改同族其它字重） */
  toggleFaceInCollection: (collection: string, faceId: string) => Promise<void>;
  /** 批量把字族移出快照（按 entry.family 删，不依赖字体是否还在库里） */
  removeFamiliesFromSnapshot: (snapshot: string, families: string[]) => Promise<void>;
  addActiveToSnapshot: (snapshot: string) => Promise<void>;
  /** 应用快照：switch = 关掉其他字体只留快照内的；merge = 在当前启用基础上叠加快照内的字体 */
  applySnapshot: (name: string, mode: SnapshotApplyMode) => Promise<void>;
  removeMissingFromSnapshot: (name: string) => Promise<void>;
  /** 清空快照内所有字体（快照本身保留） */
  clearSnapshot: (name: string) => Promise<void>;
  /**
   * DEF-2：清空快照的统一入口。空快照无事可做（静默返回，同 clearSnapshot）；
   * 非空先弹确认框——测试文档 §4.8 要求确认框存在。
   */
  requestClearSnapshot: (name: string) => void;
  /** DEF-1/DEF-2：确认框的「删除 / 清除」，按 pendingDestructive 分发 */
  confirmPendingDestructive: () => Promise<void>;
  cancelPendingDestructive: () => void;
  exportSnapshot: (name: string, dest: string) => Promise<void>;
  /** mode: none = 仅导入；switch = 导入并切换；merge = 导入并合并到当前启用 */
  importSnapshots: (src: string, mode?: SnapshotApplyMode | "none") => Promise<void>;
  toggleFavorite: (family: string) => Promise<void>;
  setFamilyNote: (family: string, note: string) => Promise<void>;
  setFamiliesActiveBulk: (families: string[], active: boolean) => Promise<void>;
  /** E2：续做上次没跑完的批量（ResumeBatchDialog 确认后调用，走 setFamiliesActiveBulk 同一条路） */
  resumePendingBatch: (cp: PendingBatch) => Promise<void>;
  /** E2：放弃续做（清除断点，剩余清单作废） */
  dismissPendingResume: () => void;
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
  setIncompleteOnly: (on: boolean) => void;
  /** 标记/撤销一个字面的「无法预览」。只写自己这一类，不覆盖更严重的损坏原因 */
  setFaceIncomplete: (id: string, reason: string | null) => void;
  toggleLicenseFilter: (c: string) => void;
  setFavoriteOnly: (v: boolean) => void;
  toggleCollectionFilter: (name: string) => void;
  toggleSnapshotFilter: (id: string) => void;
  /** status 为 null / "auto" 时恢复为按版权信息自动识别 */
  setCopyrightStatus: (family: string, status: string | null) => void;
  /** date 为 null 时清除到期日期 */
  setCopyrightExpiry: (family: string, date: string | null) => void;
  exportLibraryData: (dest: string) => Promise<void>;
  importLibraryData: (src: string) => Promise<void>;
  /**
   * 打包「整理数据 + 字体文件」成 `.ZFontManager`（超 2GB 自动分卷）。
   * 放在阻塞线程池里跑，进度走 `pack:progress` 事件，界面只负责显示。
   */
  exportLibraryPack: (dest: string) => Promise<void>;
  /** 导入时自动分辨：`.ZFontManager` 走解包，`.json` 走整理数据 */
  importLibraryFile: (src: string) => Promise<void>;
  setNav: (n: Nav) => void;
  select: (family: string | null) => void;
}

/** 速览界面窗口尺寸（逻辑像素）：窄竖排面板，高度再翻一倍，靠滚动展示更多字体 */
const QUICKBAR_WIDTH = 400;
const QUICKBAR_HEIGHT = 992;
/**
 * 速览窗口相对显示器左沿的横向偏移（用户 2026-11-04 指定）。
 *
 * 基准：2048 宽的屏幕上距左沿 400 逻辑像素（≈ 屏宽的 19.5%）。**不同分辨率按屏宽等比换算**，
 * 保证「在屏幕上的相对位置」一致，而不是在 1366 上显得太靠右、在 4K 上显得太靠左：
 * - 2048 宽 → 400
 * - 1920 宽 → 375
 * - 1366 宽 → 267
 * - 3840 宽 → 750
 * 只设下限 160（小屏别贴死左沿）；上界由 maxX（屏宽 - 窗口宽）兜底，不会跑出屏幕。
 * 这里用的是**逻辑像素**：Windows 的 125% / 150% / 200% 缩放由 scale 换算成物理像素。
 */
const QUICKBAR_DOCK_OFFSET_BASE = 400;
const QUICKBAR_DOCK_OFFSET_BASE_WIDTH = 2048;
const QUICKBAR_DOCK_OFFSET_MIN = 160;

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
/**
 * 当前这一轮切换的 Promise。busy 时进来的调用等它，而不是立刻 resolve——
 * 否则 `await setQuickbar(x)` 之后读到的还是旧状态（`app://activate` 就踩这个）。
 */
let quickbarChain: Promise<void> = Promise.resolve();
/** 正在进行的那一次扫描（single-flight：并发扫描会让旧结果覆盖新结果） */
let scanInflight: Promise<void> | null = null;
/** 设置写盘串行链：后端 set_settings 是整包覆盖，并发写的落盘顺序不保证（§5 第 12 条） */
let settingsSaveChain: Promise<void> = Promise.resolve();
/**
 * 在线详情的代次。关闭详情 / 切到别的字族时递增，让还在飞的
 * `onlineFamily` / `onlinePreview` 回来时认出自己已经过期，不再写回。
 */
let onlineDetailGen = 0;

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
    // 进入速览 = 直接收到屏幕顶部的一条：一次形变到位，不再「先变成完整速览面板」。
    // 但用户把「贴顶自动隐藏」关掉时不要收：那种配置下窗口应该直接停在完整尺寸，
    // 否则会收成 34px 提示条、热键又被关掉，等于进来就出不去（§5 第 1 条）。
    const autoHide = useFontStore.getState().quickbarAutoHide;
    const dockHeight = autoHide ? Math.round(DOCK_HEIGHT_HINT * scale) : fullHeight;
    /*
     * 速览落点（用户 2026-11-04 五次修正后的最终口径）：**距显示器左上角 (400, 0)**，
     * 且要适配不同分辨率。
     * - 纵向固定贴显示器物理顶部 0px：用 `monitor.position.y` 而不是工作区顶，
     *   否则「任务栏置顶」时会退到任务栏下沿，贴不到真正的 0；
     * - 横向在显示器左沿基础上右移，偏移量按屏宽等比换算（2048 宽 → 400），
     *   夹在 160~400 之间；基准取 workArea 左沿，侧边任务栏时不会被压住。
     */
    const area = monitor?.workArea ?? monitor;
    const baseX = area ? area.position.x : 0;
    const areaLogicalWidth = area ? area.size.width / scale : QUICKBAR_DOCK_OFFSET_BASE_WIDTH;
    const offsetLogical = Math.max(
      QUICKBAR_DOCK_OFFSET_MIN,
      (areaLogicalWidth * QUICKBAR_DOCK_OFFSET_BASE) / QUICKBAR_DOCK_OFFSET_BASE_WIDTH,
    );
    const wantX = Math.round(baseX + offsetLogical * scale);
    // 兜底：偏移 + 窗口宽度可能超出屏宽（小屏 / 侧边任务栏），别把速览推到屏幕外
    const maxX = area ? Math.round(baseX + area.size.width - width) : wantX;
    const dockX = Math.max(baseX, Math.min(wantX, maxX));
    const dockY = Math.round(monitor ? monitor.position.y : 0);

    // 收起成一条后远小于「放得下右键菜单」的最小尺寸，先解除；展开时再补回来
    await win.setMinSize(null);

    /*
     * 切换动画 = 速览收起时那一套「整块滑出屏幕 → 屏幕外换装 → 从外面落回」。
     *
     * 原来是「窗口原地缩小到顶部一条」：完整界面的顶栏、搜索框会被越缩越小的窗口
     * 现场重排，用户看到的是内容被挤扁再跳变。换成滑出之后，窗口全程保持主界面尺寸，
     * 内容只是「移出视口」，不重排也不裁剪；换装发生在屏幕外，任何跳变都看不见。
     *
     * 两段的时长与曲线和「收起成细线」完全一致（180ms 出 / 160ms 回），观感统一。
     */
    const ms = morphDuration();
    // 屏幕外的停留位置：整块挪到**显示器**上沿之外（用 monitor.position.y，
    // 任务栏置顶时工作区顶不在 0，按工作区算会停在屏幕里、露出半截）
    const offY = (monitor ? monitor.position.y : 0) - size.height - OFFSCREEN_PAD;

    if (ms > 0) {
      // 1) 主界面整块向上滑出（尺寸不变）
      await morphWindow(
        { x: pos.x, y: pos.y, width: size.width, height: size.height },
        { x: pos.x, y: offY, width: size.width, height: size.height },
        RETRACT_OUT_MS,
      );
    }

    // 2) 屏幕外换装：切界面 + 换成速览尺寸 + 挪到目标位置的正上方
    useFontStore.setState({
      quickbar: true,
      morph: ms > 0 ? { width: targetWidth, height: targetHeight } : null,
    });
    await win.setSize(new PhysicalSize(width, dockHeight)).catch(() => {});
    await win.setPosition(new PhysicalPosition(dockX, offY)).catch(() => {});

    if (ms > 0) {
      // 3) 从屏幕外落回显示器顶部
      await morphWindow(
        { x: dockX, y: offY, width, height: dockHeight },
        { x: dockX, y: dockY, width, height: dockHeight },
        RETRACT_IN_MS,
      );
    }

    // 形变是逐帧动画，窗口被别的程序挡住 / 刚被隐藏过时，个别帧的 setSize/setPosition
    // 会被系统吞掉，最后停在「半路」的几何上：宽度已经是速览的、位置还留在主界面。
    // 所以动画结束后显式落一次终态，保证 dock 状态机接管时的窗口真的贴着左上角。
    await win.setSize(new PhysicalSize(width, dockHeight)).catch(() => {});
    await win.setPosition(new PhysicalPosition(dockX, dockY)).catch(() => {});
    // 窗口已经是顶部一条：把收起态交给 dock，展开时还原成完整的速览尺寸
    // 窗口已经到目标几何：autoHide 开着时窗口是顶部一条，把收起态交给 dock；
    // 关着时窗口本来就是展开尺寸，没有收起态可接管（接管了会立刻被 scheduleShrink 压成细线）。
    if (autoHide) {
      await adoptQuickbarDock(width, fullHeight).catch((e) =>
        console.warn("[quickbar] 接管收起态失败", e),
      );
    }
    // 速览界面置顶在所有窗口之上，回到完整界面时再取消
    await win.setAlwaysOnTop(true);
  } catch (e) {
    // 窗口几何调不动也要让界面切过去（顶多是全尺寸的速览），不能整个功能失效
    console.warn("[quickbar] 调整窗口几何失败，仅切换界面", e);
    useFontStore.setState({ quickbar: true });
    /*
     * 兜底落位：新动画的第一段会把**整个主窗口**推到工作区上沿之外，
     * 万一第二段落回失败（系统吞掉 setPosition / monitor 信息拿不到），
     * 窗口就停在屏幕外 —— 用户看到的是「点了速览，软件消失了」。
     * 这里必须把它拽回可见区域，宁可位置不完美也不能让窗口没了。
     */
    try {
      const m = await currentMonitor();
      const a = m?.workArea ?? m;
      const s = await win.scaleFactor();
      await win.setSize(
        new PhysicalSize(Math.round(QUICKBAR_WIDTH * s), Math.round(DOCK_HEIGHT_HINT * s)),
      );
      await win.setPosition(
        new PhysicalPosition(
          Math.round(a?.position?.x ?? 80),
          Math.round(a?.position?.y ?? 80),
        ),
      );
    } catch {
      /* 连兜底都失败就只能靠用户重新点热键 */
    }
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
      collectionFaces: s.collectionFaces,
    });
  }, 600);
}

/** 整理数据的导出内容：单独导 json 与整包内嵌**共用这一份**，格式必须完全一致 */
function curationPayload(s: FontStore, now: Date) {
  return curationFile(
    {
      tags: s.tags,
      collections: s.collections,
      collectionFaces: s.collectionFaces,
      favorites: s.favorites,
      notes: s.notes,
      copyrightStatus: s.copyrightStatus,
      copyrightExpiry: s.copyrightExpiry,
    },
    now.toISOString(),
  );
}

/**
 * 把导入的整理数据按「只增不减 / 本地优先」合并进当前状态。
 *
 * 单独导 json 与解整包都走这里 —— 两套导入逻辑一旦分家，规则迟早跑偏
 * （比如一边给标签做并集、另一边直接覆盖）。返回真正补进去的条目数。
 */
async function applyCurationMerge(
  get: () => FontStore,
  set: (partial: Partial<FontStore>) => void,
  data: CurationData,
): Promise<number> {
  const s = get();
  const local: CurationData = {
    tags: s.tags,
    collections: s.collections,
    collectionFaces: s.collectionFaces,
    favorites: s.favorites,
    notes: s.notes,
    copyrightStatus: s.copyrightStatus,
    copyrightExpiry: s.copyrightExpiry,
  };
  const merged = mergeCuration(local, data);
  if (merged.touched === 0) return 0;
  // 标签 / 备注走后端逐条命令（它们各自有落盘与联动），分组 / 收藏 / 版权走 prefs
  for (const family of Object.keys(merged.addedTags)) {
    await get().setFamilyTags(family, merged.tags[family] ?? []);
  }
  for (const [name, members] of Object.entries(merged.changedCollections)) {
    await ipc.setCollection(name, merged.collections[name] ?? members);
  }
  for (const family of merged.addedFavorites) {
    await ipc.setFavorite(family, true);
  }
  for (const [family, note] of Object.entries(merged.addedNotes)) {
    await get().setFamilyNote(family, note);
  }
  set({
    tags: merged.tags,
    collections: merged.collections,
    collectionFaces: merged.collectionFaces,
    favorites: merged.favorites,
    notes: merged.notes,
    copyrightStatus: merged.copyrightStatus,
    copyrightExpiry: merged.copyrightExpiry,
  });
  persistPrefs(get);
  return merged.touched;
}

function emptyPackProgress(kind: "export" | "import"): PackProgress {
  return {
    kind,
    phase: kind,
    done: 0,
    total: 0,
    part: 1,
    parts: 1,
    bytes: 0,
    current: "",
  };
}

/** 收尾时让 100% 多停 0.9 秒再收起，否则用户最后一眼看到的是 97%，以为没做完 */
function clearPackProgressSoon(
  set: (partial: Partial<FontStore>) => void,
  get: () => FontStore,
  kind: "export" | "import",
) {
  setTimeout(() => {
    if (get().packProgress?.kind === kind) set({ packProgress: null });
  }, 900);
}

/** 被取消那次应用里「已经跑完的批次」，供底部那条常驻提示的「撤销」使用 */
let undoPending: ApplyBatch[] = [];

/**
 * 把「已经真正执行过的批次」就地写回前端的 active 标记。
 *
 * 以前这里走的是整库 `rescan()`：批次只改了「启用/停用」这一个字段，却要重新读 4203 个
 * 字体文件（约 6 秒），侧栏计数会当着用户的面清零再跳回来 —— 用户看到的就是
 * 「点了取消，怎么又开始读字体库了」。`restoreLastActivation` 早就用了同样的就地更新法。
 */
/**
 * E2：批量启停期间的「关窗 = 后台继续」标志。
 * runBatches 的所有调用点（含撤销）开头/结尾都要挂——撤销 4000 族同样要十几分钟。
 * IPC 失败只影响「关窗后台继续」这一个能力，绝不能反过来挡住批量本身。
 */
async function batchRunBegin(): Promise<void> {
  try {
    await ipc.setBatchRunning(true);
  } catch {
    /* ignore */
  }
}
async function batchRunEnd(): Promise<void> {
  try {
    await ipc.setBatchRunning(false);
  } catch {
    /* ignore */
  }
}

/**
 * E2：批量启停断点的节流写入。
 * 一次落盘 2.4MB，不能每批（10 字面/4 秒）都写——30 秒一次，40 分钟的任务
 * 最多写 ~80 次 ≈ 190MB，可接受；进程意外退出最多丢最后 30 秒的进度。
 */
const CHECKPOINT_MIN_INTERVAL_MS = 30_000;
let lastCheckpointAt = 0;
function resetCheckpointThrottle(): void {
  lastCheckpointAt = 0;
}
function writeBatchCheckpoint(
  flatPaths: string[],
  done: number,
  active: boolean,
): void {
  const now = Date.now();
  if (now - lastCheckpointAt < CHECKPOINT_MIN_INTERVAL_MS) return;
  lastCheckpointAt = now;
  void ipc
    .batchCheckpoint({
      remaining: flatPaths.slice(done),
      done,
      total: flatPaths.length,
      active,
    })
    .catch(() => {
      /* 断点写失败不致命：最坏情况重启后从头问 */
    });
}
/** 批量结束（done/cancelled/failed 三种出口都算）必须清除断点：剩下的清单已作废 */
function clearBatchCheckpoint(): void {
  void ipc.batchCheckpoint(null).catch(() => {});
}

function patchActiveLocally(batches: ApplyBatch[]): void {
  if (batches.length === 0) return;
  const want = new Map<string, boolean>();
  for (const b of batches) for (const p of b.paths) want.set(p, b.active);
  if (want.size === 0) return;
  const fonts = useFontStore.getState().fonts;
  useFontStore.setState({
    fonts: fonts.map((f) => {
      const v = want.get(f.path);
      return v === undefined || v === f.active ? f : { ...f, active: v };
    }),
  });
}

/**
 * 应用一组快照条目（applySnapshot 与导入后应用共用）。
 * 条目本身不含路径，先按可移植标识解析到本机字体，再执行启用/停用。
 * 系统安装的字体（system=true）只做记录与标注，无论何种模式都绝不会被停用。
 *
 * 分批、跳过存盘、三个出口（完成/取消/失败）补落盘这些约束都在 `lib/applyPlan.ts`，
 * 那里有单测；这里只负责「算要动哪些字体」和「把结果讲给用户」。
 */
let systemFontToastAt = 0;

/**
 * 「系统目录那份动不了」的提示，3 秒内只弹一次（C4）。
 *
 * 原来 4 处入口各弹一次：批量停用时每碰到一个系统字面就是一条，右上角能连排十几条，
 * 用户只能看着它们一条条消失。系统字体改不动是既定事实，说一次就够。
 */
function warnSystemFont(): void {
  const now = Date.now();
  if (now - systemFontToastAt < 3000) return;
  systemFontToastAt = now;
  toast.error(t("toast.cantUninstallSystem"), t("toast.cantUninstallSystemSub"));
}

/**
 * 超过多少个字族就弹「确认移到回收站」（C9）。
 *
 * 阈值取 50：日常整理一屏也就几十个族，弹窗会变成噪音；而全选这类误操作动辄几百上千，
 * 必须拦一下（2026-11-01 那次误点的是 4213 个）。
 */
export const TRASH_CONFIRM_THRESHOLD = 50;

async function applyEntries(
  entries: SnapshotEntry[],
  mode: SnapshotApplyMode,
  label: string,
): Promise<void> {
  const s = useFontStore.getState();
  // 互斥：两个入口（切换/合并、导入后应用）同时点会让两条批次流抢同一个进度条和取消标志
  if (s.applyBusy) return;
  const index = buildFaceIndex(s.fonts);
  const paths = entryPaths(entries, index);
  if (paths.length === 0) {
    // 以前这里静默返回：快照条目全都在本机找不到时，用户点了「切换」完全没反应
    toast.info(t("snap.nothingToApply"));
    return;
  }
  const facesByPath = new Map(s.fonts.map((f) => [f.path, f] as const));
  const snapshotSet = new Set(paths);
  const toDeactivate =
    mode === "switch"
      ? s.fonts
          .filter((f) => f.active && f.deactivatable && !snapshotSet.has(f.path))
          .map((f) => f.path)
      : [];
  const deactivating = new Set(toDeactivate);
  // 同一字面（同一 postscriptName）在系统目录和字体库里各有一份时，只启用一份就够了。
  // 这里先记下「本次不会被动到、仍然处于启用状态」的字面，再据此跳过重复副本。
  const activeKeys = new Set(
    s.fonts.filter((f) => f.active && !deactivating.has(f.path)).map((f) => faceKey(f)),
  );
  const candidates = paths.filter((p) => {
    const f = facesByPath.get(p);
    return !!f && f.deactivatable && !f.active;
  });
  const { keep: toActivate, skipped } = dropRedundantCopies(
    candidates,
    facesByPath,
    activeKeys,
    faceKey,
  );
  if (toActivate.length === 0 && toDeactivate.length === 0) {
    toast.success(t("snap.alreadyActive"));
    return;
  }
  const batches = planBatches(toDeactivate, toActivate);
  const total = toDeactivate.length + toActivate.length;
  /** 已经跑完的批次，取消后可以原路撤销 */
  const applied: ApplyBatch[] = [];
  undoPending = [];
  useFontStore.setState({
    applyBusy: true,
    applyProgress: { done: 0, total, undo: false },
    applyNotice: null,
    applyCancelled: false,
  });
  // E2：快照切换也可能跑几十分钟，跑批期间关窗后台继续（快照不接断点——已确认口径）
  await batchRunBegin();
  try {
    const outcome = await runBatches({
      batches,
      apply: async (batch, noSave) => {
        await ipc.setFontsActive(batch.paths, batch.active, noSave);
        applied.push(batch);
      },
      // 空列表 = 只落盘：中间批次都跳过了存盘，取消/失败时必须补这一次
      flush: () => ipc.setFontsActive([], true, false),
      onProgress: (done, total) =>
        useFontStore.setState({ applyProgress: { done, total, undo: false } }),
      isCancelled: () => useFontStore.getState().applyCancelled,
    });
    // 收掉进度条，再就把这次真正改过的字面就地标好 —— 不整库重扫
    useFontStore.setState({ applyProgress: null });
    patchActiveLocally(applied);
    if (outcome.status === "cancelled") {
      // 常驻一条底部提示，而不是 6 秒就消失的 toast：用户得来得及决定要不要撤销
      undoPending = applied;
      useFontStore.setState({
        applyNotice: { done: outcome.done, total },
        applyProgress: null,
      });
      return;
    }
    if (outcome.status === "failed") {
      toast.error(t("toast.couldntActivate"), String(outcome.error));
      return;
    }
    persistPrefs(useFontStore.getState);
    toast.success(
      mode === "switch"
        ? t("snap.switchDone", {
            count: toActivate.length,
            deactivated: toDeactivate.length,
            name: label,
          })
        : t("snap.mergeDone", { count: toActivate.length, name: label }),
      skipped > 0 ? t("snap.skippedCopies", { count: skipped }) : undefined,
      "activate",
    );
  } finally {
    // 中途失败也要把进度条收掉，否则它会永远挂在底部
    useFontStore.setState({ applyBusy: false, applyProgress: null });
    void batchRunEnd();
  }
}

/**
 * 撤销「取消掉的那次应用」已经做过的部分：批次倒序、动作取反。
 *
 * 为什么要它：取消只「停下」的话，系统里会停在一个谁也不认识的中途状态；
 * 用户点取消往往是因为「选错快照了」，那就应该能一键回到动手之前。
 */
async function undoAppliedBatches(applied: ApplyBatch[]): Promise<void> {
  const batches = reverseBatches(applied);
  if (batches.length === 0) return;
  const total = batches.reduce((n, b) => n + b.paths.length, 0);
  useFontStore.setState({
    applyBusy: true,
    applyCancelled: false,
    applyProgress: { done: 0, total, undo: true },
  });
  // E2：撤销大批量同样要十几分钟，关窗不能打断
  await batchRunBegin();
  try {
    const outcome = await runBatches({
      batches,
      apply: (batch, noSave) => ipc.setFontsActive(batch.paths, batch.active, noSave),
      flush: () => ipc.setFontsActive([], true, false),
      onProgress: (done, total) =>
        useFontStore.setState({ applyProgress: { done, total, undo: true } }),
    });
    if (outcome.status === "failed") {
      toast.error(t("toast.couldntActivate"), String(outcome.error));
    } else {
      toast.success(t("snap.undoDone"), undefined, "activate");
    }
  } finally {
    useFontStore.setState({ applyBusy: false, applyProgress: null });
    void batchRunEnd();
    // 撤销过的部分同样就地写回，避免又触发一次整库重扫
    patchActiveLocally(batches);
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
 * 扫描结果里带的「授权原文」→ 首次见到某个字族时写进备注（详情面板 → 备注）。
 *
 * 只摘原句、不改写；后端保证每个字族只自动写一次（用户改过不覆盖、删掉不复活）。
 * 没有任何渠道说明的字族不会写，备注保持空。
 */
async function seedLicenseNotes(
  fonts: FontFace[],
  notes: Record<string, string>,
): Promise<Record<string, string> | null> {
  const items = new Map<string, string>();
  for (const f of fonts) {
    const note = f.licenseNote?.trim();
    if (!note || notes[f.family] || items.has(f.family)) continue;
    items.set(f.family, note);
  }
  if (items.size === 0) return null;
  const payload = [...items].map(([family, note]) => ({ family, note }));
  const seeded = await ipc.seedLicenseNotes(payload).catch(() => [] as string[]);
  if (seeded.length === 0) return null;
  const next = { ...notes };
  for (const family of seeded) {
    const note = items.get(family);
    if (note) next[family] = note;
  }
  return next;
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
  packProgress: null,
  applyProgress: null,
  applyBusy: false,
  applyNotice: null,
  dismissApplyNotice: () => set({ applyNotice: null }),
  undoLastApply: () => {
    const pending = undoPending;
    if (!pending.length) {
      set({ applyNotice: null });
      return;
    }
    set({ applyNotice: null });
    void undoAppliedBatches(pending);
  },
  applyCancelled: false,
  cancelApply: () => set({ applyCancelled: true }),
  scanFonts: [],
  fonts: [],
  tags: {},
  collections: {},
  collectionFaces: {},
  snapshots: [],
  favorites: [],
  sessionActivated: [],
  lastImported: [],
  notes: {},
  trash: [],
  panelWidth: 348,
  selection: [],
  rangeAnchor: null,
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
  incompleteOnly: false,
  licenseFilter: [],
  favoriteOnly: false,
  collectionFilter: [],
  snapshotFilter: [],
  copyrightStatus: {},
  copyrightExpiry: {},
  nav: { kind: "library" },
  selectedFamily: null,
  pendingCollectionFor: null,
  pendingCollectionFace: null,
  pendingSnapshotFor: null,
  pendingSnapshotFace: null,
  duplicateReport: null,
  trashConfirm: null,
  pendingResume: null,
  pendingDestructive: null,

  init: async () => {
    if (initStarted) return;
    initStarted = true;
    await listen<ScanProgress>("scan:progress", (e) => {
      set({ scanProgress: e.payload });
    });
    // 打包 / 解包 .ZFontManager 的进度：清单一律走这一条事件，
    // 前端不做任何「估算」，done/total 由后端按文件数如实给。
    await listen<PackProgress>("pack:progress", (e) => {
      set({ packProgress: e.payload });
    });
    // 边扫边显示：原生侧每解析一批就推一批过来，界面立刻能铺卡片，
    // 不用等整库扫完（几千个字体要好几秒）才「啪」地一次性出现。
    //
    // 但不能来一批就 set 一次：每次 set 都会让 App 重算「可见字族」（6000 个字面排序 + 过滤），
    // 6170 个文件约 50 批，等于启动时白做 50 次全量计算 —— 用户感知就是「越用越慢、扫描像卡住」。
    // 这里把批次攒起来，每 150ms 合并刷新一次（≈6 次/秒），肉眼看仍是连续铺开。
    let pendingBatch: FontFace[] = [];
    let batchTimer: ReturnType<typeof setTimeout> | undefined;
    await listen<FontFace[]>("scan:batch", (e) => {
      pendingBatch = pendingBatch.concat(normalizeFaces(e.payload));
      if (batchTimer !== undefined) return;
      batchTimer = setTimeout(() => {
        batchTimer = undefined;
        if (pendingBatch.length === 0) return;
        const add = pendingBatch;
        pendingBatch = [];
        set({ scanFonts: get().scanFonts.concat(add) });
      }, 150);
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
        // 分组里的字重级成员（0.9.9-13）：只保留「分组名 → 字符串数组」这种形状
        collectionFaces: (() => {
          const raw = prefs.collectionFaces;
          if (!raw || typeof raw !== "object") return {};
          const out: Record<string, string[]> = {};
          for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
            if (!Array.isArray(v)) continue;
            const keys = v.filter((k): k is string => typeof k === "string");
            if (keys.length > 0) out[name] = keys;
          }
          return out;
        })(),
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
        // 扫描期间的文件事件直接忽略：这一次扫描刚把磁盘读了一遍，期间的变化
        // 已经包含在这份结果里（watcher 在扫描期间本来就会因为自身读取而触发）。
        // 之前改成"排队补扫"实测代价很大：每次启动白扫一整遍（十几秒）+ 假报
        // 「发现 N 个新字体」。要补扫的是用户主动改目录这类显式请求（走 rescan）。
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
    // E2/DEF-4：有未完成的批量断点时，「启动时恢复上次启用的字体」整体让位。
    //
    // 冲突实景（2026-11-01 测试报告 DEF-4，高危）：批量停用跑到 30% 被强杀 →
    // 重启 → 恢复流把 state 里仍标记为启用的字面又注册回注册表（反向启用 319 个）
    // → 用户点「继续」后续做流再停 409 个 → 终态 reg=319，与「全部停用」的意图相反。
    // 两个机制都在「纠正」注册表，叠加之后终态不可预期。约定：断点在时只弹
    // 「继续吗」，恢复等断点消散（续做完成 / 用户放弃）后的下一次启动再说。
    //
    // 顺带修掉一个潜伏竞态：断点查询必须在 rescan 之后——resumePendingBatch
    // 要靠 get().fonts 把路径还原成族清单，扫描完成前弹框，用户点「继续」会
    // 因为清单为空而静默什么都不做。
    try {
      const cp = await ipc.batchCheckpointGet();
      if (cp) {
        set({ pendingResume: cp });
        return;
      }
    } catch {
      // 断点只是锦上添花，不能让它挡启动
    }
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
    // 并发扫描会互相覆盖（先发起的可能后回来，把新结果擦掉）：改成 single-flight，
    // 同一时刻只有一次真正在扫，后来者等同一份结果（§5 第 11 条）。
    //
    // 注意：**不能**"记一笔、扫完补扫"。试过一版，后果是请求在扫描期间不断到来
    // （看门狗事件 / 设置落盘 / 界面刷新都会触发），补扫一结束又被记一笔 → 无限续扫：
    // 界面永远停在"正在读取字库 xx%"，侧栏计数全是 0，用户感知就是"变慢、卡住"。
    // 接受这里的语义：扫描期间的新意图合并到当前这一次（结果是从磁盘刚读的，本来就不旧）。
    if (scanInflight) return scanInflight;
    const run = (async () => {
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
      // 授权文档里写了「哪些渠道能 / 不能商用」的，首次见到就把原话写进备注
      const seededNotes = await seedLicenseNotes(fonts, notes);
      if (seededNotes) set({ notes: seededNotes });
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
      // 权威结果到位后裁掉已经不存在于字库的选择 / 比较项：
      // 否则「选着的那一族被删掉」之后，选择里留着一个看不见的族，
      // 浮层一关（画面里没有任何可见项）却还在拦快捷键，Delete 会删到不可见的东西（§5 第 18 条）。
      const sel = get().selection.filter((n) => names.has(n));
      if (sel.length !== get().selection.length) set({ selection: sel });
      // 详情面板选中的那一族被删掉时也必须清：否则 Delete 会打到一个查不到的幽灵族上
      // （后端报「不能卸载系统字体」之类），面板又静默消失看不出问题（§5 第 18 条残留）。
      const curFam = get().selectedFamily;
      if (curFam && !names.has(curFam)) set({ selectedFamily: null, rangeAnchor: null });
      const cmp = get().compare;
      if (cmp) {
        const keptCmp = cmp.filter((n) => names.has(n));
        // 比较至少要两项才有意义；掉到两项以下就整个关掉
        if (keptCmp.length < 2) set({ compare: null });
        else if (keptCmp.length !== cmp.length) set({ compare: keptCmp });
      }
    } catch (e) {
      set({ phase: "error" });
      toast.error(t("toast.couldntScan"), String(e));
    }
    })();
    scanInflight = run;
    try {
      await run;
    } finally {
      if (scanInflight === run) scanInflight = null;
    }
  },

  setFamilyActive: async (family, active) => {
    const faces = get().fonts.filter((f) => f.family === family && f.deactivatable);
    const paths = pathsToToggle(faces, active);
    if (paths.length === 0) return;

    const prevSession = get().sessionActivated;
    const prevFonts = get().fonts;
    set({
      fonts: prevFonts.map((f) =>
        f.family === family && f.deactivatable ? { ...f, active } : f,
      ),
      sessionActivated: prevSession.filter((n) => n !== family),
    });

    // 小族（一个批次能装下）保持原样：一条 IPC 就完事，不必为 1~10 个字面弹进度条。
    if (paths.length <= APPLY_CHUNK) {
      try {
        await ipc.setFontsActive(paths, active);
        persistPrefs(get);
      } catch (e) {
        set({ sessionActivated: prevSession });
        toast.error(t(active ? "toast.couldntActivate" : "toast.couldntDeactivate"), String(e));
        await get().rescan();
        persistPrefs(get);
      }
      return;
    }

    // 大族整族启停同样要分批（1.0.0-3 只修了批量路径）：
    // 思源/苹方这类 40+ 字面一次性丢给后端，窗口会连续十几秒不响应。
    // 走和批量完全相同的那条通道，进度条与「取消」一并复用。
    const batches = planBatches(active ? [] : paths, active ? paths : []);
    const applied: ApplyBatch[] = [];
    useFontStore.setState({
      applyBusy: true,
      applyProgress: { done: 0, total: paths.length, undo: false },
      applyCancelled: false,
    });
    // E2：大族启停 5~20 秒，跑批期间同样关窗后台继续（不接断点，清单太短不值得）
    await batchRunBegin();
    let outcome: Awaited<ReturnType<typeof runBatches>>;
    try {
      outcome = await runBatches({
        batches,
        apply: async (batch, noSave) => {
          await ipc.setFontsActive(batch.paths, batch.active, noSave);
          applied.push(batch);
        },
        flush: () => ipc.setFontsActive([], true, false),
        onProgress: (done, all) =>
          useFontStore.setState({ applyProgress: { done, total: all, undo: false } }),
        isCancelled: () => useFontStore.getState().applyCancelled,
      });
    } finally {
      useFontStore.setState({ applyBusy: false, applyProgress: null });
      void batchRunEnd();
    }

    if (outcome.status === "cancelled") {
      // 取消时已做的保留、没轮到的退回原值（和批量同口径）
      const touched = new Set<string>();
      for (const b of applied) for (const p of b.paths) touched.add(p);
      set({
        fonts: get().fonts.map((f) =>
          paths.includes(f.path) && !touched.has(f.path) ? { ...f, active: !active } : f,
        ),
      });
      useFontStore.setState({
        applyNotice: {
          done: applied.reduce((n, b) => n + b.paths.length, 0),
          total: paths.length,
        },
      });
      persistPrefs(get);
      return;
    }

    if (outcome.status === "failed") {
      set({ fonts: prevFonts, sessionActivated: prevSession });
      toast.error(t(active ? "toast.couldntActivate" : "toast.couldntDeactivate"), String(outcome.error));
      await get().rescan();
      persistPrefs(get);
      return;
    }

    persistPrefs(get);
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
      warnSystemFont();
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

  /**
   * 单独启用 / 停用某个字重（0.9.9-13）。
   *
   * 启停的真源是**文件级**（`state.deactivated` 按路径记，GDI 也是按文件注册），
   * 所以先把「用户点的这一行」翻译成真正能动的那个文件：
   * 1. 系统那一份动不了 → 换成同 PostScript 名的库内副本（用户要的是「这个字重失效」）；
   * 2. 一个文件里装了几个字重（TTC）时只能整份启停 → 先提示再动，别让人以为只动了一个。
   */
  setFaceActive: async (faceId, active) => {
    const fonts = get().fonts;
    const face = fonts.find((f) => f.id === faceId);
    if (!face) return;
    const ps = (face.postscriptName ?? "").toLowerCase();
    let target: FontFace | undefined;
    if (face.deactivatable) target = face;
    if (!target && ps) {
      target = fonts.find(
        (f) => f.deactivatable && (f.postscriptName ?? "").toLowerCase() === ps,
      );
    }
    if (!target) {
      target = fonts.find(
        (f) => f.deactivatable && f.family === face.family && f.style === face.style,
      );
    }
    if (!target) {
      warnSystemFont();
      return;
    }
    const sharing = fonts.filter((f) => f.path === target.path);
    if (sharing.length > 1) {
      toast.info(
        t("toast.faceSharedFile", { count: sharing.length }),
        sharing
          .map((f) => f.style || f.postscriptName || "")
          .filter(Boolean)
          .join(" / "),
      );
    }
    await get().setFontFileActive(target.path, active);
    // 用户 2026-10-31：「如果单独启用了哪一个字体，最好是让用户知道字重单独启用了」。
    // 文件级启停原本是静默的，点了眼睛看不出发生了什么，这里明确告诉他只动了这一个字重、
    // 同族其它字重还是原样。启停失败时 setFontFileActive 自己会报错，这里不再重复提示。
    const after = get().fonts;
    const targetNow = after.find((f) => f.id === target.id);
    if (!targetNow || targetNow.active !== active) return;
    const keyOf = (f: FontFace) =>
      (f.postscriptName ?? `${f.family}|${f.style}`).toLowerCase();
    const targetKey = keyOf(targetNow);
    // 同一个字面在系统目录和库里各有一份时只算一个，否则会说「另外 2 个」其实只有 1 个
    const siblingsOn = new Set(
      after
        .filter(
          (f) => f.family === targetNow.family && f.active && keyOf(f) !== targetKey,
        )
        .map(keyOf),
    ).size;
    const label =
      targetNow.style?.trim() || targetNow.postscriptName || targetNow.family;
    const detail = active
      ? siblingsOn === 0
        ? t("toast.faceActivatedSolo")
        : t("toast.faceActivatedSub", { count: siblingsOn })
      : siblingsOn === 0
        ? t("toast.faceDeactivatedSolo")
        : t("toast.faceDeactivatedSub", { count: siblingsOn });
    /**
     * 用户看到的这一行是系统目录那份（去重后系统优先展示），实际停用的是字体库副本。
     * 不说清楚的话，界面状态看起来没变、toast 却说「已单独停用」，两句自相矛盾（BUG-4）。
     */
    const copyNote = targetNow.path !== face.path ? t("toast.faceSystemCopy") : null;
    toast.success(
      t(active ? "toast.faceActivated" : "toast.faceDeactivated", { style: label }),
      copyNote ? `${copyNote} · ${detail}` : detail,
    );
  },

  uninstallFontFile: async (path) => {
    const faces = get().fonts.filter((f) => f.path === path);
    if (faces.length === 0) return;
    if (faces.some((f) => f.source === "system")) {
      warnSystemFont();
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
        const installed = normalizeFaces(result.installed);
        const families = [...new Set(installed.map((f) => f.family))];
        set({ fonts: [...get().fonts, ...installed], lastImported: families });
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
      // 一个包里混了多个字族 → 整包拒绝（后端判定，这里说清是哪个包、有哪些字族）
      for (const zip of result.rejectedZips ?? []) {
        toast.error(
          t("toast.zipMultiFamily", { name: zip.name }),
          t("toast.zipMultiFamilySub", {
            count: zip.fontCount,
            families: zip.families.join(", "),
          }),
        );
      }
      // 跨盘「移动」：源文件进的是 Windows 回收站，不是被搬走 —— 必须说清楚（C7）
      if (result.recycledSources?.length) {
        toast.info(
          t("toast.sourcesRecycled", { count: result.recycledSources.length }),
          t("toast.sourcesRecycledSub"),
        );
      }
      // WOFF 判重：同字体已有 ttf/otf（或 woff2 不受支持）被跳过的个数
      if (result.webfontsSkipped) {
        toast.info(t("toast.webfontsSkipped", { count: result.webfontsSkipped }));
      }
      if (
        result.installed.length === 0 &&
        result.errors.length === 0 &&
        result.duplicates.length === 0 &&
        // 整个包被拒的情况上面已经说清楚了，别再说一句「没有可安装的内容」
        !(result.rejectedZips?.length)
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
    await get().uninstallFamilies([family], opts);
  },

  /**
   * 批量「移到回收站」：一次 IPC、一次状态更新（C8）。
   *
   * 以前是 `for (const f of names) void uninstallFamily(f)`，每个族再逐个文件调
   * `uninstall_font`：4020 个链接字体 → 4020 次整份 `state.json` 落盘（2.27 MB × 4020
   * ≈ 9 GB 写盘）+ 4213 个并发 Promise（私有内存飙到 1 GB）。2026-11-01 事故实测就是这样。
   */
  uninstallFamilies: async (families, opts) => {
    const silent = opts?.silent === true;
    const keepMeta = opts?.keepMeta === true;
    const wanted = new Set(families);
    if (wanted.size === 0) return;
    const faces = get().fonts.filter(
      (f) => wanted.has(f.family) && f.source !== "system",
    );
    if (faces.length === 0) {
      warnSystemFont();
      return;
    }
    // 逐族收路径、去重（TTC 多面共用一个文件），系统字体不发 —— 逻辑在 applyPlan 里有单测
    const items = trashItems(get().fonts, wanted);
    if (items.length === 0) {
      warnSystemFont();
      return;
    }
    try {
      const { entries, errors } = await ipc.uninstallFonts(items);
      const gone = new Set(entries.map((e) => e.family));
      const gonePaths = new Set(entries.map((e) => e.originalPath));
      const kept = get().fonts.filter((f) => !gonePaths.has(f.path));
      set({
        fonts: kept,
        trash: await ipc.listTrash(),
        selectedFamily:
          get().selectedFamily && gone.has(get().selectedFamily as string)
            ? null
            : get().selectedFamily,
        selection: get().selection.filter((f) => !gone.has(f)),
        lastImported: get().lastImported.filter((f) => !gone.has(f)),
        // 被比较的那一族卸载了：比较项里留着失效名字会退化成单列、还继续拦快捷键，
        // 而且以前要等下一次扫描才清（§5 第 18 条残留）
        compare: (() => {
          const cmp = get().compare;
          if (!cmp || !cmp.some((n) => gone.has(n))) return cmp;
          const next = cmp.filter((n) => !gone.has(n));
          return next.length < 2 ? null : next;
        })(),
      });

      if (!keepMeta) {
        const { tags, favorites, collections } = get();
        for (const family of gone) {
          if (tags[family]) void get().setFamilyTags(family, []);
          if (favorites.includes(family)) void get().toggleFavorite(family);
        }
        for (const [name, members] of Object.entries(collections)) {
          if (!members.some((m) => gone.has(m))) continue;
          const next = members.filter((m) => !gone.has(m));
          set({ collections: { ...get().collections, [name]: next } });
          void ipc.setCollection(name, next);
        }
      }
      for (const err of errors) toast.error(t("toast.couldntMoveToTrash"), err);
      if (silent || entries.length === 0) return;

      const only = gone.size === 1 ? [...gone][0] : null;
      const entryIds = entries.map((e) => e.id);
      toast.success(
        only
          ? t("toast.movedToTrash", { family: only })
          : t("toast.movedFamiliesToTrash", { count: gone.size }),
        t("toast.movedToTrashSub"),
        "trash",
        {
          label: t("toast.undo"),
          run: () => {
            void (async () => {
              try {
                for (const id of entryIds) await ipc.restoreFromTrash(id);
                set({ trash: await ipc.listTrash() });
                await get().rescan();
                toast.success(
                  only
                    ? t("toast.restoredFamily", { family: only })
                    : t("toast.restoredFamilies", { count: gone.size }),
                  undefined,
                  "restore",
                );
              } catch (e) {
                toast.error(t("toast.couldntRestore"), String(e));
              }
            })();
          },
        },
      );
    } catch (e) {
      toast.error(t("toast.couldntMoveToTrash"), String(e));
    }
  },

  /**
   * 「移到回收站」的唯一入口：少量直接删，超过阈值先弹确认（C9）。
   *
   * 事故复盘：右键菜单里「将 N 个移到回收站」紧挨着「停用 N 个」，且 N 可以是全选后的
   * 4213 —— 一次误点就把整个库搬进回收站。删除本身可还原（进的是应用回收站），
   * 但「无提示地丢掉 4213 个族」这件事不该只靠用户手稳。
   */
  requestTrash: (families) => {
    const wanted = new Set(families);
    const targets = [...wanted].filter((name) =>
      get().fonts.some((f) => f.family === name && f.source !== "system"),
    );
    if (targets.length === 0) {
      warnSystemFont();
      return;
    }
    if (targets.length <= TRASH_CONFIRM_THRESHOLD) {
      void get().uninstallFamilies(targets);
      return;
    }
    set({ trashConfirm: targets });
  },

  confirmTrash: async () => {
    const targets = get().trashConfirm;
    set({ trashConfirm: null });
    if (targets && targets.length > 0) await get().uninstallFamilies(targets);
  },

  cancelTrash: () => set({ trashConfirm: null }),

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
    const prevOwn = get().tags[family];
    const next = { ...get().tags };
    if (tags.length === 0) delete next[family];
    else next[family] = tags;
    set({ tags: next });
    try {
      await ipc.setTags(family, tags);
    } catch (e) {
      // 只回滚这一族的标签：批量改标签时其他族可能已经写成功，
      // 整包回滚会把它们一起擦掉（§5 第 36 条）。
      const cur = { ...get().tags };
      if (prevOwn === undefined) delete cur[family];
      else cur[family] = prevOwn;
      set({ tags: cur });
      toast.error(t("toast.couldntSaveTags"), String(e));
    }
  },

  /**
   * 把某个标签从所有字族上摘掉（侧栏右键「从所有字体移除」）。
   * 不能在 Sidebar 里拿渲染期快照逐族各发一次 IPC：
   * ① 快照过时会把期间新加的标签一起覆盖掉；② 每个失败的族各弹一条 toast 会刷屏。
   * 这里按最新的 store 状态逐族串行写，失败只报一次（§5 第 36 条）。
   */
  removeTagEverywhere: async (tag) => {
    const targets = Object.entries(get().tags)
      .filter(([, list]) => list.includes(tag))
      .map(([family, list]) => ({ family, next: list.filter((t) => t !== tag) }));
    if (targets.length === 0) return;
    // 一次 set 完成乐观更新，界面不要闪 N 次
    const optimistic = { ...get().tags };
    for (const { family, next } of targets) {
      if (next.length === 0) delete optimistic[family];
      else optimistic[family] = next;
    }
    set({ tags: optimistic });
    let failed = 0;
    for (const { family, next } of targets) {
      try {
        await ipc.setTags(family, next);
      } catch {
        failed++;
      }
    }
    if (failed === 0) {
      // 标签已经不存在了，导航还停在它上面只会落到空列表
      const nav = get().nav;
      if (nav.kind === "tag" && nav.tag === tag) set({ nav: { kind: "library" } });
      return;
    }
    // 失败的回退以磁盘真值为准，只影响真的没写成功的那些族
    try {
      set({ tags: await ipc.getTags() });
    } catch {
      /* 拿不到就以内存状态为准，下次扫描会对齐 */
    }
    toast.error(t("toast.couldntSaveTags"), t("tag.removeEverywhereFailed", { count: failed }));
  },

  createCollection: async (name) => {
    const clean = name.trim();
    if (!clean) return;
    if (get().collections[clean]) {
      toast.error(t("toast.collectionExists"), t("toast.collectionExistsSub", { name: clean }));
      return;
    }
    const prev = get().collections;
    const prevFaces = get().collectionFaces;
    const pending = get().pendingCollectionFor;
    const pendingFaceKey = get().pendingCollectionFace;
    // 从字重菜单「新建分组…」进来时只放这个字重（pendingCollectionFor 只是用来唤起侧栏输入框）
    const families = pendingFaceKey ? [] : pending ? [pending] : [];
    const faces = { ...prevFaces };
    if (pendingFaceKey) faces[clean] = [pendingFaceKey];
    set({
      collections: { ...prev, [clean]: families },
      collectionFaces: faces,
      pendingCollectionFor: null,
      pendingCollectionFace: null,
    });
    try {
      await ipc.setCollection(clean, families);
      const faceObj = pendingFaceKey
        ? get().fonts.find((f) => faceKey(f) === pendingFaceKey)
        : undefined;
      toast.success(
        t("toast.createdCollection", { name: clean }),
        faceObj
          ? t("toast.faceAddedToCollection", {
              style: faceObj.style || faceObj.postscriptName || faceObj.family,
              name: clean,
            })
          : pending
            ? t("toast.familyAdded", { name: pending })
            : t("toast.rightClickToAdd"),
      );
      // 字重级成员不走 state.json，只存在 prefs 里：不写这一下，重启后这个分组就空了
      persistPrefs(get);
    } catch (e) {
      // 分组没建成就把字重级成员一起退掉，否则 prefs 里留着一个不存在的分组的成员，
      // 下次碰巧建成同名分组时会冒出上次没成功的那个字重
      set({ collections: prev, collectionFaces: prevFaces, pendingCollectionFace: null });
      persistPrefs(get);
      toast.error(t("toast.couldntCreateCollection"), String(e));
    }
  },

  /**
   * DEF-1：删除分组的统一入口（侧栏右键菜单、Delete 键都走这里）。
   *
   * 空组直接删——删一个没成员的分组没有任何损失，弹框反而是噪音；
   * 非空先弹确认：分组关系（元数据）的丢失不可撤销，测试文档 §3.7 要求
   * 「组内 N 个字体如何处理」必须有明确提示。字体本身不受影响，
   * 对话框的正文要把这件事说清楚。
   */
  requestDeleteCollection: (name) => {
    const s = get();
    const count = (s.collections[name] ?? []).length + (s.collectionFaces[name] ?? []).length;
    if (count === 0) {
      void get().deleteCollection(name);
      return;
    }
    set({ pendingDestructive: { kind: "collection", name, count } });
  },

  deleteCollection: async (name) => {
    const prev = get().collections;
    const prevFaces = get().collectionFaces;
    // 记下成员数：删除是不可撤销的，提示里带上"少了几项"信息量更高。
    // 分组有两种成员（整族 collections + 字重 collectionFaces），只数整族的话，
    // 纯字重分组会显示「含 0 项」而侧栏明明写着 1（BUG-5）。
    const memberCount = (prev[name] ?? []).length + (prevFaces[name] ?? []).length;
    const next = { ...prev };
    delete next[name];
    // 字重级成员跟着分组一起消失，否则下次建同名分组会冒出旧成员
    const faces = { ...prevFaces };
    delete faces[name];
    const nav = get().nav;
    set({
      collections: next,
      collectionFaces: faces,
      nav: nav.kind === "collection" && nav.name === name ? { kind: "library" } : nav,
    });
    try {
      await ipc.deleteCollection(name);
      persistPrefs(get);
      toast.success(t("toast.deletedCollection", { name, count: memberCount }));
    } catch (e) {
      set({ collections: prev, collectionFaces: prevFaces });
      persistPrefs(get);
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
    // 字重级成员跟着改名搬过去
    const prevFaces = get().collectionFaces;
    const faces = { ...prevFaces };
    if (faces[from]) {
      faces[clean] = faces[from];
      delete faces[from];
    }
    const nav = get().nav;
    set({
      collections: next,
      collectionFaces: faces,
      nav:
        nav.kind === "collection" && nav.name === from
          ? { kind: "collection", name: clean }
          : nav,
    });
    try {
      await ipc.renameCollection(from, clean);
      persistPrefs(get);
    } catch (e) {
      set({ collections: prev, collectionFaces: prevFaces });
      persistPrefs(get);
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

  /**
   * 批量移出分组。**不能用 toggleFamilyInCollection 替代**：那个是开关，
   * 成员不在分组里时会把字体加进去 —— 拿它做"移除"会出现"删了反而加回来"。
   */
  removeFamiliesFromCollection: async (collection, families) => {
    const prev = get().collections;
    const current = prev[collection];
    if (!current) return;
    const drop = new Set(families);
    const removedNames = pickRemovedFamilyNames(current, families);
    // 一条都没命中就静默返回：连按 Delete 不该刷一排提示
    if (removedNames.length === 0) return;
    const next = current.filter((f) => !drop.has(f));
    set({ collections: { ...prev, [collection]: next } });
    try {
      await ipc.setCollection(collection, next);
      toast.success(
        t("toast.removedFromCollection", { count: removedNames.length, name: collection }),
      );
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
    // 最多 5 个（用户 2026-10-30）：满了就明确提醒，不再悄悄淘汰最旧的
    if (get().snapshots.length >= SNAPSHOT_LIMIT) {
      toast.error(t("toast.snapshotLimitReached"), t("toast.snapshotLimitSub", { max: SNAPSHOT_LIMIT }));
      useFontStore.setState({ pendingSnapshotFor: null, pendingSnapshotFace: null });
      return;
    }
    const prev = get().snapshots;
    const prevPending = get().pendingSnapshotFor;
    const prevPendingFace = get().pendingSnapshotFace;
    const family = prevPending;
    // 从字重菜单「新建快照…」进来时只放这个字重（pendingSnapshotFor 只用来唤起侧栏输入框），
    // 语义与 createCollection 的 pendingCollectionFace 一致
    const pendingFaceKey = prevPendingFace;
    const seen = new Set<string>();
    const entries: SnapshotEntry[] = [];
    for (const f of get().fonts) {
      const wanted = pendingFaceKey
        ? faceKey(f) === pendingFaceKey
        : family
          ? f.family === family && f.deactivatable
          : f.active;
      const entry = entryFromFace(f);
      if (!wanted || seen.has(entry.key)) continue;
      seen.add(entry.key);
      entries.push(entry);
    }
    set({
      snapshots: [...prev, { name: clean, createdAt: Date.now(), entries }],
      pendingSnapshotFor: null,
      pendingSnapshotFace: null,
    });
    try {
      const saved = await ipc.saveSnapshot({ name: clean, createdAt: Date.now(), entries });
      set({ snapshots: saved });
      const systemCount = systemBackedEntries(entries, buildFaceIndex(get().fonts)).length;
      const faceObj = pendingFaceKey
        ? get().fonts.find((f) => faceKey(f) === pendingFaceKey)
        : undefined;
      toast.success(
        t("toast.createdSnapshot", { name: clean }),
        faceObj
          ? t("toast.faceAddedToSnapshot", {
              style: faceObj.style || faceObj.postscriptName || faceObj.family,
              name: clean,
            })
          : family
            ? t("toast.familyAdded", { name: family })
            : systemCount > 0
              ? t("snap.systemNote", { count: systemCount })
              : t("toast.rightClickToAdd"),
      );
    } catch (e) {
      set({ snapshots: prev, pendingSnapshotFor: prevPending, pendingSnapshotFace: prevPendingFace });
      toast.error(t("toast.couldntCreateSnapshot"), String(e));
    }
  },

  createSnapshotFromCollection: async (collection) => {
    const clean = collection.trim();
    if (!clean) return;
    const st = get();
    // 扫描没跑完时 fonts 只是「已经扫到的那部分」，这时候建快照会缺一堆字面。
    if (st.phase === "scanning") {
      toast.info(t("snap.waitScan"));
      return;
    }
    if (st.snapshots.some((s) => s.name === clean)) {
      toast.error(t("toast.snapshotExists"), t("toast.nameTakenSub", { name: clean }));
      return;
    }
    if (st.snapshots.length >= SNAPSHOT_LIMIT) {
      toast.error(t("toast.snapshotLimitReached"), t("toast.snapshotLimitSub", { max: SNAPSHOT_LIMIT }));
      return;
    }
    /**
     * 「分组里的字体」= 分组视图里能看到的那一批：
     * 整族成员（collections）算整族所有字面；只加了字重级成员（collectionFaces）的，
     * 只收那几笔。口径与 lib/collectionScope.ts::collectionFaceScope 保持一致 ——
     * 否则「只往分组里放了一个字重」的组会把整族都塞进快照。
     */
    const whole = new Set(st.collections[clean] ?? []);
    const facesInGroup = new Set(st.collectionFaces[clean] ?? []);
    const seen = new Set<string>();
    const entries: SnapshotEntry[] = [];
    for (const f of st.fonts) {
      if (!whole.has(f.family) && !facesInGroup.has(faceKey(f))) continue;
      const entry = entryFromFace(f);
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
      entries.push(entry);
    }
    if (entries.length === 0) {
      toast.error(t("toast.emptyCollection"));
      return;
    }
    const prev = st.snapshots;
    const createdAt = Date.now();
    set({ snapshots: [...prev, { name: clean, createdAt, entries }] });
    try {
      const saved = await ipc.saveSnapshot({ name: clean, createdAt, entries });
      set({ snapshots: saved });
      toast.success(t("toast.createdSnapshot", { name: clean }));
    } catch (e) {
      set({ snapshots: prev });
      toast.error(t("toast.couldntCreateSnapshot"), String(e));
    }
  },

  deleteSnapshot: async (name) => {
    const prev = get().snapshots;
    const entryCount = prev.find((s) => s.name === name)?.entries.length ?? 0;
    const next = prev.filter((s) => s.name !== name);
    const nav = get().nav;
    set({
      snapshots: next,
      nav: nav.kind === "snapshot" && nav.name === name ? { kind: "library" } : nav,
    });
    try {
      await ipc.deleteSnapshot(name);
      toast.success(t("toast.deletedSnapshot", { name, count: entryCount }));
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

  /**
   * 单独把某个字重加入 / 移出快照（0.9.9-13）。
   *
   * 用户 2026-10-31：「可以单独将字族中的某个字重加入到快照中去」。
   * 快照条目本来就是**字面级**的（key = postScriptName），所以这里只动这一条，
   * 不会像 `toggleFamilyInSnapshot` 那样把同族其它字重一起带进来。
   */
  toggleFaceInSnapshot: async (snapshot, faceId) => {
    const prev = get().snapshots;
    const snap = prev.find((s) => s.name === snapshot);
    if (!snap) return;
    const face = get().fonts.find((f) => f.id === faceId);
    if (!face) return;
    const key = faceKey(face);
    const exists = snap.entries.some((e) => e.key === key);
    const entries = exists
      ? snap.entries.filter((e) => e.key !== key)
      : [...snap.entries, entryFromFace(face)];
    set({ snapshots: prev.map((s) => (s.name === snapshot ? { ...s, entries } : s)) });
    try {
      const saved = await ipc.saveSnapshot({ ...snap, entries });
      set({ snapshots: saved });
      const style = face.style || face.postscriptName || face.family;
      toast.success(
        t(exists ? "toast.faceRemovedFromSnapshot" : "toast.faceAddedToSnapshot", {
          style,
          name: snapshot,
        }),
        undefined,
        exists ? undefined : "install",
      );
    } catch (e) {
      set({ snapshots: prev });
      toast.error(t("toast.couldntUpdateSnapshot"), String(e));
    }
  },

  /**
   * 单独把某个字重加入 / 移出分组（0.9.9-13）。
   *
   * 分组本身按字族记，这里记的是「字重级」成员：字族在分组里、或者它某个字面在
   * `collectionFaces[分组]` 里，这个字族就会出现在该分组视图中。
   * 只是把字重挂进分组（不改文件、不改启停），所以不需要动 state.json。
   */
  toggleFaceInCollection: async (collection, faceId) => {
    const face = get().fonts.find((f) => f.id === faceId);
    if (!face) return;
    // 分组可能已经被删掉（右键菜单是打开那一刻的状态快照）：不要在 prefs 里
    // 写出一条属于不存在分组的字重成员，否则下次建同名分组会冒出上次的残留
    if (!get().collections[collection]) return;
    const key = faceKey(face);
    const cur = get().collectionFaces[collection] ?? [];
    const exists = cur.includes(key);
    const next = exists ? cur.filter((k) => k !== key) : [...cur, key];
    const map = { ...get().collectionFaces };
    if (next.length === 0) delete map[collection];
    else map[collection] = next;
    set({ collectionFaces: map });
    persistPrefs(get);
    const style = face.style || face.postscriptName || face.family;
    toast.success(
      t(exists ? "toast.faceRemovedFromCollection" : "toast.faceAddedToCollection", {
        style,
        name: collection,
      }),
      undefined,
      exists ? undefined : "install",
    );
  },

  /**
   * 批量移出快照。
   *
   * 按 `entry.family` 删，**不走 faceKey 反查 fonts**：快照里的字体可能已经不在
   * 本机字库里（卸载过 / 换了机器），按 key 反查会一条都删不掉，留下永远清不掉的
   * 幽灵条目。条目本身带 family 字段，直接用它判断最稳。
   */
  removeFamiliesFromSnapshot: async (snapshot, families) => {
    const prev = get().snapshots;
    const snap = prev.find((s) => s.name === snapshot);
    if (!snap) return;
    const entries = withoutFamilies(snap.entries, families);
    const removed = snap.entries.length - entries.length;
    if (removed === 0) return;
    set({ snapshots: prev.map((s) => (s.name === snapshot ? { ...s, entries } : s)) });
    try {
      const saved = await ipc.saveSnapshot({ ...snap, entries });
      set({ snapshots: saved });
      toast.success(t("toast.removedFromSnapshot", { count: removed, name: snapshot }));
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
    const st = get();
    // 扫描没跑完时 `fonts` 只是「已经扫到的那一部分」。这时候按「解析不到」判定缺失，
    // 会把还没加载进来的条目整批当成「本机找不到」删掉 —— 实测扫描到 71% 时点一下，
    // 320 条的快照被削到只剩 7 条。宁可让用户等扫描完再清理，也不能悄悄吃掉数据。
    if (st.phase === "scanning") {
      toast.info(t("snap.waitScan"));
      return;
    }
    const prev = st.snapshots;
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

  /**
   * DEF-2：清空快照的统一入口（侧栏右键菜单走这里）。
   *
   * 空快照静默返回（与 clearSnapshot 一致：没事可做就别打扰用户）；
   * 非空先弹确认——测试文档 §4.8 要求确认框存在。清掉的只是快照记录，
   * 字体本身一个都不动，对话框正文要把边界说清楚。
   */
  requestClearSnapshot: (name) => {
    const snap = get().snapshots.find((s) => s.name === name);
    if (!snap || snap.entries.length === 0) return;
    set({ pendingDestructive: { kind: "snapshot", name, count: snap.entries.length } });
  },

  /** DEF-1/DEF-2：确认框的「删除分组 / 清除」。确认即执行，原路复用底层 action */
  confirmPendingDestructive: async () => {
    const pending = get().pendingDestructive;
    if (!pending) return;
    set({ pendingDestructive: null });
    if (pending.kind === "collection") {
      await get().deleteCollection(pending.name);
    } else {
      await get().clearSnapshot(pending.name);
    }
  },

  cancelPendingDestructive: () => set({ pendingDestructive: null }),

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
      // 快照上限 5 个：导入只会新建（同名自动加后缀），超额直接整体失败提醒，
      // 不做「导一半」（用户 2026-10-30）
      const room = SNAPSHOT_LIMIT - get().snapshots.length;
      if (list.length > room) {
        toast.error(
          t("toast.snapshotLimitReached"),
          room > 0
            ? t("toast.snapshotLimitImport", { room, count: list.length })
            : t("toast.snapshotLimitSub", { max: SNAPSHOT_LIMIT }),
        );
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

    // 和快照应用走同一条分批路（§12 高压测试发现）：
    // 一次 `AddFontResourceW` 约 0.3~0.5 秒，245 族 588 个字面若一次性丢给后端，
    // 窗口会连续 160 秒不响应（实测 UI 探测 144/158 次超时）。
    // 分批后每批之间让出事件循环，进度条 + 取消也一并复用快照那套。
    const batches = planBatches(active ? [] : paths, active ? paths : []);
    const total = paths.length;
    const applied: ApplyBatch[] = [];
    useFontStore.setState({
      applyBusy: true,
      applyProgress: { done: 0, total, undo: false },
      applyCancelled: false,
    });
    // E2：跑批期间关主窗口 = 藏进托盘后台继续（lib.rs 的 BATCH_RUNNING）
    await batchRunBegin();
    resetCheckpointThrottle();
    let outcome: Awaited<ReturnType<typeof runBatches>>;
    try {
      outcome = await runBatches({
        batches,
        apply: async (batch, noSave) => {
          await ipc.setFontsActive(batch.paths, batch.active, noSave);
          applied.push(batch);
        },
        // 中间批次都跳过了存盘，取消/失败时必须补这一次
        flush: () => ipc.setFontsActive([], true, false),
        onProgress: (done, all) => {
          useFontStore.setState({ applyProgress: { done, total: all, undo: false } });
          // E2：断点记「还没做的路径」（扁平顺序与分批切片顺序一致），30 秒节流
          writeBatchCheckpoint(paths, done, active);
        },
        isCancelled: () => useFontStore.getState().applyCancelled,
      });
    } finally {
      useFontStore.setState({ applyBusy: false, applyProgress: null });
      // done / cancelled / failed 三种出口都作废剩余清单，断点一并清掉
      clearBatchCheckpoint();
      void batchRunEnd();
    }

    if (outcome.status === "cancelled") {
      // 取消只停下的话，系统里会停在「一半启用一半没有」的中途状态：
      // 已做过的保留（记住批次以便一键回退），没轮到的就地退回原值。
      const touched = new Set<string>();
      for (const b of applied) for (const p of b.paths) touched.add(p);
      set({
        fonts: get().fonts.map((f) =>
          paths.includes(f.path) && !touched.has(f.path) ? { ...f, active: !active } : f,
        ),
      });
      undoPending = applied;
      useFontStore.setState({
        applyNotice: {
          done: applied.reduce((n, b) => n + b.paths.length, 0),
          total,
        },
      });
      persistPrefs(get);
      return;
    }

    if (outcome.status === "failed") {
      set({ sessionActivated: prevSession });
      toast.error(t("toast.bulkUpdateFailed"), String(outcome.error));
      await get().rescan();
      persistPrefs(get);
      return;
    }

    persistPrefs(get);
    toast.success(
      t(active ? "toast.activatedCount" : "toast.deactivatedCount", {
        count: families.length,
      }),
      undefined,
      undefined,
      { label: t("toast.undo"), run: () => void get().setFamiliesActiveBulk(families, !active) },
    );
  },

  /**
   * E2：续做上次没跑完的批量（启动弹窗确认后调用）。
   * 把断点里剩下的路径还原成字族清单，走 setFamiliesActiveBulk 同一条路——
   * 乐观更新、分批、进度条、取消、断点、toast 全部复用，不另起一套。
   * 重建的清单可能比断点略大（最后一个族的字面是按批切的，部分已做过）：
   * 重做的开销只是那个族的几条注册表/GDI 重复写，无副作用。
   */
  resumePendingBatch: async (cp) => {
    set({ pendingResume: null });
    const byPath = new Map(get().fonts.map((f) => [f.path, f] as const));
    const families = new Set<string>();
    for (const p of cp.remaining) {
      const f = byPath.get(p);
      if (f && f.deactivatable) families.add(f.family);
    }
    // 弹窗已确认，断点的使命结束——之后的进度由 setFamiliesActiveBulk 自己的新断点接管
    clearBatchCheckpoint();
    if (families.size === 0) return;
    await get().setFamiliesActiveBulk([...families], cp.active);
  },

  dismissPendingResume: () => {
    set({ pendingResume: null });
    clearBatchCheckpoint();
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
    const { selection, selectedFamily, rangeAnchor } = get();
    // 点已选中的卡片 = 取消选中并关掉详情面板（用户 2026-10-31 明确要保留这个开关行为）。
    // 当时报的「点了没反应」真因是**字重区**的点击冒泡到卡片，见 FamilyCard 的 `.card-styles`。
    if (mode === "single" && selectedFamily === family && selection.length <= 1) {
      set({ selection: [], selectedFamily: null, rangeAnchor: null });
      return;
    }
    if (mode === "toggle") {
      const next = selection.includes(family)
        ? selection.filter((f) => f !== family)
        : [...selection, family];
      set({ selection: next, selectedFamily: family, rangeAnchor: null });
      return;
    }
    if (mode === "range") {
      // 锚点 = 这一轮 Shift 扩展开始前选中的那个；第一次扩展时就是当前选中项。
      // 每次都算「锚点 ↔ 当前项」的完整区间并**整体替换**，所以按 Shift+↑ 往回缩时
      // 选区会真的变小 —— 旧实现用并集，只能越选越多（0.9.9-1 实测确认）。
      const anchor = rangeAnchor ?? selectedFamily;
      const a = anchor ? order.indexOf(anchor) : -1;
      const b = order.indexOf(family);
      if (a !== -1 && b !== -1) {
        set({
          selection: order.slice(Math.min(a, b), Math.max(a, b) + 1),
          selectedFamily: family,
          rangeAnchor: anchor,
        });
        return;
      }
    }
    set({ selection: [family], selectedFamily: family, rangeAnchor: null });
  },

  selectAll: () => {
    const order = get().visibleOrder;
    if (order.length === 0) return;
    set({ selection: [...order], selectedFamily: order[order.length - 1], rangeAnchor: null });
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
    // 写盘串行 + 执行时才取当前状态：后端 set_settings 是整包覆盖，
    // 两次并发写若乱序落盘，先发起那一份会把后一次的字段写回旧值（§5 第 12 条残留）。
    let saveError: unknown = null;
    const job = settingsSaveChain.then(async () => {
      try {
        await ipc.setSettings(get().settings);
      } catch (e) {
        saveError = e;
      }
    });
    settingsSaveChain = job;
    await job;
    if (saveError !== null) {
      const e = saveError;
      // 只回滚「本次真正要写、且界面上还是这次值」的字段。
      // 整包回滚成 prev 会把并发成功的其他修改一起擦掉（§5 第 12 条）。
      const cur = get().settings;
      const rollback: Partial<AppSettings> = {};
      for (const key of Object.keys(settings) as (keyof AppSettings)[]) {
        if (cur[key] === settings[key] && prev[key] !== settings[key]) {
          (rollback as Record<string, unknown>)[key as string] = prev[key];
        }
      }
      set({ settings: { ...cur, ...rollback } });
      toast.error(t("toast.couldntSaveSettings"), String(e));
      return;
    }

    const dirsChanged =
      prev.extraDirs.length !== settings.extraDirs.length ||
      prev.extraDirs.some((d, i) => d !== settings.extraDirs[i]) ||
      prev.libraryDir !== settings.libraryDir ||
      prev.libraryDirEnabled !== settings.libraryDirEnabled;
    if (!dirsChanged) return;
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
    // 详情 / 预览都是异步回来的：关掉弹层或连点另一张卡片时，旧请求晚到会把
    // 新的覆盖掉（表现为「关不掉 / 自己又弹开 / 预览是上一个字族」）。
    // 每次打开递增代次，回写前只认自己是当前代次（§5 第 9 条）。
    const gen = ++onlineDetailGen;
    set({ onlineDetailLoading: true, onlineDetail: null, onlinePreviewPath: null });
    try {
      const detail = await ipc.onlineFamily(id);
      if (gen !== onlineDetailGen) return;
      set({ onlineDetail: detail, onlineDetailLoading: false });
    } catch (e) {
      if (gen !== onlineDetailGen) return;
      set({ onlineDetailLoading: false });
      toast.error(t("toast.onlineDetailFailed"), String(e));
      return;
    }
    try {
      const path = await ipc.onlinePreview(id);
      if (gen !== onlineDetailGen || get().onlineDetail?.id !== id) return;
      set({ onlinePreviewPath: path });
    } catch {
      if (gen === onlineDetailGen) set({ onlinePreviewPath: null });
    }
  },

  closeOnlineFamily: () => {
    // 作废所有在飞的详情 / 预览回写（否则关上之后又被旧结果打开）
    onlineDetailGen++;
    const { onlineDetail, onlineDownloading } = get();
    if (onlineDetail && onlineDownloading !== onlineDetail.id) {
      void ipc.onlineClearStaging(onlineDetail.id);
    }
    set({ onlineDetail: null, onlinePreviewPath: null, onlineDetailLoading: false });
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
        set({ fonts: [...get().fonts, ...normalizeFaces(result.installed)], lastImported: [res.family] });
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

  // 重播导览：先把视图切回字库。回收站 / 关于 / 在线栏目里没有导览要指的那些元素，
  // 否则镜头找不到目标，整段导览会对着空气讲（§5 第 29 条）。
  startTour: () => {
    const nav = get().nav;
    const stuck = nav.kind === "trash" || nav.kind === "about" || nav.kind === "online";
    set(stuck ? { tourStep: 0, nav: { kind: "library" } } : { tourStep: 0 });
  },
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
    if (quickbarBusy) {
      // busy 时不能提前 resolve：调用方 await 之后要能读到「切换真的完成了」的状态，
      // 否则 `app://activate` 这类路径会拿旧状态去干活（§5 第 3 条）。
      await quickbarChain;
      // 登记意图的时机可能刚好落在上一轮 while 退出之后，这里补跑一次
      if (!quickbarBusy && get().quickbar !== on) await get().setQuickbar(on);
      return;
    }
    quickbarBusy = true;
    quickbarChain = (async () => {
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
    })();
    await quickbarChain;
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
  setFavoriteOnly: (v) => set({ favoriteOnly: v }),
  toggleCollectionFilter: (name) => {
    const cur = get().collectionFilter;
    set({ collectionFilter: cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name] });
  },
  toggleSnapshotFilter: (id) => {
    const cur = get().snapshotFilter;
    set({ snapshotFilter: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
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
  setFaceIncomplete: (id, reason) => {
    const prev = get().fonts;
    let changed = false;
    const next = prev.map((f) => {
      if (f.id !== id) return f;
      // 已有更严重的原因（文件损坏等）不覆盖；摘标记时只摘自己写上去的那一类
      if (reason && f.incomplete) return f;
      if (!reason && f.incomplete !== UNPREVIEWABLE_REASON) return f;
      if (f.incomplete === reason) return f;
      changed = true;
      return { ...f, incomplete: reason };
    });
    if (changed) set({ fonts: next });
  },
  setToggleableOnly: (toggleableOnly) => set({ toggleableOnly }),
  setIncompleteOnly: (incompleteOnly) => set({ incompleteOnly }),

  exportLibraryData: async (dest) => {
    // 导出口径见 lib/libraryData.ts 顶部注释：标签 + 分组（字族级 / 字重级）+ 收藏 + 备注
    // + 手动版权状态 + 到期日期。**快照不在里面**，它有自己的文件格式与入口。
    const payload = curationPayload(get(), new Date());
    try {
      await ipc.writeTextFile(dest, JSON.stringify(payload, null, 2));
      toast.success(t("toast.libraryDataExported"), dest, "install");
    } catch (e) {
      toast.error(t("toast.exportFailed"), String(e));
    }
  },

  importLibraryData: async (src) => {
    try {
      const parsed = parseCuration(JSON.parse(await ipc.readTextFile(src)));
      if (!parsed.ok) {
        // 快照文件被导进「整理数据」这一行：说清该去哪儿，别让用户对着「这不是导出文件」发懵
        if (parsed.reason === "isSnapshot") {
          toast.error(t("toast.importIsSnapshot"), t("toast.importIsSnapshotSub"));
        } else {
          toast.error(t("toast.notAnExport"), t("toast.notAnExportSub"));
        }
        return;
      }
      const touched = await applyCurationMerge(get, set, parsed.data);
      if (touched === 0) {
        toast.info(t("toast.libraryDataImported"), t("toast.entriesMerged", { count: 0 }));
        return;
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
  /**
   * 整包导出：整理数据 + 字体文件。
   *
   * 这一步可能要写 6 GB（本机字库实测 6.3 GB / 5551 个文件），所以：
   * 全部在 Rust 的阻塞线程池里做，界面不卡；进度只信后端的 `pack:progress`；
   * 超 2 GB 由后端自动分卷，前端只负责把结果念给用户听。
   */
  exportLibraryPack: async (dest) => {
    // 一次只干一趟：两个 6GB 的包同时写盘只会互相拖慢，还会抢同一个进度条
    if (get().packProgress) {
      toast.info(t("toast.packBusy"));
      return;
    }
    const now = new Date();
    set({ packProgress: emptyPackProgress("export") });
    try {
      const report = await ipc.exportLibraryPack(
        dest,
        JSON.stringify(curationPayload(get(), now), null, 2),
        now.toISOString(),
      );
      // 让 100% 多停一下再收，否则用户最后一眼看到的是 97%，以为没做完
      clearPackProgressSoon(set, get, "export");
      toast.success(
        t("toast.packExported", {
          files: report.files,
          size: formatBytes(report.bytes),
          parts: report.parts,
        }),
        report.paths[0] ?? dest,
        "install",
      );
    } catch (e) {
      set({ packProgress: null });
      toast.error(t("toast.packExportFailed"), String(e));
    }
  },

  /**
   * 导入时自动分辨：`.ZFontManager` 解包（字体先落盘、整理数据照旧合并），
   * 其它一律按整理数据 json 处理 —— 用户在同一个「导入」按钮里选什么都行。
   */
  importLibraryFile: async (src) => {
    if (!isPackPath(src)) {
      await get().importLibraryData(src);
      return;
    }
    if (get().packProgress) {
      toast.info(t("toast.packBusy"));
      return;
    }
    set({ packProgress: emptyPackProgress("import") });
    try {
      const report = await ipc.importLibraryPack(src);
      let merged = 0;
      if (report.curation) {
        const parsed = parseCuration(JSON.parse(report.curation));
        // 包里整理数据坏了不该让字体白导：字体已经落盘，这里只放弃合并
        if (parsed.ok) merged = await applyCurationMerge(get, set, parsed.data);
      }
      // 新字体进了字库目录，必须重扫才会出现在列表里
      if (report.added > 0) await get().rescan();
      clearPackProgressSoon(set, get, "import");
      toast.success(
        t("toast.packImported", {
          added: report.added,
          skipped: report.skipped,
          merged,
        }),
        report.libraryDir,
        "restore",
      );
      if (report.missingParts.length > 0) {
        toast.error(
          t("toast.packMissingParts", { parts: report.missingParts.join(" / ") }),
          t("toast.packMissingPartsSub"),
        );
      }
      if (report.failed > 0) {
        toast.error(
          t("toast.packImportFailed"),
          t("toast.packImportFailedSub", { count: report.failed }),
        );
      }
    } catch (e) {
      set({ packProgress: null });
      toast.error(t("toast.packImportFailed"), String(e));
    }
  },
  setNav: (nav) => {
    // 离开「在线」页时详情必须一起关：OnlineView 卸载后 onlineDetail 还留在 store 里，
    // App 的 topLayerOpen() 就恒为真 → Ctrl+K / ? / Delete / 方向键全失效，
    // 暂存目录也不会清；再进在线页旧详情还会自己弹回来（§5 第 9 条残留）。
    if (nav.kind !== "online" && get().onlineDetail) get().closeOnlineFamily();
    set({ nav, selectedFamily: null, selection: [] });
  },
  select: (selectedFamily) =>
    set({
      selectedFamily,
      selection: selectedFamily ? [selectedFamily] : [],
      rangeAnchor: null,
    }),
}));

const styleOrder = (f: FontFace) => f.weight * 2 + (f.italic ? 1 : 0);

/**
 * 字族的归组键 / 显示名。
 *
 * 正常情况就是字体自报的 family。少数文件的 name 表把字族名写成空串（ALLMYHAN、
 * Wartorn、EXCEL、苏新诗古印宋简…），旧逻辑直接拿 "" 当键，这些互不相干的字体会被
 * 并进同一个字族：卡片显示成「N 种样式」、详情面板打不开（name 为空被判成没选中）、
 * 中文判定还取到另一个字体的字面。后端已经改成「空名回退文件名」，这里再兜一层，
 * 保证旧缓存里的空名也不会再串族。
 */
const familyKeyOf = (f: FontFace): string => {
  const direct = (f.family ?? "").trim();
  if (direct) return direct;
  const ps = (f.postscriptName ?? "").trim();
  if (ps) return ps;
  const base = f.path.split(/[\\/]/).pop() ?? f.path;
  return base.replace(/\.[^.]+$/, "") || "Unknown";
};

export function computeFamilies(
  fonts: FontFace[],
  tags: Record<string, string[]>,
): Map<string, Family> {
  const map = new Map<string, Family>();
  for (const f of fonts) {
    const key = familyKeyOf(f);
    let fam = map.get(key);
    if (!fam) {
      fam = {
        name: key,
        faces: [],
        formats: [],
        isVariable: false,
        active: false,
        partial: false,
        activeCount: 0,
        deactivatable: false,
        tags: tags[key] ?? [],
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
        incomplete: false,
        incompleteReason: null,
        brokenFaces: 0,
        brokenAll: false,
      };
      map.set(key, fam);
    }
    fam.faces.push(f);
    {
      // 同一字面（PostScript 名相同）在系统和字体库各有一份时只展示一条，
      // 否则详情面板会出现「Light / Light / Normal / Normal / Negreta / Negreta」这种成对重复
      const pk = (f.postscriptName ?? "").toLowerCase() || `style:${f.style}`;
      const uniq = (fam.uniqueFaces ??= []);
      const at = uniq.findIndex(
        (u) => ((u.postscriptName ?? "").toLowerCase() || `style:${u.style}`) === pk,
      );
      if (at === -1) uniq.push(f);
      else {
        // 系统里已经装了这个字面 → 库里那份不必再列一行（用户 2026-10-31：系统有了库就不需要）。
        // 两边都同源时，才优先保留能启停的那一份。
        const cur = uniq[at];
        const preferSystem = cur.source !== "system" && f.source === "system";
        const preferToggleable =
          cur.source === f.source && !cur.deactivatable && f.deactivatable;
        if (preferSystem || preferToggleable) uniq[at] = f;
      }
    }
    if (!fam.formats.includes(f.format)) fam.formats.push(f.format);
    fam.isVariable ||= f.isVariable;
    fam.foundry ??= f.foundry;
    fam.license ??= f.license;
    fam.copyright ??= f.copyright;
    fam.dirCopyrightClass ??= f.copyrightClass ?? null;
    fam.addedAt = Math.max(fam.addedAt, f.addedAt ?? 0);

    for (const s of f.scripts ?? []) {
      if (!fam.scripts.includes(s)) fam.scripts.push(s);
    }
    for (const ft of f.features ?? []) {
      if (!fam.features.includes(ft)) fam.features.push(ft);
    }
    fam.glyphCount = Math.max(fam.glyphCount, f.glyphCount ?? 0);
    fam.deactivatable ||= f.deactivatable;
    fam.totalSize += f.fileSize;
    if (f.incomplete) {
      fam.incomplete = true;
      fam.brokenFaces += 1;
      fam.incompleteReason ??= f.incomplete;
    }
  }
  for (const fam of map.values()) {
    fam.faces.sort((a, b) => styleOrder(a) - styleOrder(b));
    // 分类必须在字面排序**之后**算：代表字面是按 style 取的，排序后才是用户看到的顺序
    fam.classification = familyClassification(fam.faces);
    // 全坏才算「整个字族不可用」；部分坏只是标注，别让用户以为这族废了
    fam.brokenAll = fam.brokenFaces > 0 && fam.brokenFaces === fam.faces.length;
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

/** 筛选条件（完整界面顶栏「筛选」菜单里的所有维度） */
export type FamilyFilterState = {
  classFilter: Classification[];
  scriptFilter: string[];
  formatFilter: FontFormat[];
  featureFilter: string[];
  sourceFilter: SourceFilter;
  charFilter: string;
  charMatches: string[] | null;
  variableOnly: boolean;
  toggleableOnly: boolean;
  /** 只看损坏 / 不完整的字族（解析失败、缺 name 表、0 字形、缺 cmap） */
  incompleteOnly: boolean;
  licenseFilter: string[];
  copyrightStatus: Record<string, string>;
};

/**
 * 按顶栏「筛选」的条件过滤字族列表。
 * 完整界面和速览界面共用这一份，避免两处口径慢慢跑偏。
 */
export function applyFamilyFilters(out: Family[], s: FamilyFilterState): Family[] {
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
    // 与侧栏「系统字体」同一个口径（`isSystemFamily`：**有**系统字面就算）。
    // 旧代码要求 `every` —— 那会把「系统里有一份、字体库里也有同名副本」的族全部排除，
    // 侧栏数出 166 个，点筛选却只剩几十个（用户 2026-10-31 报「筛选有错误」）。
    out = out.filter(isSystemFamily);
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
  if (s.incompleteOnly) {
    out = out.filter((f) => f.incomplete);
  }
  if (s.licenseFilter.length > 0) {
    // 必须与卡片 / 速览上的版权徽标**同一口径**（`familyCopyrightClass` 看的是代表字面）。
    // 以前这里读字族聚合的 `license` / `dirCopyrightClass`，那是「第一个非空字面」的值，
    // 遇到 Regular 没版权信息、别的字面有时就和徽标不一致：勾「商用免费」筛出这张卡，
    // 卡上却写着「未知」（用户 2026-10-31 报）。
    out = out.filter((f) =>
      s.licenseFilter.includes(familyCopyrightClass(f.faces, s.copyrightStatus[f.name])),
    );
  }
  return out;
}

/**
 * 「系统字体」的口径（侧栏计数与列表过滤共用一份，避免两处不一致）。
 *
 * 用户的理解是「C:\Windows\Fonts 里有的字体」——所以只要该字族在系统目录里
 * 有**至少一个**字面就算。旧口径要求「整族的字面全都来自系统」，
 * 于是字体库里存了同名副本的族（Arial、Book Antiqua…）全被排除，166 个系统字族只显示 10 个。
 */
export function isSystemFamily(f: Family): boolean {
  return f.faces.some((face) => face.source === "system");
}

export function selectVisibleFamilies(s: {  fonts: FontFace[];
  tags: Record<string, string[]>;
  collections: Record<string, string[]>;
  collectionFaces?: Record<string, string[]>;
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
  /** 只看损坏 / 不完整的字族（解析失败、缺 name 表、0 字形、缺 cmap） */
  incompleteOnly: boolean;
  licenseFilter: string[];
  copyrightStatus: Record<string, string>;
  nav: Nav;
  sort: SortMode;
}): Family[] {
  const families = [...familiesFor(s.fonts, s.tags).values()];
  const q = s.search.trim().toLowerCase();
  let out = applyFamilyFilters(families, s);
  if (s.nav.kind === "tag") {
    const tag = s.nav.tag;
    out = out.filter((f) => f.tags.includes(tag));
  }
  if (s.nav.kind === "collection") {
    const name = s.nav.name;
    const members = s.collections[name] ?? [];
    const faceKeys = new Set(s.collectionFaces?.[name] ?? []);
    // 字族级成员 + 字重级成员（0.9.9-13：可以只把某个字重放进分组）
    out = out.filter(
      (f) => members.includes(f.name) || f.faces.some((fc) => faceKeys.has(faceKey(fc))),
    );
  }
  if (s.nav.kind === "snapshot") {
    const snapshotName = s.nav.name;
    const snap = s.snapshots.find((sn) => sn.name === snapshotName);
    // 条目是可移植标识，需先解析成当前机器上的字体路径
    // 用**字面 id** 而不是路径：TTC 一个文件里可能有多个 family（msjh.ttc 里的
    // Microsoft JhengHei / Microsoft JhengHei UI），按路径会把同文件的另一个族也拉进来。
    const members = entryFaceIds(snap?.entries ?? [], buildFaceIndexCached(s.fonts));
    const memberSet = new Set(members);
    out = out.filter((f) => f.faces.some((fc) => memberSet.has(fc.id)));
    const order = new Map(members.map((p, i) => [p, i] as const));
    const firstIndex = (f: Family) =>
      f.faces.reduce(
        (min, fc) => Math.min(min, order.get(fc.id) ?? Number.MAX_SAFE_INTEGER),
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
    out = out.filter(isSystemFamily);
  }
  if (q) {
    // 2026-11-01 用户反馈「有些都搜索不到」：原来只匹配族名/标签/格式/厂商/备注/授权/本地化名，
    // 漏了字重样式（Semibold）、PostScript 名、文件名，以及「中文 / 衬线 / 连字」这类
    // 只存在于 i18n 文案里的中文标签。规则与单测都在 `lib/familySearch.ts`。
    const tokens = searchTokens(q);
    const labels = searchLabelMaps();
    out = out.filter((f) =>
      familyMatches(
        {
          name: f.name,
          tags: f.tags,
          formats: f.formats,
          foundry: f.foundry,
          license: f.license,
          copyright: f.copyright,
          scripts: f.scripts,
          features: f.features,
          classification: f.classification,
          faces: f.faces,
          note: s.notes[f.name] ?? null,
        },
        tokens,
        labels,
      ),
    );
  }
  return sortFamilies(out, s.sort);
}

/**
 * 语言 / 分类 / 特性的「编码 → 当前语言文案」映射，给搜索用。
 *
 * 有了它，搜「中文」「衬线」「连字」能命中对应字体 —— 这些词只存在于 i18n 文案里，
 * 字体数据本身只有 `han` / `serif` / `liga` 这种编码。
 * 代码在模块级缓存：文案只在切语言时变，不必每次按键重建。
 */
let labelMapsCache: { locale: string; maps: LabelMaps } | null = null;

const SCRIPT_CODES = [
  "han", "kana", "hangul", "latin", "cyrillic", "greek", "arabic",
  "hebrew", "thai", "devanagari", "cjk", "korean", "vietnamese",
];
const CLASS_CODES = ["display", "mono", "sans", "script", "serif", "unknown"];
const FEATURE_CODES = [
  "c2sc", "calt", "dlig", "frac", "hist", "liga", "lnum", "onum", "ordn",
  "pnum", "salt", "smcp", "stylisticSet", "subs", "sups", "swsh", "titl",
  "tnum", "zero",
];

function searchLabelMaps(): LabelMaps {
  const locale = activeLocale();
  if (labelMapsCache?.locale === locale) return labelMapsCache.maps;
  const build = (prefix: string, codes: string[]) => {
    const out: Record<string, string> = {};
    for (const code of codes) {
      // 文案缺失时 t() 会回显 key，回显值不参与匹配（否则搜 "feat.xx" 也能命中）
      const text = t(`${prefix}.${code}` as TKey);
      if (text && !text.startsWith(`${prefix}.`)) out[code] = text;
    }
    return out;
  };
  const maps: LabelMaps = {
    script: build("script", SCRIPT_CODES),
    classification: build("class", CLASS_CODES),
    feature: build("feat", FEATURE_CODES),
  };
  labelMapsCache = { locale, maps };
  return maps;
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

/**
 * 预览加载结果回流到「无法预览 / 损坏」这一类：
 * 两档修复都失败 → 标记并持久化；修好了 → 摘掉。
 */
setUnpreviewableHook((id, on) => {
  useFontStore.getState().setFaceIncomplete(id, on ? UNPREVIEWABLE_REASON : null);
  void ipc.setUnpreviewable([id], on).catch(() => {});
});
