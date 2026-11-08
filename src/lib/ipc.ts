import { invoke } from "@tauri-apps/api/core";

export type FontFormat = "otf" | "ttf" | "woff" | "woff2" | "unknown";
export type FontSource = "system" | "user" | "managed";
export type Classification = "serif" | "sans" | "mono" | "display" | "script" | "unknown";

/**
 * E2：批量启停断点（state.json 的 `pending_batch`）。
 * 批量跑到一半进程退出时留下的「还剩哪些没做」，下次启动弹窗问用户要不要续。
 */
export interface PendingBatch {
  /** 还没做启停的字体路径（有序） */
  remaining: string[];
  /** 已完成的字面数（展示用） */
  done: number;
  total: number;
  /** true = 启用，false = 停用 */
  active: boolean;
}

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
  /** 从同目录授权文档摘出的「哪些渠道能 / 不能商用」原话（只摘原句，不改写） */
  licenseNote?: string | null;
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
  /**
   * 损坏 / 不完整的原因（解析失败、缺 name 表、0 字形、缺 cmap、文件读不出来）。
   * null / undefined = 正常。系统字体不标记。
   */
  incomplete?: string | null;
  fileSize: number;
  source: FontSource;
  deactivatable: boolean;
  active: boolean;
  /** 入库时间（Unix 秒），系统字体等无记录时为 null */
  addedAt: number | null;
}

export interface CharsetStats {
  /** cmap 可用码位总数（去掉控制字符、代理区、私用区、重复码位） */
  total: number;
  han: number;
  kana: number;
  hangul: number;
  latin: number;
  symbols: number;
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
  /** 本次跳过的 WOFF/WOFF2 个数（同字体已有 ttf/otf，或 woff2 不受支持） */
  webfontsSkipped?: number;
  /** 「移动」导入跨盘降级成「复制 + 源文件进回收站」的源路径（C7） */
  recycledSources?: string[];
  /** 因「一个压缩包里混了多个字族」被整包拒绝的包 */
  rejectedZips?: RejectedZip[];
  /**
   * 族名读不出来、被收进「未识别字体（…）」兜底目录的文件名。
   * name 表编码太偏（GBK / Big5 / Mac Roman）或记录损坏时会发生，字体本身没坏。
   */
  unrecognized?: string[];
}

/** 混装多个字族、被整包拒绝导入的压缩包 */
export interface RejectedZip {
  /** 压缩包文件名 */
  name: string;
  /** 包里识别到的字族名（最多 5 个） */
  families: string[];
  /** 被拒绝的字体文件数 */
  fontCount: number;
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

/**
 * 整包（`.FontManager`）导入导出的进度。和 `ScanProgress` 不是一回事：
 * 那个是「读字库」，这个是自己打字/解包，所以要另外给用户看。
 */
export interface PackProgress {
  kind: "export" | "import";
  phase: string;
  done: number;
  total: number;
  /** 当前第几卷 / 共几卷；单卷时都是 1 */
  part: number;
  parts: number;
  bytes: number;
  current: string;
}

/** 打包结果（见 src-tauri/src/library_pack.rs::PackExportReport） */
export interface PackExportReport {
  paths: string[];
  parts: number;
  files: number;
  bytes: number;
  /** 因为是系统字体副本而被排除的数量 */
  skippedSystem: number;
}

/** 解包结果（见 src-tauri/src/library_pack.rs::PackImportReport） */
export interface PackImportReport {
  curation: string | null;
  added: number;
  skipped: number;
  failed: number;
  parts: number;
  /** 用户只拷了一部分卷过来时，这里列出缺的卷号 */
  missingParts: number[];
  libraryDir: string;
}


/** 右键菜单 / 命令面板里「在 … 中应用」的目标软件（新增目标只改这一处） */
export const ADOBE_APPS: readonly AdobeApp[] = ["photoshop", "illustrator", "coreldraw"];

/** CorelDRAW 只有 Windows 版后端（走 COM），其它平台不展示该条目 */
const IS_WINDOWS = !/mac|iphone|ipad|linux|android/i.test(navigator.platform);

/** 当前平台实际可用的目标（菜单 / 命令面板只遍历这个） */
export const AVAILABLE_ADOBE_APPS: readonly AdobeApp[] = ADOBE_APPS.filter(
  (app) => app !== "coreldraw" || IS_WINDOWS,
);

/** 「归置重复字体」的结果（见 src-tauri/src/scanner.rs::DedupeReport） */
export interface DedupeReport {
  moved: number;
  failed: number;
  bytes: number;
  /** 归置目标目录（绝对路径） */
  dest: string;
  dryRun: boolean;
  samples: string[];
  /** 名字对上了但内容和系统那份不一样（多半是另一个版本）→ 保留未动 */
  skippedDifferent: number;
  /** 文件名撞车但其实不是同一个字体（PS 名对不上 / 文件里夹着系统没有的字族）→ 保留未动 */
  skippedPartial: number;
}

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
  /** 保存过的库地址（最多 3 个），设置页可一键切换 */
  libraryDirs: string[];
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
  /** 本次是否落了许可证文件（只补字重时为 null） */
  licensePath: string | null;
  source: string;
}

/** 在线安装的下载范围：只下缺的字重 / 只补版权文件 */
export interface OnlineInstallScope {
  /** null = 全部文件；数组 = 只下这些文件名（空数组 = 一个字体都不下） */
  files: string[] | null;
  /** 是否同时落许可证文件 */
  license: boolean;
}

export interface OnlineProgress {
  id: string;
  file: string;
  done: number;
  total: number;
}

/** 版权文件反查结果（族名 + PostScript 名双严格命中） */
export interface LicenseSaved {
  family: string;
  fileName: string;
  licenseName: string;
  licenseUrl: string;
  /** 匹配依据：命中的 PostScript 名 */
  postscript: string;
  /** 实际写入的目录 */
  written: string[];
}

export interface AffinityConnection {
  reachable: boolean;
  version: string | null;
  docCount: number;
  error: string | null;
}

/** copy = 复制进字体库（源文件夹保留）；move = 搬进字体库；link = 只登记路径 */
export type InstallMode = "link" | "move" | "copy";

/**
 * 字族名为空时补一个可用的名字。
 *
 * 少数字体把 name 表的字族名写成空串（ALLMYHAN、Wartorn、EXCEL、苏新诗古印宋简…）。
 * 后端解析已改成「空名回退文件名」，这里再兜一层：只要 family 是空的，就用
 * PostScript 名 → 文件名兜底，保证前端所有按 family 名的比较（启用/停用、选中、
 * 标签、快照条目）不会因为空串把所有这类字体串成一个族。
 */
export function withFamilyName(f: FontFace): FontFace {
  if ((f.family ?? "").trim()) return f;
  const ps = (f.postscriptName ?? "").trim();
  const base = (f.path.split(/[\\/]/).pop() ?? f.path).replace(/\.[^.]+$/, "");
  return { ...f, family: ps || base || "Unknown" };
}

export const normalizeFaces = (list: FontFace[]): FontFace[] => list.map(withFamilyName);

export const ipc = {  getSettings: () => invoke<AppSettings>("get_settings"),
  setSettings: (settings: AppSettings) => invoke<void>("set_settings", { settings }),
  /** 进入 / 退出速览界面：原生侧借此屏蔽「拖到屏幕顶部就最大化」 */
  setQuickbarMode: (mode: boolean) => invoke<void>("set_quickbar_mode", { mode }),
  /** 把速览窗口强行提到前台并给键盘焦点（热键叫出面板后调用） */
  focusQuickbar: () => invoke<void>("focus_quickbar"),
  /** 重新注册系统级快捷键（设置里改键后调用）；注册失败会 reject */
  setQuickbarHotkey: (hotkey: {
    vk: number;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    meta: boolean;
    label?: string;
  }) => invoke<void>("set_quickbar_hotkey", { hotkey }),
  /** 收成细线后开启原生侧的光标靠近感应（细线太窄，光靠鼠标进窗口几乎碰不到） */
  setDockSensor: (active: boolean) => invoke<void>("set_dock_sensor", { active }),
  /**
   * 开关系统窗口圆角。收起态必须关掉：DWM 只给圆角窗口画阴影，
   * 一条 43px 的提示条在浅色桌面上会拖出一大圈阴影；关掉后圆角改由 CSS 画。
   */
  setWindowRounded: (on: boolean) => invoke<void>("set_window_rounded", { on }),
  setWindowTransitions: (disabled: boolean) =>
    invoke<void>("set_window_transitions", { disabled }),
  defaultLibraryDir: () => invoke<string>("default_library_dir"),
  /**
   * 在资源管理器里打开这个文件夹本身（进去看内容）。
   * 目录不要用 plugin-opener 的 revealItemInDir —— 那个是「打开父目录并选中」，
   * 点库地址旁的文件夹按钮会落到桌面上，而不是进到字体库里。
   */
  openFolder: (path: string) => invoke<void>("open_folder", { path }),
  /** 给字体库文件夹挂上软件专属图标（灰底文件夹 + 抽出的纸 + 黑 F） */
  applyLibraryFolderIcon: (dir: string) =>
    invoke<void>("apply_library_folder_icon", { dir }),
  affinityConnection: () => invoke<AffinityConnection>("affinity_connection"),
  affinitySessionActivate: (paths: string[]) =>
    invoke<string[]>("affinity_session_activate", { paths }),
  onlineCatalogue: (force: boolean) => invoke<OnlineCatalogue>("online_catalogue", { force }),
  onlineFamily: (id: string) => invoke<OnlineFamilyDetail>("online_family", { id }),
  /** 下载字族文件。files 给 null = 全下；给数组 = 只下这些文件名；license 控制是否落许可证 */
  onlineDownload: (id: string, files: string[] | null = null, license = true) =>
    invoke<OnlineDownloadResult>("online_download", { id, files, license }),
  onlinePreview: (id: string) => invoke<string>("online_preview", { id }),
  onlineClearStaging: (id: string) => invoke<void>("online_clear_staging", { id }),
  onlineHosts: () => invoke<string[]>("online_hosts"),
  /** 列出各目录下的版权信息类文件（用于判断字族是否带版权文件） */
  infoFiles: (dirs: string[]) => invoke<Record<string, string[]>>("info_files", { dirs }),
  /** 用系统默认程序打开字库里的一个文件（详情面板「版权文件」点一下就开） */
  openLocalFile: (path: string) => invoke<void>("open_local_file", { path }),
  /**
   * 记录/撤销「软件里预览不出来」的字面（后端只写名单，不搬文件）。
   * 两档修复都失败时由 fontLoader 上报，能显示时摘掉。
   */
  setUnpreviewable: (ids: string[], on: boolean) => invoke<void>("set_unpreviewable", { ids, on }),
  /**
   * 按「族名 + PostScript 名」双严格匹配到上游反查许可证并写进字体目录。
   * 匹配不上返回 null（绝不猜）。
   */
  fontLicenseFetch: (family: string, postscripts: string[], dirs: string[]) =>
    invoke<LicenseSaved | null>("font_license_fetch", { family, postscripts, dirs }),
  scanFonts: () => invoke<FontFace[]>("scan_fonts").then(normalizeFaces),
  setFontActive: (path: string, active: boolean) =>
    invoke<void>("set_font_active", { path, active }),
  setFontsActive: (paths: string[], active: boolean, noSave?: boolean) =>
    invoke<void>("set_fonts_active", { paths, active, noSave: noSave ?? false }),
  setFontsActiveSession: (paths: string[]) =>
    invoke<void>("set_fonts_active_session", { paths }),
  /**
   * E2：批量启停「进行中」标志。置位期间关主窗口 = 藏进托盘后台继续跑，
   * 不退出进程；批量结束（含取消/失败）必须复位。
   */
  setBatchRunning: (on: boolean) => invoke<void>("set_batch_running", { on }),
  /** E2：写/清批量启停断点（`null` = 清除。一次落盘 2.4MB，调用方自行节流） */
  batchCheckpoint: (cp: PendingBatch | null) =>
    invoke<void>("batch_checkpoint", { cp }),
  /** E2：启动时查有没有没做完的批量（有 → 弹「继续吗」） */
  batchCheckpointGet: () => invoke<PendingBatch | null>("batch_checkpoint_get"),
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
  /**
   * 批量移到回收站（C8）。
   * 后端一次加锁、一次落盘、一次 WM_FONTCHANGE 广播 —— 单个文件走 `uninstallFont`
   * 会让 N 个文件产生 N 次整份 state 落盘（2.27 MB × N）。
   */
  uninstallFonts: (items: { path: string; family: string }[]) =>
    invoke<{ entries: TrashEntry[]; errors: string[] }>("uninstall_fonts", { items }),
  listTrash: () => invoke<TrashEntry[]>("list_trash"),
  restoreFromTrash: (entryId: string) => invoke<void>("restore_from_trash", { entryId }),
  deleteTrashEntry: (entryId: string) => invoke<void>("delete_trash_entry", { entryId }),
  emptyTrash: () => invoke<void>("empty_trash"),
  getTags: () => invoke<Record<string, string[]>>("get_tags"),
  setTags: (family: string, tags: string[]) => invoke<void>("set_tags", { family, tags }),
  getFavorites: () => invoke<string[]>("get_favorites"),
  getNotes: () => invoke<Record<string, string>>("get_notes"),
  setNote: (family: string, note: string) => invoke<void>("set_note", { family, note }),
  /** 把「授权原文」写进备注：只在该字族没有备注、且从没自动写过时生效，返回真正写了的字族 */
  seedLicenseNotes: (items: { family: string; note: string }[]) =>
    invoke<string[]>("seed_license_notes", { items }),
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
  /** 改版权并同步库目录名；失败原因会放在 errors 里带回来（不再只写日志） */
  syncFamilyCopyright: (family: string, status: string) =>
    invoke<{
      renamed: number;
      errors: string[];
      reactivateFailed: string[];
    }>("sync_family_copyright", { family, status }),
  /**
   * 按证据重算全库字族目录名（v7 迁移用）。默认只预演，`dryRun: false` 才真改。
   * 只有证据给出明确分类才会改名，判不出来的目录原样保留。
   */
  resyncLibraryLabels: (dryRun = true) =>
    invoke<{
      dry_run: boolean;
      checked: number;
      changed: number;
      unchanged: number;
      no_evidence: number;
      errors: string[];
      items: { from: string; to: string; class: string }[];
    }>("resync_library_labels", { dryRun }),
  /** 批量问「这些字面有没有中文字形」，返回同序布尔数组 */
  fontCjk: (probes: [string, number][]) =>
    invoke<boolean[]>("font_cjk", { probes }),
  /**
   * 批量问汉字覆盖档位："none" 一个汉字都没有 / "sparse" 有但明显不全 / "full" 正常中文字体。
   *
   * 比 fontCjk 多一档：「只有几百个字」的字体拿它排标题可以、排正文会缺字，
   * 卡片上要能和「一个汉字都没有」区分开。
   */
  fontHanCoverage: (probes: [string, number][]) =>
    invoke<("none" | "sparse" | "full")[]>("font_han_coverage", { probes }),
  /**
   * 精确统计字符集构成（详情面板用）：cmap 总码位数 + 汉字 / 假名 / 谚文 / 拉丁各多少。
   * 要枚举全部码位，只对当前打开的那个字面调用。
   */
  fontCharset: (probes: [string, number][]) =>
    invoke<CharsetStats[]>("font_charset", { probes }),
  /**
   * 问「这些字面里有没有 chars 里每个字符的字形」，返回同序的布尔矩阵
   * （外层对应 probes，内层对应 chars 的码位顺序）。用来按示例文字的语言标注缺字。
   */
  fontCoverage: (probes: [string, number][], chars: string) =>
    invoke<boolean[][]>("font_coverage", { probes, chars }),
  /**
   * 浏览器打不开这个字面时，要一份「能预览」的副本。
   *
   * 两类字体 WebView2 必定加载失败：`.ttc` 字体集合（只认单面 sfnt），
   * 以及 cmap 只有 Big5 / GBK / ShiftJIS 等旧编码子表的老字体。
   * 后端会把字面抽出来、把旧编码翻成 Unicode 重建 cmap，返回缓存文件路径；
   * 浏览器本来就能打开、或修不出来时返回 null。
   */
  fontPreviewFile: (path: string, faceIndex: number, level = 0) =>
    invoke<string | null>("font_preview_file", { path, faceIndex, level }),
  /** 列表预览专用子集：只含 `chars` 的字体副本。null = 这份字体不适合子集（CFF/TTC/可变/太小/0 命中） */
  listPreviewFont: (path: string, faceIndex: number, chars: string) =>
    invoke<{ path: string; bytes: number } | null>("list_preview_font", {
      path,
      faceIndex,
      chars,
    }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  /** 按文件内容判断导出物（不看后缀）："library-pack" | "curation" | "snapshots" | "unknown" */
  detectFileKind: (path: string) => invoke<string>("detect_file_kind", { path }),
  /** 取出「双击导出文件启动」时暂存的待导入路径，只返回一次，取完即清空 */
  takePendingOpenFile: () => invoke<string | null>("take_pending_open_file"),
  /** 缩略图索引：目录 + 已有 key（§13）。启动时拉一次，卡片才能同步判断有没有图 */
  thumbIndex: () => invoke<{ dir: string; keys: string[] }>("thumb_index"),
  thumbPut: (key: string, data: number[]) =>
    invoke<string | null>("thumb_put", { key, data }),
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
  /**
   * 「全部导出」：把字体所在文件夹整体压成 zip（含同目录的授权书 / 版权说明）。
   * `scope === "family"` 表示字体就在字体库根目录、只打包了本字族。
   */
  exportFontFolder: (fontPath: string, dest: string, familyPaths: string[]) =>
    invoke<FolderExportReport>("export_font_folder", { fontPath, dest, familyPaths }),
  /**
   * 打包「整理数据 + 字体文件」成 `.FontManager`（超 2GB 自动分卷）。
   * `curation` 是整理数据的 json 原文，原样塞进包里，导入时再原样交回来合并。
   */
  exportLibraryPack: (dest: string, curation: string, createdAt: string) =>
    invoke<PackExportReport>("export_library_pack", { dest, curation, createdAt }),
  /** 解包：字体铺回字库（重复跳过），整理数据以字符串交回前端合并 */
  importLibraryPack: (src: string) =>
    invoke<PackImportReport>("import_library_pack", { src }),
  adobeAvailable: () => invoke<boolean>("adobe_available"),
  /**
   * 把字体库里与系统已安装字体重复的文件归置到 `<库>/_重复字体/`。
   * dryRun = true 只统计不移动（先给用户看「会动多少个」）。
   */
  dedupeFontLibrary: (dryRun: boolean) =>
    invoke<DedupeReport>("dedupe_font_library", { dryRun }),
  /** 按归置清单把搬走的字体原路退回（原位被占用则跳过，不覆盖） */
  restoreDedupedFonts: () => invoke<DedupeReport>("restore_deduped_fonts"),
  /**
   * 把字体应用到目标软件。
   * aliases 是「本地化族名」的候选串（如「思源宋体 CN」「思源宋体 CN Bold」）：
   * CorelDRAW 对中文字体一律用中文名登记，只给英文名会成片地找不到。
   */
  applyFontInApp: (
    app: AdobeApp,
    postscriptName: string,
    label: string,
    familyName: string,
    aliases?: string[],
  ) =>
    invoke<string>("apply_font_in_app", {
      app,
      postscriptName,
      label,
      familyName,
      aliases: aliases ?? [],
    }),
  appWarmState: () => invoke<AppWarm[]>("app_warm_state"),
  affinityLink: () => invoke<AffinityConnection | null>("affinity_link"),
  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),
  getAutostart: () => invoke<boolean>("get_autostart"),
  getPrefs: () => invoke<Record<string, unknown> | null>("get_prefs"),
  setPrefs: (prefs: Record<string, unknown>) => invoke<void>("set_prefs", { prefs }),
  fontsWithChar: (paths: string[], codepoint: number) =>
    invoke<string[]>("fonts_with_char", { paths, codepoint }),
  setUiScale: (scale: number | null) => invoke<number>("set_ui_scale", { scale }),

  // ── 1.3.0：本地 API 与插件 ──
  /** 本地 API 状态：是否开启 / 实际端口 / 访问令牌 / 是否允许危险写 */
  apiStatus: () => invoke<ApiStatus>("api_status"),
  apiSetEnabled: (enabled: boolean) => invoke<void>("api_set_enabled", { enabled }),
  /** 指定监听端口；0 = 自动。返回改完之后实际在用的端口 */
  apiSetPort: (port: number) => invoke<number>("api_set_port", { port }),
  apiSetDangerous: (on: boolean) => invoke<void>("api_set_dangerous", { on }),
  /** 重置令牌（旧令牌立即失效），返回新令牌 */
  apiResetToken: () => invoke<string>("api_reset_token"),
  pluginsList: () => invoke<PluginInfo[]>("plugins_list"),
  pluginSetEnabled: (id: string, enabled: boolean) =>
    invoke<void>("plugin_set_enabled", { id, enabled }),
  /** 调插件钩子（右键菜单项用 context-menu） */
  pluginInvoke: (id: string, hook: string, payload: Record<string, unknown>) =>
    invoke<void>("plugin_invoke", { id, hook, payload }),
  pluginsOpenDir: () => invoke<void>("plugins_open_dir"),
  /** 拖入的 zip 是不是插件包（1.4.4）：有 plugin.json 就是 */
  pluginProbeZip: (path: string) =>
    invoke<{ isPlugin: boolean; root: string; id: string; name: string; version: string }>(
      "plugin_probe_zip",
      { path },
    ),
  /** 从 zip 安装/更新插件：更新只覆盖代码，config/secret/state 原样保留 */
  pluginInstallZip: (path: string) =>
    invoke<{ id: string; name: string; version: string }>("plugin_install_zip", { path }),

  /** 插件运行时状态（1.4.11）：内置/系统版本、占用、被哪些插件使用 */
  runtimesStatus: () =>
    invoke<RuntimeStatus[]>("runtimes_status"),
  /** 删除内置运行时：正在运行的插件占用 exe 会被后端拦下 */
  runtimeDelete: (kind: string) => invoke<void>("runtime_delete", { kind }),
  /** 从 GitHub release 下载运行时补全；进度监听 `runtime:progress` 事件 */
  runtimeDownload: (kind: string) => invoke<void>("runtime_download", { kind }),
};

/** 一个插件运行时（Python / Node）的状态（`runtimes_status`） */
export interface RuntimeStatus {
  kind: "python" | "node";
  label: string;
  /** 内置运行时目录；null = 本机没装（可下载补全） */
  bundledDir: string | null;
  /** 内置运行时真实版本（探活），如 "Python 3.13.14" */
  bundledVersion: string | null;
  /** 占用 MB */
  bundledSizeMb: number | null;
  /** 系统里另外探测到的解释器版本，null = 没有 */
  systemVersion: string | null;
  /** 会用到这个运行时的插件名 */
  pluginsUsing: string[];
  /** 其中正在运行的数量（删除前会被后端拦） */
  pluginsRunning: number;
}

/** `runtime:progress` 事件载荷 */
export interface RuntimeProgress {
  kind: string;
  phase: "download" | "extract" | "done" | "error";
  received?: number;
  total?: number;
  percent?: number;
  error?: string;
}

/** 本地 API 状态（`api_status`） */
export interface ApiStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  /** 用户指定的端口（0 = 自动）；与 port 不同说明指定端口被占用、已回退 */
  requestedPort?: number;
  token: string;
  dangerous: boolean;
  base: string;
  version?: string;
}

/** 插件清单里的一项（`plugins_list`） */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  /** 一句话短介绍（卡片小字用）；没有就回落到 description */
  summary: string | null;
  /** 完整介绍（悬停气泡用） */
  description: string | null;
  permissions: string[];
  hooks: string[];
  menus: { title: string; on: string }[];
  /** 插件自己声明了设置面板（`plugin.json` 的 `settings`）；没有就是 null */
  settings: PluginSettings | null;
  dir: string;
  enabled: boolean;
  running: boolean;
  error: string | null;
}

/** 插件的设置面板声明：主程序点齿轮时会把 `settings.hook` 钩子发给插件，由插件自己弹面板 */
export interface PluginSettings {
  /** 面板标题（齿轮按钮的 tooltip；留空用插件名） */
  title: string | null;
  /** 主程序要调的钩子名，默认 "settings" */
  hook: string;
}

/** `export_font_folder` 的结果 */
export interface FolderExportReport {
  dest: string;
  root: string;
  /** folder=整个文件夹 / family=字族文件（字体在库根）/ single=系统字体只打包这一份 */
  scope: "folder" | "family" | "single";
  files: number;
  bytes: number;
  zipBytes: number;
  skipped: number;
}
