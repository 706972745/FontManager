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

import { isPluginId, PLUGIN_ID_MAX } from "../lib/workshop.ts";

const OWNER = "706972745";
const REPO = "Manager-Workshop";
const UPSTREAM_API = `/repos/${OWNER}/${REPO}`;

/**
 * 与 registry 的 `validate_plugins.py` 同口径（改这里 = 改上传规则）。
 *
 * 2026-11-26 起统一成 `FM-XXX-XXX`：前缀大写 FM，后接两段字母数字（大小写随意）。
 * 定义在 `src/lib/workshop.ts` 的 `isPluginId()` —— 上传校验与清单过滤共用一条口径，
 * 不允许再各写一份正则。
 */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PLUGIN_BYTES = 20 * 1024 * 1024;
const MAX_BRIEF = 200;
const MAX_DETAIL = 1000;
/**
 * 插件名称上限（显示名，不是 id）。
 *
 * 卡片上名字太长会换行/省略，列表立刻变得参差不齐，所以在上传前就卡住：
 * **超过不允许提交**（而不是等到 CI 或合并后再退回来）。上限 2026-11-26 由 15 放宽到 25 ——
 * 15 位对「Adobe 套字器（批量）」这类中文名太紧，用户只能起半截名字。
 * 按「字符」数，不按 UTF-16 长度 —— 中文/emoji 一个字就是一个字。
 */
export const MAX_NAME = 25;

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

/**
 * registry 的 `dir` → 目录名（最后一段）。
 *
 * `index.json` 里的 `dir` 是**仓库相对路径**（`plugins/<id>__<作者>`），而删除时拼的是
 * 「仓库根下的 blob 路径」和分支名 —— 只该用最后一段。
 *
 * 这里踩过一次坑：直接把整条路径塞进 `plugins/${dir}/`，拼成
 * `plugins/plugins/com.xxx__作者/` 一条都匹配不上，于是插件明明白白还在仓库里，
 * 面板却报「仓库里已经没有这个插件目录了」。口径与 Rust 的 `dir_name_of` /
 * 前端的 `communityDirFor` 保持一致。
 */
export function dirNameOf(dir: string): string | null {
  const raw = dir.trim();
  if (!raw || raw.includes("\\") || raw.includes(":")) return null;
  for (const seg of raw.split("/")) {
    if (seg === "." || seg.includes("..")) return null;
  }
  // 取最后一段（不过滤空段）：`plugins/` 的末段是空 → null，不回落
  const last = (raw.split("/").pop() ?? "").trim();
  if (!last || last.startsWith(".")) return null;
  return /^[A-Za-z0-9._-]+$/.test(last) ? last : null;
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
    // 运行时清单里常见的 `summary` / `description` 拿来兜底市场字段：
    // 插件作者写运行时清单时不一定会再抄一份 brief/detail，拖进来直接能传，
    // 不用先对着「简介不能为空」手打一遍（截断按市场字段的上限来）。
    if (!out.brief) {
      const s = typeof raw.summary === "string" ? raw.summary
        : typeof raw.description === "string" ? raw.description : "";
      if (s.trim()) out.brief = s.trim().slice(0, MAX_BRIEF);
    }
    if (!out.detail && typeof raw.description === "string" && raw.description.trim()) {
      out.detail = raw.description.trim().slice(0, MAX_DETAIL);
    }
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

  if (!isPluginId(form.id)) err("uploadErrId", { max: PLUGIN_ID_MAX });
  // 名称：非空 + 不超过 MAX_NAME（按字符数，中文/emoji 一个字算一个）
  const nameLen = [...form.name.trim()].length;
  if (!nameLen) err("uploadErrName");
  else if (nameLen > MAX_NAME) err("uploadErrNameLong", { max: MAX_NAME });
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
  /** i18n 键；由对话框用 `t(key)` 翻成当时的界面语言 */
  readonly key: string;

  // 不写「构造函数参数属性」（`constructor(readonly key: string)`）：那是唯一一种
  // Node 的类型剥离跑不了的 TS 语法，写了这个模块就没法在 `node --test` 里直接 import。
  constructor(key: string) {
    super(key);
    this.name = "UploadMessage";
    this.key = key;
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

/** fork 上的提交基准：`sha` 是新提交的 parent，`tree` 是新 tree 的 base */
interface ForkBase {
  sha: string;
  tree: string;
  /** fork 的 main 是否已与上游一致（不一致时下架不能用：目标文件在 fork 里可能还不存在） */
  current: boolean;
}

/**
 * 准备 fork 上的提交基准（fork 不存在就先建）。
 *
 * 历史坑（2026-11-25 实测定位）：以前这里把 fork 的 main 直接 `PATCH` 到上游 sha。
 * 上游 main 里有 `.github/workflows/*`，令牌只有 `public_repo` 时 GitHub **拒绝**
 * 「OAuth App 创建/更新 workflow 文件」，而且回的是 **404 而不是 403** —— 界面就成了
 * 「上传失败 — Not Found」。fork 只要落后一次（别人传了插件、聚合脚本推了 index.json），
 * 之后所有下架/迭代都会失败，报错完全看不出原因。
 *
 * 现在的口径：**不要求 fork 与上游一致**。
 * - 上传：以 fork 自己的 main 为 base 造 commit，PR 的三点 diff 按 merge-base 算，
 *   上游新增的文件不会混进来；
 * - 下架：走 `[takedown]` issue（见 `requestTakedown`），根本不碰 fork。
 *
 * `merge-upstream` 只是「顺手让 fork 别太旧」的优化：令牌缺 workflow scope 时它必然
 * 失败（422），失败就跳过 —— 绝不因为同步不上就让上传失败。
 */
async function forkBase(
  token: string,
  login: string,
  upSha: string,
  upTree: string,
): Promise<ForkBase> {
  // ① fork 必须存在（首次上传时 GitHub 那边是异步创建的，建完要等它真的出现）
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

  // ② 读 fork 的 main。空 fork（还没有 main）→ 按上游 sha 建一条
  const readRef = () =>
    ghOrNull<{ object: { sha: string } }>(token, `/repos/${login}/${REPO}/git/ref/heads/main`);
  let ref = await readRef();
  if (!ref) {
    await gh(token, `/repos/${login}/${REPO}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: "refs/heads/main", sha: upSha }),
    });
    return { sha: upSha, tree: upTree, current: true };
  }
  if (ref.object.sha === upSha) return { sha: upSha, tree: upTree, current: true };

  // ③ 落后了：顺手试一次官方同步（成功就等于 fast-forward 到上游，PR 更干净）。
  //    失败不是错误：409 = fork 有自己的提交；422 = 令牌缺 workflow scope。
  try {
    await gh(token, `/repos/${login}/${REPO}/merge-upstream`, {
      method: "POST",
      body: JSON.stringify({ branch: "main" }),
    });
    ref = await readRef();
    if (ref && ref.object.sha === upSha) {
      return { sha: upSha, tree: upTree, current: true };
    }
  } catch {
    /* 见上：不只为了同步就让上传失败 */
  }

  // ③b 官方同步没追上（fork 分叉 409 / 令牌缺 workflow scope 422）时，
  //    **强制把 fork main 对齐到上游最新**（2026-11-28 用户实测：fork 落后时上传
  //    同一个插件，三方合并撞出 plugin.json 冲突，PR 直接挂死在「等待冲突解决」）。
  //
  //    为什么敢 force：fork 只是用户账号下的**镜像**，用户从不在 fork 上开发；
  //    它上面的「独有提交」全部来自旧版面板的错误 force 留下的残渣 —— 丢掉它们
  //    正是消除冲突的前提。fork main 对齐上游后，上传分支的 merge-base 就是
  //    上游最新，三方合并退化为快进，不再有 both-modified 冲突。
  //
  //    失败面：OAuth 令牌缺 workflow scope 时，若上游与 fork 的 .github/workflows
  //    有差异，GitHub 会拒（422）。捕住后按旧行为用 fork 旧树继续 —— PR 可能冲突，
  //    但那是「同步被 GitHub 政策拦住」，不能静默吞掉假装成功。
  try {
    await gh(token, `/repos/${login}/${REPO}/git/refs/heads/main`, {
      method: "PATCH",
      body: JSON.stringify({ sha: upSha, force: true }),
    });
    return { sha: upSha, tree: upTree, current: true };
  } catch (e) {
    if (!(e instanceof GhError && [403, 404, 409, 422].includes(e.status))) throw e;
  }

  const sha = ref?.object.sha ?? upSha;
  const commit = await gh<{ tree: { sha: string } }>(
    token,
    `/repos/${login}/${REPO}/git/commits/${sha}`,
  );
  return { sha, tree: commit.tree.sha, current: sha === upSha };
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

  // ② 我的 fork：没有就建；能追上上游就先追上（见 forkBase 的注释）
  onPhase("fork");
  const base = await forkBase(token, login, upstreamSha, upstreamTree);

  // ④ 逐文件建 blob（大目录会慢，进度回给界面）
  //    每个插件都要额外写一份 plugin.json，所以总步数 = 文件数 + 插件数
  //    （plugin.json 原件不算：它会被重新生成的那份顶掉）
  const totalSteps = items.reduce(
    (n, it) => n + it.files.filter((f) => f.path !== "plugin.json").length + 1,
    0,
  );
  let done = 0;
  const entries: { path: string; mode: string; type: string; sha: string }[] = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const dir = dirs[i];
    for (const f of it.files) {
      // plugin.json 一律由 buildManifest 重新生成（见 ⑤），原件不能再进 tree：
      // 同一个 path 出现两条 entry，GitHub 会判 422（面板从文件夹上传时本来就带着它）。
      // 重新生成的那份会**先把原件的运行字段抄过来**再盖市场字段，所以菜单 / 设置不会丢。
      if (f.path === "plugin.json") continue;
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

    // ⑤ 清单本身也要进包里：**装到机器上以后运行时读的就是它**
    //    所以它不是纯市场清单 —— buildManifest 会先把 zip 原件里的 hooks / menus /
    //    settings / requirements / interpreter 抄进来，再盖表单里的市场字段
    const manifest = buildManifest(it.form, it.author.trim() || login, it.files);
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

  // ⑥ tree：一次铺开所有插件目录。base 用 **fork 的 main**（不是上游）：
  //    只有 fork 里真实存在的对象才能被新 commit 引用，拿上游 sha 造出来的 ref
  //    在 fork 里会被 GitHub 判 404（见 forkBase 注释）。
  //    fork 落后也不影响 PR 的可读性 —— GitHub 的三点 diff 以 merge-base 算，
  //    上游新增的文件不会出现在「Files changed」里。
  onPhase("commit");

  /**
   * 覆盖更新：同名目录已存在时，先把这个子树整棵删掉，再铺新文件（2026-11-28）。
   *
   * `base_tree` 是**增量**语义 —— 它只把新 entries 并进去，不清理旧目录里多出来的文件。
   * 插件从 v1 到 v2 如果删掉了某个文件，直接上传的结果是「同名文件被盖掉 + 旧文件
   * 继续留在仓库里」，装到机器上就是新旧混合、清单与目录对不上。
   *
   * 探测用 **fork 的 `base.sha`**（不是上游）：`base_tree` 就是 fork 的树，只有 fork 里
   * 存在的目录才需要在同一棵树上删；fork 落后时，上游那些文件本来就不在这份树里。
   *
   * 分两次请求而不是塞进同一个 `tree` 数组：同一请求里「删目录 + 加同路径文件」的
   * 处理顺序 GitHub 没有承诺。
   */
  const existing: string[] = [];
  for (const d of dirs) {
    const found = await ghOrNull<unknown>(
      token,
      `/repos/${login}/${REPO}/contents/plugins/${encodeURIComponent(d)}?ref=${base.sha}`,
    );
    if (found) existing.push(d);
  }
  let baseTree = base.tree;
  if (existing.length > 0) {
    const cleared = await gh<{ sha: string }>(token, `/repos/${login}/${REPO}/git/trees`, {
      method: "POST",
      body: JSON.stringify({
        base_tree: base.tree,
        tree: existing.map((d) => ({
          path: `plugins/${d}`,
          mode: "040000",
          type: "tree",
          sha: null,
        })),
      }),
    });
    baseTree = cleared.sha;
  }

  const tree = await gh<{ sha: string }>(token, `/repos/${login}/${REPO}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTree, tree: entries }),
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
      parents: [base.sha],
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
  let pr: { html_url: string; number: number };
  try {
    pr = await gh<{ html_url: string; number: number }>(token, `${UPSTREAM_API}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title,
        head: `${login}:${branch}`,
        base: "main",
        body: buildPrBody(items, login),
      }),
    });
  } catch (e) {
    // 覆盖上传时，如果新内容与线上**逐字节相同**，删掉再放回去的 commit 没有任何
    // 变更，GitHub 会拒绝建 PR（422 "No commits between ..."）。这不是故障，
    // 翻成人话让用户知道「内容一致、无需重新上传」。
    if (e instanceof GhError && e.status === 422 && /no commits/i.test(e.apiMessage)) {
      throw new UploadMessage("uploadErrNoChange");
    }
    throw e;
  }

  return { prUrl: pr.html_url, prNumber: pr.number, branch };
}

/**
 * 下架入参归一化：`plugins/<id>__<作者>` 或裸目录名都收，统一成**目录名**。
 *
 * 顺带做一次归属预检 —— 只为了让「不是你的东西」在点下去那一刻就有清楚的话；
 * 真正的闸门是：非维护者推不动 main（直推 403/422 退回 PR），PR 那关还有 CI 的
 * `plugins/<id>__<作者>` 作者校验。
 */
function removeTargets(args: DeleteArgs): string[] {
  const names = args.dirs.map((d) => {
    const name = dirNameOf(d);
    if (!name) throw new UploadMessage("uploadErrBadDir");
    return name;
  });
  for (const name of names) {
    const cut = name.lastIndexOf("__");
    const owner = cut >= 0 ? name.slice(cut + 2) : "";
    // GitHub 的登录名**大小写不敏感**：清单里写 `Helloooooseff`、token 回
    // `helloooooseff` 是同一个人。这里按小写比，否则正确署名的作者会被自己的
    // 插件挡在门外（报「这个插件的署名不是你的名字」，症状就是「没有下架权限」）。
    if (!args.allowAny && owner.toLowerCase() !== args.login.toLowerCase()) {
      throw new UploadMessage("uploadErrNotOwner");
    }
  }
  return names;
}

/**
 * 作者自助下架：开一个 `[takedown]` issue，由 registry 的 `takedown.yml` 校验归属后**直接删**。
 *
 * 为什么不再走「fork + 下架 PR」（2026-11-25 真机定位）：
 * 作者每次下架都要先把 fork 同步到上游，而上游 main 里有 `.github/workflows/*`。
 * 旧令牌只有 `public_repo`，GitHub 拒绝「OAuth App 创建/更新 workflow 文件」，
 * 而且回的是 **404**（不是 403）→ 界面显示「上传失败 — Not Found」，用户读成「没有权限」。
 * fork 只要落后一次（别人上传、聚合脚本推 index.json），下架就永远失败。
 *
 * issue 通道只用 `public_repo`，与 fork 状态无关；真正的闸门在 Actions 里：
 * issue 作者必须等于目录名后缀（忽略大小写），且只允许删这个目录。
 */
export async function requestTakedown(
  args: DeleteArgs,
): Promise<{ issueNumber: number; issueUrl: string }> {
  const { token, login } = args;
  if (args.dirs.length === 0) throw new UploadMessage("uploadErrEmpty");
  const names = removeTargets(args);

  const title = `[takedown] ${names.map((d) => `plugins/${d}`).join(", ")}`;
  const body = [
    `由 @${login} 通过 FontManager 插件中心请求下架：`,
    "",
    ...names.map((d) => `- \`plugins/${d}/\``),
    "",
    "> 仓库的 takedown 工作流会校验：发起人必须是目录署名者本人，且只删除上面这些目录；",
    "> 通过后立即生效，不需要维护者手动合并。",
  ].join("\n");

  const issue = await gh<{ number: number; html_url: string }>(
    token,
    `${UPSTREAM_API}/issues`,
    { method: "POST", body: JSON.stringify({ title, body }) },
  );
  return { issueNumber: issue.number, issueUrl: issue.html_url };
}

/**
 * 直推下架：把目录从上游 main 上删掉，**不开 PR**。
 *
 * 走 Git Data API 造一个 commit，然后 PATCH `refs/heads/main` —— 这就是一次 push。
 * main 上有 required PR 规则，但 ruleset 的 bypass 名单里有 `Repository admin`
 * （`bypass_mode: always`），维护者本人的令牌推得动，所以这一步能直接落地。
 *
 * 失败一律抛 GhError，交给调用方决定要不要退回「开 PR」那条老路：
 * - 403 / 422：令牌没有上游写权限、或不是可以绕过规则的身份
 * - 409：期间有人推了 main（拿到的 parent 过期）
 */
export async function deletePluginsDirect(args: DeleteArgs): Promise<DeleteResult> {
  const { token, login, onPhase } = args;
  if (args.dirs.length === 0) throw new UploadMessage("uploadErrEmpty");
  const names = removeTargets(args);

  onPhase("commit");
  const head = await gh<{ object: { sha: string } }>(
    token,
    `${UPSTREAM_API}/git/ref/heads/main`,
  );
  const baseSha = head.object.sha;
  const baseCommit = await gh<{ tree: { sha: string } }>(
    token,
    `${UPSTREAM_API}/git/commits/${baseSha}`,
  );

  // 逐 blob 打 `sha: null` 删除，比「删整棵子树」稳（tree 类型条目的 null 语义文档含糊）
  const flat = await gh<{ tree: { path: string; type: string }[]; truncated: boolean }>(
    token,
    `${UPSTREAM_API}/git/trees/${baseCommit.tree.sha}?recursive=1`,
  );
  if (flat.truncated) throw new UploadMessage("uploadErrTreeTooBig");
  const entries = flat.tree
    .filter((e) => e.type === "blob" && names.some((d) => e.path.startsWith(`plugins/${d}/`)))
    .map((e) => ({ path: e.path, mode: "100644", type: "blob", sha: null }));
  if (entries.length === 0) throw new UploadMessage("uploadErrNotFound");

  const tree = await gh<{ sha: string }>(token, `${UPSTREAM_API}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: entries }),
  });

  const title =
    names.length === 1
      ? `[remove] ${names[0]} by ${login}`
      : `[remove] ${names.length} 个插件 by ${login}`;
  const commit = await gh<{ sha: string }>(token, `${UPSTREAM_API}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: `${title}\n\n由作者在 FontManager 插件中心自助下架（直推，不开 PR）。`,
      tree: tree.sha,
      parents: [baseSha],
    }),
  });

  // 不带 force：万一期间有人推过 main，会 422 而不是把别人的提交顶掉
  await gh(token, `${UPSTREAM_API}/git/refs/heads/main`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });

  return { mode: "direct" };
}

/**
 * 当前令牌的主人是不是这个仓库的维护者（能绕过 required PR）。
 *
 * 用来决定面板里要不要把「别人的插件」也列出来给删除入口 —— 只影响界面，
 * 真正的门槛是：非维护者推不动 main，只能走 PR + CI 归属校验。
 */
export async function canMaintain(token: string): Promise<boolean> {
  try {
    const repo = await ghOrNull<{
      permissions?: { admin?: boolean; maintain?: boolean; push?: boolean };
    }>(token, UPSTREAM_API);
    const p = repo?.permissions ?? {};
    return Boolean(p.admin || p.maintain);
  } catch {
    return false;
  }
}

/**
 * 目录是否**真的**已经不在上游 —— 走 api.github.com，不看任何缓存。
 *
 * 为什么下架确认需要这第二口径：`probePluginDir()`（raw.githubusercontent.com）
 * 在国内常被 hosts 指到本地加速器，那个加速器**忽略查询串**照缓存回 200，
 * 于是「已经删掉的目录」还会被探成「还在」。以前宽限期到点就据此把插件放回列表，
 * 表现正是 2026-11-26 用户报的「下架了，过一会儿又能点下架」。
 *
 * GitHub API 的 contents 端点不做这种缓存：404 = 真没了。公开仓库免登录也能查，
 * 只有 IP 级限流（60 次/小时），所以只在宽限期兜底判定时用一次，不进轮询。
 */
export async function probePluginDirApi(dir: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com${UPSTREAM_API}/contents/plugins/${dir}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });
  if (res.status === 404) return true;
  if (res.ok) return false;
  throw new GhError(res.status, `probe HTTP ${res.status}`);
}

/** PR 的结局：还在等合并 / 已合并（上架成功）/ 被关掉（没通过） */
export type PullState = "open" | "merged" | "closed";

/**
 * 查一次自己那份上传 PR 的状态。
 *
 * 上传弹窗靠它把「等待审批」变成一句确定的话：合并了 → 提醒面板重拉清单
 * （新插件这时才出现在中心里）；被关掉 → 直接说没通过，别让人一直等。
 * 传了 token 就用（5000 次/小时），没登录也能查公开仓库（60 次/小时，够 1 分钟一次）。
 */
export async function pullStatus(token: string | null, number: number): Promise<PullState> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${UPSTREAM_API}/pulls/${number}`, {
    headers,
    cache: "no-store",
  });
  if (!res.ok) throw new GhError(res.status, `pull HTTP ${res.status}`);
  const data = (await res.json()) as { merged?: boolean; state?: string };
  if (data.merged) return "merged";
  return data.state === "closed" ? "closed" : "open";
}

/** 下架结果：直推成功，或退回「开了个 PR，等合并」 */
export interface DeleteResult {
  mode: "direct" | "pr";
  prUrl?: string;
  prNumber?: number;
}

/** 下架请求的入参 */
export interface DeleteArgs {
  token: string;
  login: string;
  /**
   * 要下架的目录：`<id>__<作者>` 或 registry 给的仓库相对路径 `plugins/<id>__<作者>` 都行
   * （内部统一归一化成目录名，见 `removeTargets`）。
   */
  dirs: string[];
  onPhase: (phase: UploadPhase) => void;
  /**
   * 允许删「别人的」插件 —— **只对维护者成立**。
   *
   * 安全边界不在这一行：非维护者根本推不动 main（没有 bypass 身份），直推会 403/422
   * 并退回开 PR，而 PR 那关由 CI 的 `plugins/<id>__<作者>` 归属校验兜住。
   * 这里提前拦一次只是为了让「不是你的东西」在点下去的一瞬间就有清楚的话。
   */
  allowAny?: boolean;
}

/**
 * 运行时清单里「装到本机才生效」的那部分字段，原样抄进 registry 的 plugin.json。
 *
 * 为什么必须抄：registry 那份 plugin.json 是**市场清单**（id / 名称 / 简介 / 文件 / 权限），
 * 但它同时也是装到机器上以后**插件进程、右键菜单、设置齿轮读的那份清单** ——
 * 两个角色压在同一份文件上。以前这里只写市场字段，于是从插件中心装的社区件永远没有
 * `menus` / `settings` / `hooks` / `requirements`（官方件走 release zip 安装，不受影响）：
 * 用户装完看到「没有右键菜单、没有齿轮」，只会以为是插件坏了。
 *
 * 口径：市场字段以弹窗表单为准（作者可以改简介、改名字），**运行字段以 zip 里的
 * plugin.json 为准** —— 没人该在弹窗里手抄一遍菜单。类型不对的字段直接丢掉，
 * 绝不因为原件里有脏数据就让整份清单生成失败。
 */
export function runtimeManifestFields(files: PickedFile[]): Record<string, unknown> {
  const mf = files.find((f) => f.path === "plugin.json");
  if (!mf || mf.bytes.length === 0) return {};
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8").decode(mf.bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    raw = parsed as Record<string, unknown>;
  } catch {
    return {}; // 清单坏了不阻塞上传：市场字段由表单兜底
  }

  const out: Record<string, unknown> = {};
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

  // 解释器：exe 插件是空串（Rust 侧等于 None，行为一致）；python/node 插件靠它启动
  const interpreter = str(raw.interpreter);
  if (interpreter) out.interpreter = interpreter;
  const interpreterPath = str(raw.interpreterPath);
  if (interpreterPath) out.interpreterPath = interpreterPath;

  if (Array.isArray(raw.hooks)) {
    const hooks = raw.hooks.map(str).filter((h) => h !== "");
    if (hooks.length) out.hooks = hooks;
  }

  if (Array.isArray(raw.menus)) {
    const menus: { title: string; on: string }[] = [];
    for (const item of raw.menus) {
      if (!item || typeof item !== "object") continue;
      const { title, on } = item as Record<string, unknown>;
      const t = str(title);
      if (!t) continue;
      // `on` 只认 family / plugin（缺省 = family，与主程序一致）；写错就丢这一条
      const where = on === undefined || on === null || on === "" ? "family" : str(on);
      if (where !== "family" && where !== "plugin") continue;
      menus.push({ title: t, on: where });
    }
    if (menus.length) out.menus = menus;
  }

  if (raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings)) {
    const s = raw.settings as Record<string, unknown>;
    const title = str(s.title);
    const hook = str(s.hook) || "settings";
    if (title || str(s.hook)) out.settings = { title: title || "设置", hook };
  }

  if (raw.requirements && typeof raw.requirements === "object" && !Array.isArray(raw.requirements)) {
    const r = raw.requirements as Record<string, unknown>;
    const req: Record<string, unknown> = {};
    const runtime = str(r.runtime);
    if (runtime) req.runtime = runtime;
    const list = (v: unknown): string[] =>
      Array.isArray(v) ? v.map(str).filter((x) => x !== "") : [];
    const libraries = list(r.libraries);
    const system = list(r.system);
    const platforms = list(r.platforms);
    if (libraries.length) req.libraries = libraries;
    if (system.length) req.system = system;
    if (platforms.length) req.platforms = platforms;
    const note = str(r.note);
    if (note) req.note = note;
    if (Object.keys(req).length) out.requirements = req;
  }

  // 卡片小字 / 详情面板读的是这两个；市场字段的 brief / detail 由表单负责，互不覆盖
  const summary = str(raw.summary);
  if (summary) out.summary = summary;
  const description = str(raw.description);
  if (description) out.description = description;

  return out;
}

/** registry 的 plugin.json = 市场字段（表单）+ 运行时字段（zip 里的原件，见上） */
export function buildManifest(form: PluginForm, login: string, files: PickedFile[]) {
  const paths = files.map((f) => f.path);
  const all = Array.from(new Set([...paths, "plugin.json"])).sort();
  return {
    ...runtimeManifestFields(files),
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

