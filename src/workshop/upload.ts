/**
 * 插件上传（M3）：校验 + GitHub 建 PR。
 *
 * 两条线分开：
 * - `validatePlugin()` **纯函数**：规则照抄 registry 的 `.github/scripts/validate_plugins.py`
 *   （id 正则 / 后缀白名单 / 体积 / 权限白名单 / entry 在 files 里 / 路径安全）。
 *   在本地先拦一遍，别让用户等 CI 红灯才知道少填了字段。
 * - `uploadPlugin()`：fork → blob → tree → commit → ref → PR。全走 api.github.com，
 *   面板是 webview，GitHub API 带 `Access-Control-Allow-Origin: *`，可以直接 fetch。
 *
 * 这里**不写 plugin.json 的 sha256**：清单要登记自己，写哈希就自指了。
 * registry 的聚合脚本（aggregate_index.py）会在合并后统一算，客户端只给 `path`。
 */

const OWNER = "706972745";
const REPO = "FontManager-Workshop";
const UPSTREAM_API = `/repos/${OWNER}/${REPO}`;

/** 与 validate_plugins.py 同口径（改这里 = 改上传规则） */
/* id 允许点号：主程序里插件 id 是 Java 包名式（com.iieozo.adobe-font），
   registry 只认 a-z0-9- 会把这类插件全挡在门外。首尾仍要求字母/数字。 */
const ID_RE = /^[a-z0-9](?:[a-z0-9.-]{0,38}[a-z0-9])$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PLUGIN_BYTES = 20 * 1024 * 1024;
const MAX_BRIEF = 200;
const MAX_DETAIL = 1000;

/** 主程序 `api.rs` 的 PERMS —— 名单外的名字运行时会被静默丢弃 */
export const PERMS = [
  "read:fonts",
  "write:fonts",
  "read:snapshot",
  "write:snapshot",
  "read:curation",
  "write:curation",
  "export",
  "import",
  "write:apply",
  "read:apps",
] as const;

/**
 * registry 收的文件后缀。**顺序就是提示里列出来的顺序** ——
 * 报「类型不在白名单」时把它塞进 `uploadAllowedExt` 给用户看，
 * 别让人自己回去翻文档。
 */
export const ALLOWED_EXTS: readonly string[] = [
  ".py", ".js", ".mjs", ".cjs", ".ts",
  // 原生插件：主程序 `runtime: "exe"` 直接起进程，与脚本插件同一套 stdio 协议
  ".exe", ".dll",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg",
  ".md", ".txt", ".csv", ".tsv",
  ".html", ".htm", ".css", ".svg",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico",
  ".woff", ".woff2", ".ttf", ".otf",
];
const ALLOWED_EXT = new Set(ALLOWED_EXTS);
/** 入口后缀：.py/.js 走解释器，.exe 是原生插件（runtime 留空即可） */
const ENTRY_EXT = new Set([".py", ".js", ".mjs", ".cjs", ".exe"]);

/** 一个待上传的文件（path 相对插件根，不含顶层目录名） */
export interface PickedFile {
  path: string;
  size: number;
  bytes: Uint8Array;
}

export interface PluginForm {
  id: string;
  name: string;
  entry: string;
  version: string;
  apiLevel: number;
  permissions: string[];
  brief: string;
  detail: string;
  runtime: "python" | "node" | null;
  lang: string;
  minAppVersion: string;
}

export interface Issue {
  level: "error" | "warn";
  /** i18n 键；`vars` 里的内容原样替换 */
  key: string;
  vars?: Record<string, string | number>;
}

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i <= 0 ? "" : path.slice(i).toLowerCase();
}

/** 与 Rust `safe_rel_path` / validate 的同一条：相对、无越界、无盘符、无反斜杠 */
export function safeRelPath(rel: string): boolean {
  if (!rel || rel.startsWith("/") || rel.startsWith("\\")) return false;
  if (rel.includes("\\") || rel.includes(":")) return false;
  return rel.split("/").every((p) => p !== "" && p !== "." && p !== "..");
}

/** 从 `<input webkitdirectory>` 的 FileList 拆出相对路径 */
/**
 * 主程序读回来的文件（base64）→ 待上传文件。
 *
 * 超过上限的文件 Rust 侧故意不给内容（`content` 是空串），这里照原样保留 `bytes` 为空 ——
 * 本地校验会按 `size` 报「文件太大」，用户不会走到上传那步。
 */
export function pickedFromApp(raw: { path: string; size: number; content: string }[]): PickedFile[] {
  return raw.map((f) => ({ path: f.path, size: f.size, bytes: fromBase64(f.content) }));
}

function fromBase64(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 目录里已有的 plugin.json（有就用来预填表单） */
export function readManifest(files: PickedFile[]): Partial<PluginForm> | null {
  const mf = files.find((f) => f.path === "plugin.json");
  if (!mf) return null;
  try {
    const text = new TextDecoder("utf-8").decode(mf.bytes);
    const raw = JSON.parse(text) as Record<string, unknown>;
    const out: Partial<PluginForm> = {};
    if (typeof raw.id === "string") out.id = raw.id;
    if (typeof raw.name === "string") out.name = raw.name;
    if (typeof raw.entry === "string") out.entry = raw.entry;
    if (typeof raw.version === "string") out.version = raw.version;
    if (typeof raw.apiLevel === "number") out.apiLevel = raw.apiLevel;
    if (Array.isArray(raw.permissions)) {
      out.permissions = raw.permissions.filter((p): p is string => typeof p === "string");
    }
    if (typeof raw.brief === "string") out.brief = raw.brief;
    if (typeof raw.detail === "string") out.detail = raw.detail;
    // runtime 是 `"python" | "node" | null`：unknown 必须逐值收窄，不能直接赋值
    if (raw.runtime === "python" || raw.runtime === "node") out.runtime = raw.runtime;
    else if (raw.runtime === null || raw.runtime === undefined) out.runtime = null;
    if (typeof raw.lang === "string") out.lang = raw.lang;
    if (typeof raw.minAppVersion === "string") out.minAppVersion = raw.minAppVersion;
    return out;
  } catch {
    return null;
  }
}

/** 本地校验：返回所有问题（错误必须清零才允许上传） */
export function validatePlugin(form: PluginForm, files: PickedFile[]): Issue[] {
  const issues: Issue[] = [];
  const err = (key: string, vars?: Record<string, string | number>) =>
    issues.push({ level: "error", key, vars });
  const warn = (key: string, vars?: Record<string, string | number>) =>
    issues.push({ level: "warn", key, vars });

  if (!ID_RE.test(form.id.trim())) err("uploadErrId");
  if (!form.name.trim()) err("uploadErrName");
  if (!SEMVER_RE.test(form.version.trim())) err("uploadErrVersion");
  if (!form.brief.trim() || form.brief.length > MAX_BRIEF) err("uploadErrBrief", { max: MAX_BRIEF });
  if (form.detail.length > MAX_DETAIL) err("uploadErrDetail", { max: MAX_DETAIL });
  if (!Number.isInteger(form.apiLevel) || form.apiLevel < 1) err("uploadErrApiLevel");
  else if (form.apiLevel > 1) warn("uploadErrApiLevelHigh", { level: form.apiLevel });

  if (files.length === 0) err("uploadErrNoFiles");

  const bad = form.permissions.filter((p) => !(PERMS as readonly string[]).includes(p));
  if (bad.length) err("uploadErrPerms", { names: bad.join(", ") });
  if (new Set(form.permissions).size !== form.permissions.length) warn("uploadErrPermsDup");

  const paths = new Set(files.map((f) => f.path));
  if (!safeRelPath(form.entry)) err("uploadErrEntryPath");
  else {
    if (!paths.has(form.entry)) err("uploadErrEntryMissing", { entry: form.entry });
    if (!ENTRY_EXT.has(extOf(form.entry))) err("uploadErrEntryExt", { entry: form.entry });
  }

  let total = 0;
  for (const f of files) {
    if (!safeRelPath(f.path)) err("uploadErrPathUnsafe", { path: f.path });
    const ext = extOf(f.path);
    if (!ALLOWED_EXT.has(ext)) err("uploadErrExt", { path: f.path, ext: ext || "(none)" });
    if (f.size > MAX_FILE_BYTES) err("uploadErrFileSize", { path: f.path, max: 10 });
    total += f.size;
  }
  if (total > MAX_PLUGIN_BYTES) err("uploadErrTotalSize", { mb: String(Math.round(total / 1048576)) });

  return issues;
}

// ───────────────────────── GitHub ─────────────────────────

export class GhError extends Error {
  readonly status: number;
  readonly apiMessage: string;

  constructor(status: number, apiMessage: string) {
    super(apiMessage || `HTTP ${status}`);
    this.name = "GhError";
    this.status = status;
    this.apiMessage = apiMessage;
  }
}

async function gh<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // 非 JSON（代理拦了 / 网关页）
  }
  if (!res.ok) {
    const msg = (data as { message?: string } | null)?.message ?? text.slice(0, 160);
    throw new GhError(res.status, msg);
  }
  return data as T;
}

/** 404 当「没有」而不是错误（查 fork 用） */
async function ghOrNull<T>(token: string, path: string): Promise<T | null> {
  try {
    return await gh<T>(token, path);
  } catch (e) {
    if (e instanceof GhError && e.status === 404) return null;
    throw e;
  }
}

/**
 * 「这句话得由界面翻译」的错误。
 *
 * 上传流程里有些失败是软件自己造的（还没选插件、fork 没就绪），
 * 直接 `throw new Error("中文句子")` 的话，界面在英文/日文环境下
 * 会冒出一句中文 —— 用户看到的每一句都必须是**当时选的语言**。
 * 带 key 抛出去，由对话框用 `t(key)` 落地。
 */
export class UploadMessage extends Error {
  constructor(readonly key: string) {
    super(key);
    this.name = "UploadMessage";
  }
}

export interface WhoAmI {
  login: string;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type UploadPhase = "fork" | "upload" | "commit" | "pr";

export interface UploadResult {
  prUrl: string;
  prNumber: number;
  branch: string;
}

/** 一次上传里的一个插件 */
export interface UploadItem {
  /** 清单里署的名字：一般就是 login；匿名上传时是 `anonymous-xxxx` */
  author: string;
  form: PluginForm;
  files: PickedFile[];
}

export interface UploadArgs {
  token: string;
  login: string;
  /** 1 个或多个插件：**同一个 PR、同一个 commit**（用户要求可批量上传） */
  items: UploadItem[];
  onPhase: (phase: UploadPhase, done?: number, total?: number) => void;
}

/**
 * 走一遍完整上传：fork → 同步 main → 逐文件 blob → tree → commit → ref → PR。
 *
 * 多个插件共用**一次**提交：tree 的 entries 按 `plugins/<id>__<author>/...` 铺开，
 * 一个 PR 里带上全部目录。为什么不一个插件一个 PR：GitHub 上连着开 5 个 PR
 * 你要点 5 次合并，而它们本来是同一批东西。
 *
 * 为什么用 Git Data API 而不是 GitHub 网页那套：面板里没有 git 命令行，
 * 一次提交多个文件只能自己拼 tree。
 */
export async function uploadPlugins(args: UploadArgs): Promise<UploadResult> {
  const { token, login, items, onPhase } = args;
  if (items.length === 0) throw new UploadMessage("uploadErrEmpty");
  const first = items[0];
  // 分支名用第一个插件 + 时间戳；批量时也只建一条分支
  const branch = `upload/${first.form.id}-${Date.now()}`;
  const dirs = items.map((it) => `${it.form.id}__${it.author.trim() || login}`);

  // ① 上游 main 的提交与树（我们的新 tree 以它为 base，只加自己这一层目录）
  const upRef = await gh<{ object: { sha: string } }>(
    token,
    `${UPSTREAM_API}/git/ref/heads/main`,
  );
  const upstreamSha = upRef.object.sha;
  const upCommit = await gh<{ tree: { sha: string } }>(
    token,
    `${UPSTREAM_API}/git/commits/${upstreamSha}`,
  );
  const upstreamTree = upCommit.tree.sha;

  // ② 我的 fork：没有就建一个，建完要等它真的出现（GitHub 那边是异步的）
  onPhase("fork");
  let mine = await ghOrNull<{ name: string }>(token, `/repos/${login}/${REPO}`);
  if (!mine) {
    await gh(token, `${UPSTREAM_API}/forks`, { method: "POST", body: "{}" });
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      mine = await ghOrNull<{ name: string }>(token, `/repos/${login}/${REPO}`);
      if (mine) break;
    }
    if (!mine) throw new UploadMessage("uploadErrFork");
  }

  // ③ 把 fork 的 main 对齐到上游：不对齐的话 PR 里会混进别人已经合进去的改动
  const mineRef = await ghOrNull<{ object: { sha: string } }>(
    token,
    `/repos/${login}/${REPO}/git/ref/heads/main`,
  );
  if (!mineRef || mineRef.object.sha !== upstreamSha) {
    await gh(token, `/repos/${login}/${REPO}/git/refs/heads/main`, {
      method: "PATCH",
      body: JSON.stringify({ sha: upstreamSha, force: true }),
    });
  }

  // ④ 逐文件建 blob（大目录会慢，进度回给界面）
  //    每个插件都要额外写一份 plugin.json，所以总步数 = 文件数 + 插件数
  const totalSteps = items.reduce((n, it) => n + it.files.length + 1, 0);
  let done = 0;
  const entries: { path: string; mode: string; type: string; sha: string }[] = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const dir = dirs[i];
    for (const f of it.files) {
      const created = await gh<{ sha: string }>(token, `/repos/${login}/${REPO}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: toBase64(f.bytes), encoding: "base64" }),
      });
      entries.push({
        path: `plugins/${dir}/${f.path}`,
        mode: "100644",
        type: "blob",
        sha: created.sha,
      });
      done += 1;
      onPhase("upload", done, totalSteps);
    }

    // ⑤ 清单本身也要进包里（运行时解析的就是它）
    const manifest = buildManifest(it.form, it.author.trim() || login, it.files.map((f) => f.path));
    const manifestBlob = await gh<{ sha: string }>(token, `/repos/${login}/${REPO}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({
        content: toBase64(new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n")),
        encoding: "base64",
      }),
    });
    entries.push({
      path: `plugins/${dir}/plugin.json`,
      mode: "100644",
      type: "blob",
      sha: manifestBlob.sha,
    });
    done += 1;
    onPhase("upload", done, totalSteps);
  }

  // ⑥ tree：一次铺开所有插件目录（base 是上游 main，不带上别人已合的改动）
  onPhase("commit");
  const tree = await gh<{ sha: string }>(token, `/repos/${login}/${REPO}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: upstreamTree, tree: entries }),
  });

  const title =
    items.length === 1
      ? `[upload] ${first.form.name} v${first.form.version} by ${login}`
      : `[upload] ${items.length} 个插件 by ${login}`;
  const commit = await gh<{ sha: string }>(token, `/repos/${login}/${REPO}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: title,
      tree: tree.sha,
      parents: [upstreamSha],
    }),
  });

  // ⑦ 分支（同名分支理论上不会撞：名字带毫秒时间戳；撞了就 PATCH 覆盖）
  try {
    await gh(token, `/repos/${login}/${REPO}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
    });
  } catch (e) {
    if (e instanceof GhError && e.status === 422) {
      await gh(token, `/repos/${login}/${REPO}/git/refs/heads/${branch}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha, force: true }),
      });
    } else throw e;
  }

  // ⑧ 开 PR（对上游）：多个插件仍是**一个** PR，正文里逐个列清
  onPhase("pr");
  const pr = await gh<{ html_url: string; number: number }>(token, `${UPSTREAM_API}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title,
      head: `${login}:${branch}`,
      base: "main",
      body: buildPrBody(items, login),
    }),
  });

  return { prUrl: pr.html_url, prNumber: pr.number, branch };
}

/**
 * 下架（删除）自己上传过的插件 —— 走「以删除方式建一个 PR」。
 *
 * 归属**只看目录名后缀是不是当前登录名**（`plugins/<id>__<login>`）：
 * 换任何一台电脑登录同一个账号，后缀一样，所以既能覆盖更新、也能在这里下架。
 * 不需要「记住这台电脑」，也不需要本机记录 —— 账号就是身份。
 *
 * 客户端判一次只是为了给「不是你的」一句清楚的话；真正的闸门仍在 CI 的作者
 * 校验与人工合并。
 */
export async function deletePlugins(args: DeleteArgs): Promise<UploadResult> {
  const { token, login, dirs, onPhase } = args;
  if (dirs.length === 0) throw new UploadMessage("uploadErrEmpty");
  for (const d of dirs) {
    const cut = d.lastIndexOf("__");
    const owner = cut >= 0 ? d.slice(cut + 2) : "";
    if (owner !== login) throw new UploadMessage("uploadErrNotOwner");
  }
  const branch = `remove/${dirs[0].replace(/__.*/, "")}-${Date.now()}`;

  const upRef = await gh<{ object: { sha: string } }>(
    token,
    `${UPSTREAM_API}/git/ref/heads/main`,
  );
  const upstreamSha = upRef.object.sha;
  const upCommit = await gh<{ tree: { sha: string } }>(
    token,
    `${UPSTREAM_API}/git/commits/${upstreamSha}`,
  );
  const upstreamTree = upCommit.tree.sha;

  // 我的 fork（复用上传那条路：没有就建、建完等它出现）
  onPhase("fork");
  let mineRepo = await ghOrNull<{ name: string }>(token, `/repos/${login}/${REPO}`);
  if (!mineRepo) {
    await gh(token, `${UPSTREAM_API}/forks`, { method: "POST", body: "{}" });
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      mineRepo = await ghOrNull<{ name: string }>(token, `/repos/${login}/${REPO}`);
      if (mineRepo) break;
    }
    if (!mineRepo) throw new UploadMessage("uploadErrFork");
  }
  const mineRef = await ghOrNull<{ object: { sha: string } }>(
    token,
    `/repos/${login}/${REPO}/git/ref/heads/main`,
  );
  if (!mineRef || mineRef.object.sha !== upstreamSha) {
    await gh(token, `/repos/${login}/${REPO}/git/refs/heads/main`, {
      method: "PATCH",
      body: JSON.stringify({ sha: upstreamSha, force: true }),
    });
  }

  // 目录下每个文件各来一条 `sha: null` —— 比「删目录」稳（tree API 对 tree 类型的
  // null 条目行为在官方文档里说得含糊，逐 blob 删除是明确的）
  onPhase("commit");
  const flat = await gh<{ tree: { path: string; type: string }[]; truncated: boolean }>(
    token,
    `${UPSTREAM_API}/git/trees/${upstreamTree}?recursive=1`,
  );
  if (flat.truncated) throw new UploadMessage("uploadErrTreeTooBig");
  const entries = flat.tree
    .filter((e) => e.type === "blob" && dirs.some((d) => e.path.startsWith(`plugins/${d}/`)))
    .map((e) => ({ path: e.path, mode: "100644", type: "blob", sha: null }));
  if (entries.length === 0) throw new UploadMessage("uploadErrNotFound");

  const tree = await gh<{ sha: string }>(token, `/repos/${login}/${REPO}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: upstreamTree, tree: entries }),
  });

  const title = dirs.length === 1 ? `[remove] ${dirs[0]} by ${login}` : `[remove] ${dirs.length} 个插件 by ${login}`;
  const commit = await gh<{ sha: string }>(token, `/repos/${login}/${REPO}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message: title, tree: tree.sha, parents: [upstreamSha] }),
  });
  try {
    await gh(token, `/repos/${login}/${REPO}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
    });
  } catch (e) {
    if (e instanceof GhError && e.status === 422) {
      await gh(token, `/repos/${login}/${REPO}/git/refs/heads/${branch}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha, force: true }),
      });
    } else throw e;
  }

  onPhase("pr");
  const pr = await gh<{ html_url: string; number: number }>(token, `${UPSTREAM_API}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title,
      head: `${login}:${branch}`,
      base: "main",
      body: [
        `由 @${login} 通过 FontManager 插件中心请求下架：`,
        "",
        ...dirs.map((d) => `- \`plugins/${d}/\``),
        "",
        "> 合并后该插件的目录会被删除，聚合脚本重算 `index.json` 后中心里就不再显示。",
      ].join("\n"),
    }),
  });
  return { prUrl: pr.html_url, prNumber: pr.number, branch };
}

/** 下架请求的入参 */
export interface DeleteArgs {
  token: string;
  login: string;
  /** 要下架的目录名（清单里的 `dir`，形如 `<id>__<author>`） */
  dirs: string[];
  onPhase: (phase: UploadPhase) => void;
}

/** registry 的 plugin.json = 运行时清单 + 市场字段（见方案 §3） */
function buildManifest(form: PluginForm, login: string, paths: string[]) {
  const all = Array.from(new Set([...paths, "plugin.json"])).sort();
  return {
    id: form.id.trim(),
    name: form.name.trim(),
    brief: form.brief.trim(),
    detail: form.detail.trim(),
    author: login,
    version: form.version.trim(),
    entry: form.entry.trim(),
    apiLevel: form.apiLevel,
    permissions: form.permissions,
    runtime: form.runtime,
    minAppVersion: form.minAppVersion.trim() || undefined,
    lang: form.lang,
    official: false,
    uploadedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    files: all.map((path) => ({ path })),
  };
}

/** PR 正文：一个插件一段，多个插件按顺序铺开 */
function buildPrBody(items: UploadItem[], login: string): string {
  const lines: string[] = [
    items.length === 1
      ? `**${items[0].form.name}** v${items[0].form.version} — 由 @${login} 通过 FontManager 插件中心上传。`
      : `${items.length} 个插件，由 @${login} 通过 FontManager 插件中心上传。`,
    "",
  ];
  for (const it of items) {
    const perms = it.form.permissions.length
      ? it.form.permissions.map((p) => "`" + p + "`").join("、")
      : "不申请任何权限";
    const who =
      it.author === login
        ? `署名 @${login}`
        : `署名 **${it.author}**（匿名上传，由 @${login} 代传）`;
    lines.push(
      `### ${it.form.name} v${it.form.version}`,
      "",
      it.form.brief,
      "",
      `- 目录：\`plugins/${it.form.id}__${it.author}\``,
      `- 文件：${it.files.length} 个（不含 plugin.json）`,
      `- 入口：\`${it.form.entry}\``,
      `- 运行时：${it.form.runtime ?? "无"}`,
      `- 权限：${perms}`,
      `- ${who}`,
      "",
    );
  }
  lines.push("> 这份 PR 由软件自动生成。维护者合并前请确认权限范围与简介描述一致。");
  return lines.join("\n");
}

