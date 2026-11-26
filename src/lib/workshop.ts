/**
 * 插件中心（M1）纯逻辑层：index.json 解析、筛选、人类可读大小、版本比较。
 *
 * 这一文件**不碰 React 也不碰 IPC** —— 全部是可单测的纯函数
 * （tests/workshop.test.ts）。插件中心面板的组件侧在 `src/workshop/`（独立 vite
 * 入口，**不进主 bundle**）；这份纯函数被面板与测试共用。
 *
 * 数据来源：Manager-Workshop 仓库的 `by-app/fm.json`（registry 按软件切片，
 * 客户端唯一请求；方案 §5）。真实结构以仓库为准，这里按方案 §3 的字段
 * 做**宽容解析**：缺字段给默认值、类型不对就丢弃该条 —— registry 是
 * 社区数据，解析端崩了等于整个插件中心白屏（M1 验收红线）。
 */

/** 社区件的逐文件清单（官方件是整包 zip，没有这个） */
export interface WorkshopFile {
  /** 相对插件目录的路径（registry CI 保证无越界；安装端还会再验一遍） */
  path: string;
  sha256: string;
  url: string;
  /** 字节；0 = 未知（未知就跳过大小复核，只认 sha256） */
  size: number;
}

export type WorkshopRuntime = "python" | "node" | null;

/**
 * 插件 ID 规范：`FM-<字母数字>-<字母数字>`（2026-11-26 用户口径）。
 *
 * 为什么要统一前缀：插件库是**跨软件共用**的，`FM` 一眼就能看出这是 FontManager 的
 * 插件；别的软件（AssetManager 等）用自己的前缀，同一个仓库里不会互相抢名字，
 * 聚合清单也能按前缀分拣。所以插件中心**只认这一种命名**，其余一条都不显示。
 *
 * - 前缀 `FM` **必须大写**（它就是软件的编号，不是可选的写法）；
 * - 两段各自是任意长度的字母或数字（大小写随意），如 `FM-ADOBE-FONT`、`FM-001-abc`；
 * - 整串不超过 {@link PLUGIN_ID_MAX}：目录名 = `<id>__<作者>`，太长会在 Windows 上撞 255。
 */
export const PLUGIN_ID_RE = /^FM-[A-Za-z0-9]+-[A-Za-z0-9]+$/;
export const PLUGIN_ID_MAX = 40;

/** 这个字符串是不是合规的插件 ID（`FM-XXX-XXX`）。上传校验与清单过滤共用一条口径 */
export function isPluginId(id: string): boolean {
  const s = id.trim();
  return s.length <= PLUGIN_ID_MAX && PLUGIN_ID_RE.test(s);
}

/** index.json 里的一条插件卡片（官方 / 社区同构，社区件多 dir + files） */
export interface WorkshopEntry {
  id: string;
  name: string;
  /** ≤200 字短介绍（卡片截断显示） */
  brief: string;
  /** ≤1000 字详细说明（详情弹层全文） */
  detail: string;
  author: string;
  official: boolean;
  version: string;
  runtime: WorkshopRuntime;
  minAppVersion: string | null;
  lang: string | null;
  /** 官方件：release zip 直链（公开资产，免登录）；社区件为 null */
  download: string | null;
  /** 包总大小（字节）；0 = 未知 */
  size: number;
  /** 社区件：registry 里的目录名 `<id>__<author>` */
  dir: string | null;
  /** 社区件：逐文件清单（sha256 校验后写入插件目录） */
  files: WorkshopFile[] | null;
  /** 权限清单（index.json 是否携带以仓库为准；缺省按空清单处理） */
  permissions: string[];
}

export interface WorkshopIndex {
  /** registry 清单格式版本；老仓库可能没有 */
  version: string | null;
  /** CI 聚合时间（ISO 串）；老仓库可能没有 */
  generatedAt: string | null;
  /** 官方 + 社区合并后的卡片列表（官方在前） */
  entries: WorkshopEntry[];
}

// ── 宽容解析 ────────────────────────────────────────────────────────────

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Math.max(0, Number(v));
  }
  return 0;
}

function asRuntime(v: unknown): WorkshopRuntime {
  return v === "python" || v === "node" ? v : null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asFiles(v: unknown): WorkshopFile[] | null {
  if (!Array.isArray(v)) return null;
  const files: WorkshopFile[] = [];
  for (const raw of v) {
    if (typeof raw !== "object" || raw === null) continue;
    const o = raw as Record<string, unknown>;
    const path = asString(o.path);
    const url = asString(o.url);
    // path/url 缺一个就没法装：丢文件比丢整条卡片温和，丢条目会让 id 断档
    if (!path || !url) continue;
    files.push({
      path,
      url,
      sha256: asString(o.sha256),
      size: asNumber(o.size),
    });
  }
  return files;
}

function parseEntry(raw: unknown, forceOfficial: boolean): WorkshopEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = asString(o.id).trim();
  // id 是安装目录名与「已安装」判定的锚点，没有它这条卡片就是死数据
  if (!id) return null;
  // 只认 `FM-XXX-XXX`：合规性由 registry 的 CI 在上传时把关，这里再挡一次 ——
  // 老仓库里遗留的 `font-sync` 这类条目会在转型期**直接不显示**，而不是让它们
  // 混进中心、和跨软件共用的命名空间打架。
  if (!isPluginId(id)) return null;
  return {
    id,
    name: asString(o.name, id),
    brief: asString(o.brief),
    detail: asString(o.detail),
    author: asString(o.author).trim(),
    // 官方区条目无条件盖 official 章（官方区的存在本身就是语义）
    official: forceOfficial || o.official === true,
    version: asString(o.version),
    runtime: asRuntime(o.runtime),
    minAppVersion: typeof o.minAppVersion === "string" && o.minAppVersion ? o.minAppVersion : null,
    lang: typeof o.lang === "string" && o.lang ? o.lang : null,
    download: typeof o.download === "string" && o.download ? o.download : null,
    size: asNumber(o.size),
    dir: typeof o.dir === "string" && o.dir ? o.dir : null,
    files: asFiles(o.files),
    permissions: asStringArray(o.permissions),
  };
}

/**
 * 解析 registry index.json。**永不抛错**：结构不对就返回空清单，
 * 让页面走到「没有匹配的插件」而不是白屏。
 */
export function parseWorkshopIndex(raw: unknown): WorkshopIndex {
  if (typeof raw !== "object" || raw === null) {
    return { version: null, generatedAt: null, entries: [] };
  }
  const o = raw as Record<string, unknown>;
  const official = Array.isArray(o.official)
    ? o.official.map((e) => parseEntry(e, true)).filter((e): e is WorkshopEntry => e !== null)
    : [];
  const community = Array.isArray(o.plugins)
    ? o.plugins.map((e) => parseEntry(e, false)).filter((e): e is WorkshopEntry => e !== null)
    : [];
  return {
    // registry 可能用数字当清单格式版本：宽容收下
    version:
      typeof o.version === "string" || typeof o.version === "number"
        ? String(o.version)
        : null,
    generatedAt: typeof o.generatedAt === "string" ? o.generatedAt : null,
    entries: [...official, ...community],
  };
}

/** 解析并抛错的变体：store 拿到非法 JSON 时要给用户一句人话错误 */
export function parseWorkshopIndexStrict(text: string): WorkshopIndex {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("index.json 不是合法 JSON");
  }
  const parsed = parseWorkshopIndex(raw);
  if (parsed.entries.length === 0) {
    throw new Error("index.json 里没有任何插件条目");
  }
  return parsed;
}

// ── 筛选 ────────────────────────────────────────────────────────────────

export type WorkshopKindFilter = "all" | "official" | "community";
export type WorkshopRuntimeFilter = "any" | "python" | "node" | "none";

export interface WorkshopFilters {
  query: string;
  kind: WorkshopKindFilter;
  runtime: WorkshopRuntimeFilter;
  installedOnly: boolean;
  /** 本机已安装插件的 id 集合（来自 plugins_list） */
  installedIds: ReadonlySet<string>;
}

/** 搜索框命中：名称 / 简介 / 作者（大小写不敏感的子串匹配，与在线页同口径） */
export function matchesWorkshopQuery(e: WorkshopEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    e.name.toLowerCase().includes(q) ||
    e.brief.toLowerCase().includes(q) ||
    e.author.toLowerCase().includes(q)
  );
}

export function applyWorkshopFilters(
  entries: WorkshopEntry[],
  f: WorkshopFilters,
): WorkshopEntry[] {
  return entries.filter((e) => {
    if (!matchesWorkshopQuery(e, f.query)) return false;
    if (f.kind === "official" && !e.official) return false;
    if (f.kind === "community" && e.official) return false;
    if (f.runtime === "python" && e.runtime !== "python") return false;
    if (f.runtime === "node" && e.runtime !== "node") return false;
    if (f.runtime === "none" && e.runtime !== null) return false;
    if (f.installedOnly && !f.installedIds.has(e.id)) return false;
    return true;
  });
}

// ── 展示辅助 ────────────────────────────────────────────────────────────

/**
 * 人类可读大小。0 视为「未知」返回 null —— 0 是真实存在的大小，
 * 但 registry 没写大小的时候前端无从区分，统一按未知处理、卡片上不显示。
 */
export function humanBytes(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let value = n;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 作者徽标文案：官方条目由界面显示「官方」徽标（i18n），这里只管社区作者 */
export function workshopAuthorLabel(e: WorkshopEntry): string {
  if (e.official) return "";
  // 匿名上传：方案 §1 —— 作者显示 anonymous
  return e.author || "anonymous";
}

/**
 * 社区件安装目标目录名。
 *
 * registry 的 `dir` 字段是**仓库相对路径**（如 `plugins/font-renamer__alice`），
 * 落到插件目录里只用**最后一段**（目录名本身）—— 中间那段是 registry 仓库的
 * 目录结构，跟主程序的插件目录布局无关。
 *
 * registry 没给 dir 时按 `<id>__<author>` 拼。
 */
/**
 * 目录名安全检查（与 Rust 侧 `safe_dir_name` **同口径**）：
 * 只允许 ASCII 字母数字与 `-` `_` `.`，长度 ≤ 120，且不能以 `.` 开头。
 */
export function isSafeDirName(dir: string): boolean {
  if (dir.length === 0 || dir.length > 120) return false;
  if (!/^[A-Za-z0-9._-]+$/.test(dir)) return false;
  return !dir.startsWith(".");
}

/**
 * registry 的 `dir` 字段 → 本机插件目录名。
 *
 * 与 Rust 侧 `dir_name_of` **同口径、同语义**：非法就返回 `null`，**绝不静默纠正**。
 * - `dir` 缺省 → 用 `<id>__<author>` 兜底（Rust 侧还会再校验一次）
 * - 含 `\` 或 `:`（Windows 分隔符 / 盘符 / NTFS 数据流）→ null
 * - 任一段含 `..` 或为 `.` → null（路径穿越）
 * - 末段为空或不过 {@link isSafeDirName} → null
 *
 * 为什么「拒绝」而不是「纠正」：静默把 `plugins/../evil` 压成 `evil`，等于替上游
 * 把异常吞了 —— 排查时看不到任何痕迹，而清单是远程可写的。Rust 侧是同一套规则，
 * 两边都用「拒绝」，边界才一致。
 */
export function communityDirFor(e: WorkshopEntry): string | null {
  const raw = (e.dir ?? "").trim();
  if (raw.length === 0) {
    // 清单没给 dir → 按 id__author 拼（Rust 侧同样口径）
    const fallback = `${e.id}__${e.author || "anonymous"}`;
    return isSafeDirName(fallback) ? fallback : null;
  }
  if (raw.includes("\\") || raw.includes(":")) return null;
  for (const seg of raw.split("/")) {
    if (seg.includes("..") || seg === ".") return null;
  }
  // 取最后一段（不过滤空段）：`plugins/` 的末段是空 → 走 null，不回落
  const last = (raw.split("/").pop() ?? "").trim();
  if (last.length === 0 || !isSafeDirName(last)) return null;
  return last;
}

/**
 * 语义化版本比较（只比较点分数字段；缺失段按 0）。
 * 返回负数 = a < b，0 = 相等，正数 = a > b。
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((s) => parseInt(s, 10));
  const pb = b.split(/[.\-+]/).map((s) => parseInt(s, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    // Number.isNaN(undefined) 是 false：短的一边越界拿到 undefined，
    // 必须按「缺段 = 0」处理，否则 2.1 vs 2.1.0 会算出 NaN
    const va = Number.isFinite(pa[i]) ? pa[i] : 0;
    const vb = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/** 本机版本是否满足插件要求的最低版本（缺 minAppVersion = 不设限） */
export function meetsMinAppVersion(current: string, min: string | null): boolean {
  if (!min) return true;
  return compareVersions(current, min) >= 0;
}

/**
 * 清单里的版本是否**比本机装的更新** —— 插件中心「更新」按钮的唯一判据。
 *
 * 2026-11-19 用户要求：插件有新版本时，中心里对应的插件要直接给一个更新按钮，
 * 不要让用户先卸载再装（那会把设置/状态一起丢掉，还要重新找一遍）。
 *
 * 三种情况都返回 false，且都不该出现「更新」按钮：
 * - 本机没装（那是「安装」）；
 * - 清单没写版本（判不了，不能猜）；
 * - 两边一样或本机更新（开发中的本地版本不该被降级）。
 * 版本串带 `v` 前缀要能认（社区件的 plugin.json 有人这么写）。
 */
export function hasUpdate(
  remoteVersion: string | null | undefined,
  installedVersion: string | null | undefined,
): boolean {
  const norm = (s: string | null | undefined): string =>
    String(s ?? "").trim().replace(/^[vV]/, "");
  const remote = norm(remoteVersion);
  const local = norm(installedVersion);
  if (!remote || !local) return false;
  return compareVersions(remote, local) > 0;
}

/**
 * 会改动**字体库文件夹本身**的权限。
 *
 * 2026-11-15 用户要求：凡是有这类能力的插件，中心面板一律要在下载前提示 ——
 * 删除字体、往库里加文件、改字体文件、移动/调整字体库目录，都属于这类。
 * 目前权限表里对应的是这两个（`write:fonts` 含启停/重扫/删除/移动，`import` 是往库里写文件）。
 *
 * 判定**只看 permissions**，不让插件自己声明「我安全」—— 自述的信不过，
 * 权限才是运行时真的会签发的东西（`api.rs` 的 PERMS）。
 */
export const FONT_LIBRARY_PERMS = ["write:fonts", "import"] as const;

/** 这个插件会不会动用户的字体库文件夹 */
export function touchesFontLibrary(permissions?: string[] | null): boolean {
  if (!permissions || permissions.length === 0) return false;
  return permissions.some((p) => (FONT_LIBRARY_PERMS as readonly string[]).includes(p));
}
