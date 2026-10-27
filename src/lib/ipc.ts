import { invoke } from "@tauri-apps/api/core";

export type FontFormat = "otf" | "ttf" | "woff" | "woff2" | "unknown";
export type FontSource = "system" | "user" | "managed";
export type Classification = "serif" | "sans" | "mono" | "display" | "script" | "unknown";

export interface VariationAxis {
  tag: string;
  min: number;
  default: number;
  max: number;
}

/** name 表里的一个本地化字族名 */
export interface LocalizedFontName {
  /** BCP-47 语言标签（en / zh-Hans / ja …），识别不出时为英文语言名 */
  lang: string;
  name: string;
}

export interface FontFace {
  id: string;
  path: string;

  previewPath: string | null;
  faceIndex: number;
  family: string;
  style: string;
  postscriptName: string | null;
  /** name 表里的多语言字族名（en / zh-Hans / ja …），可能为空 */
  localizedNames?: LocalizedFontName[];
  foundry: string | null;
  license: string | null;
  licenseUrl: string | null;
  copyright: string | null;
  /**
   * 按「版权信息文件 > 文件夹备注 > 字体自带信息」判定的版权分类
   * （free / paid / timelimited / unknown）。字体库目录里的字体才有。
   */
  copyrightClass?: string | null;
  format: FontFormat;
  isVariable: boolean;
  axes: VariationAxis[];
  weight: number;
  italic: boolean;
  monospaced: boolean;
  classification: Classification;
  scripts: string[];
  features: string[];
  glyphCount: number;
  fileSize: number;
  source: FontSource;
  deactivatable: boolean;
  active: boolean;
  /** 入库时间（Unix 秒），系统字体等无记录时为 null */
  addedAt: number | null;
}

export interface TrashEntry {
  id: string;
  originalPath: string;
  trashedPath: string;
  family: string;
  trashedAt: number;
}

/**
 * 快照条目：只记录字体自身的可移植信息，不含目录、不携带字体文件。
 * 换电脑 / 字体库路径不同时，靠 key（postScriptName 等）+ 字族样式重新对上号。
 */
export interface SnapshotEntry {
  /** 跨设备可移植标识（ps:postscriptname 或 fam:字族|样式|字重|斜体|面索引） */
  key: string;
  /** 旧版数据里的绝对路径，仅用于升级/导入时反查，新数据不写入 */
  path?: string;
  family: string;
  /** 字体样式名，key 失效时作为兜底匹配 */
  style: string;
  /** 该条目是否为系统安装的字体（应用快照时系统字体不受影响） */
  system: boolean;
}

export interface Snapshot {
  name: string;
  /** 创建时间（毫秒时间戳） */
  createdAt: number;
  entries: SnapshotEntry[];
}

export interface InstallResult {
  installed: FontFace[];
  errors: string[];
  duplicates: string[];
}

export interface ScanProgress {
  done: number;
  total: number;
}

export interface InstallProgress {
  file: string;
  done: number;
  total: number;
  ok: boolean;
  error: string | null;
}

export type AdobeApp = "photoshop" | "illustrator" | "coreldraw";

/** 右键菜单 / 命令面板里「在 … 中应用」的目标软件（新增目标只改这一处） */
export const ADOBE_APPS: readonly AdobeApp[] = ["photoshop", "illustrator", "coreldraw"];

/** CorelDRAW 只有 Windows 版后端（走 COM），其它平台不展示该条目 */
const IS_WINDOWS = !/mac|iphone|ipad|linux|android/i.test(navigator.platform);

/** 当前平台实际可用的目标（菜单 / 命令面板只遍历这个） */
export const AVAILABLE_ADOBE_APPS: readonly AdobeApp[] = ADOBE_APPS.filter(
  (app) => app !== "coreldraw" || IS_WINDOWS,
);

/** 目标软件的预热进度（底部指示条用）：百分比到 100 表示随时可以立刻应用字体 */
export interface AppWarm {
  id: AdobeApp;
  running: boolean;
  percent: number;
  /** managed / idle / probing / ready / failed / not-running */
  state: string;
  /** 接一次测量的耗时（毫秒），0 表示还没测过 */
  ms: number;
}

export interface AppSettings {
  extraDirs: string[];
  watchEnabled: boolean;
  autoActivateImports: boolean;
  libraryDir: string | null;
  libraryDirEnabled: boolean;
  affinityEnabled: boolean;
  affinityDeactivateOnQuit: boolean;
  onlineFontsEnabled: boolean;
}

export interface OnlineFamily {
  id: string;
  family: string;
  category: string;
  weights: number[];
  styles: string[];
  subsets: string[];
  variable: boolean;
  license: string;
  lastModified: string;
}

export interface OnlineCatalogue {
  fetchedAt: number;
  fromCache: boolean;
  families: OnlineFamily[];
}

export interface OnlineFile {
  name: string;
  style: string;
  weight: number;
  filename: string;
  postScriptName: string;
  fullName: string;
  copyright: string;
}

export interface OnlineFamilyDetail {
  id: string;
  family: string;
  designer: string;
  category: string;
  license: string;
  licenseName: string;
  licenseUrl: string;
  reservedFontName: string | null;
  copyright: string;
  files: OnlineFile[];
  licenseText: string;
  sourceDir: string;
}

export interface OnlineDownloadResult {
  family: string;
  paths: string[];
  licensePath: string;
  source: string;
}

export interface OnlineProgress {
  id: string;
  file: string;
  done: number;
  total: number;
}

export interface AffinityConnection {
  reachable: boolean;
  version: string | null;
  docCount: number;
  error: string | null;
}

export type InstallMode = "link" | "move";

export const ipc = {
  getSettings: () => invoke<AppSettings>("get_settings"),
  setSettings: (settings: AppSettings) => invoke<void>("set_settings", { settings }),
  /** 进入 / 退出速览界面：原生侧借此屏蔽「拖到屏幕顶部就最大化」 */
  setQuickbarMode: (mode: boolean) => invoke<void>("set_quickbar_mode", { mode }),
  /** 收成细线后开启原生侧的光标靠近感应（细线太窄，光靠鼠标进窗口几乎碰不到） */
  setDockSensor: (active: boolean) => invoke<void>("set_dock_sensor", { active }),
  setWindowTransitions: (disabled: boolean) =>
    invoke<void>("set_window_transitions", { disabled }),
  defaultLibraryDir: () => invoke<string>("default_library_dir"),
  affinityConnection: () => invoke<AffinityConnection>("affinity_connection"),
  affinitySessionActivate: (paths: string[]) =>
    invoke<string[]>("affinity_session_activate", { paths }),
  onlineCatalogue: (force: boolean) => invoke<OnlineCatalogue>("online_catalogue", { force }),
  onlineFamily: (id: string) => invoke<OnlineFamilyDetail>("online_family", { id }),
  onlineDownload: (id: string) => invoke<OnlineDownloadResult>("online_download", { id }),
  onlinePreview: (id: string) => invoke<string>("online_preview", { id }),
  onlineClearStaging: (id: string) => invoke<void>("online_clear_staging", { id }),
  onlineHosts: () => invoke<string[]>("online_hosts"),
  /** 列出各目录下的版权信息类文件（用于判断字族是否带版权文件） */
  infoFiles: (dirs: string[]) => invoke<Record<string, string[]>>("info_files", { dirs }),
  scanFonts: () => invoke<FontFace[]>("scan_fonts"),
  setFontActive: (path: string, active: boolean) =>
    invoke<void>("set_font_active", { path, active }),
  setFontsActive: (paths: string[], active: boolean) =>
    invoke<void>("set_fonts_active", { paths, active }),
  setFontsActiveSession: (paths: string[]) =>
    invoke<void>("set_fonts_active_session", { paths }),
  installFonts: (paths: string[], existing: string[], mode: InstallMode) =>
    invoke<InstallResult>("install_fonts", { paths, existing, mode }),
  installOnline: (
    paths: string[],
    existing: string[],
    family: string,
    licensePath: string | null,
    source: string,
    licenseDirs: string[] = [],
  ) =>
    invoke<InstallResult>("install_online_family", {
      paths,
      existing,
      family,
      licensePath,
      source,
      licenseDirs,
    }),
  uninstallFont: (path: string, family: string) =>
    invoke<TrashEntry>("uninstall_font", { path, family }),
  listTrash: () => invoke<TrashEntry[]>("list_trash"),
  restoreFromTrash: (entryId: string) => invoke<void>("restore_from_trash", { entryId }),
  deleteTrashEntry: (entryId: string) => invoke<void>("delete_trash_entry", { entryId }),
  emptyTrash: () => invoke<void>("empty_trash"),
  getTags: () => invoke<Record<string, string[]>>("get_tags"),
  setTags: (family: string, tags: string[]) => invoke<void>("set_tags", { family, tags }),
  getFavorites: () => invoke<string[]>("get_favorites"),
  getNotes: () => invoke<Record<string, string>>("get_notes"),
  setNote: (family: string, note: string) => invoke<void>("set_note", { family, note }),
  setFavorite: (family: string, favorite: boolean) =>
    invoke<void>("set_favorite", { family, favorite }),
  getCharset: (path: string, faceIndex: number) =>
    invoke<number[]>("get_charset", { path, faceIndex }),
  getFeatures: (path: string, faceIndex: number) =>
    invoke<string[]>("get_features", { path, faceIndex }),
  /**
   * 把界面上改过的版权状态同步回字体库里的字族目录（目录名后缀跟着改）。
   * status 传 "auto" 时按「版权信息文件 > 文件夹备注 > 字体自带信息」重新判定。
   * 返回实际改名的目录数（系统字体等不在字体库里时为 0）。
   */
  syncFamilyCopyright: (family: string, status: string) =>
    invoke<number>("sync_family_copyright", { family, status }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  writeBinaryFile: (path: string, data: number[]) =>
    invoke<void>("write_binary_file", { path, data }),
  getCollections: () => invoke<Record<string, string[]>>("get_collections"),
  setCollection: (name: string, families: string[]) =>
    invoke<void>("set_collection", { name, families }),
  deleteCollection: (name: string) => invoke<void>("delete_collection", { name }),
  renameCollection: (from: string, to: string) =>
    invoke<void>("rename_collection", { from, to }),
  getSnapshots: () => invoke<Snapshot[]>("get_snapshots"),
  saveSnapshot: (snapshot: Snapshot) =>
    invoke<Snapshot[]>("save_snapshot", { snapshot }),
  deleteSnapshot: (name: string) => invoke<void>("delete_snapshot", { name }),
  renameSnapshot: (from: string, to: string) =>
    invoke<void>("rename_snapshot", { from, to }),
  exportFont: (src: string, dest: string) => invoke<void>("export_font", { src, dest }),
  writeTextFile: (path: string, content: string) =>
    invoke<void>("write_text_file", { path, content }),
  exportFonts: (paths: string[], destDir: string) =>
    invoke<number>("export_fonts", { paths, destDir }),
  adobeAvailable: () => invoke<boolean>("adobe_available"),
  applyFontInApp: (app: AdobeApp, postscriptName: string, label: string) =>
    invoke<string>("apply_font_in_app", { app, postscriptName, label }),
  appWarmState: () => invoke<AppWarm[]>("app_warm_state"),
  affinityLink: () => invoke<AffinityConnection | null>("affinity_link"),
  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),
  getAutostart: () => invoke<boolean>("get_autostart"),
  getPrefs: () => invoke<Record<string, unknown> | null>("get_prefs"),
  setPrefs: (prefs: Record<string, unknown>) => invoke<void>("set_prefs", { prefs }),
  fontsWithChar: (paths: string[], codepoint: number) =>
    invoke<string[]>("fonts_with_char", { paths, codepoint }),
  setUiScale: (scale: number | null) => invoke<number>("set_ui_scale", { scale }),
};
