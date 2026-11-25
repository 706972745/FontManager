/**
 * 插件中心面板的数据通道。
 *
 * 两条线：
 * - **清单**：面板自己 fetch registry 的 index.json（webview 里没有 CORS 限制，
 *   raw.githubusercontent.com 也带 `Access-Control-Allow-Origin: *`）；
 * - **动作**（列已装 / 安装 / 卸载 / 开外链）：走主程序的**本机回环服务**
 *   （127.0.0.1 + 一次性 key）。面板自己**不碰文件系统** —— 下载、sha256 校验、
 *   写入插件目录全在 Rust 侧做。
 */

import { communityDirFor, type WorkshopEntry } from "../lib/workshop.ts";

/** registry 聚合清单（客户端唯一请求，方案 §2 / §5） */
export const INDEX_URL =
  "https://raw.githubusercontent.com/706972745/FontManager-Workshop/main/index.json";

/** 一次性会话 key：主程序开窗时放在查询参数里 */
export function sessionKey(): string {
  try {
    return new URLSearchParams(location.search).get("k") ?? "";
  } catch {
    return "";
  }
}

/**
 * 清单里的目录字段不合法（`communityDirFor` 判非法）。
 *
 * 单独一类错误，界面好给它一句准话（本地化的 `badDir`），而不是把 Rust 的
 * 原始报错或一串路径糊到界面上。
 */
export class BadRegistryDirError extends Error {
  constructor() {
    super("registry dir 字段不合法");
    this.name = "BadRegistryDirError";
  }
}

/**
 * 拉清单原文（解析在前端，宽容解析在 lib/workshop.ts）。
 *
 * **必须带超时 + 重试**（2026-11-15 用户反馈「插件中心加载有点慢」）：
 * raw.githubusercontent.com 在国内网络下会出现「TCP 连上了但不回包」，
 * 没有超时的话 `fetch` 会一直挂着，界面上就是永远停在
 * 「正在读取社区插件清单…」的样子 —— 慢的不是解析，是这一等没有尽头。
 *
 * 12 秒一刀 + 一次重试：真慢到 24 秒，界面会给出错误和重试按钮（比无限转圈好）。
 */
const INDEX_TIMEOUT_MS = 12_000;
const INDEX_RETRY_GAP_MS = 400;

function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal, cache: "no-cache" }).finally(() =>
    window.clearTimeout(timer),
  );
}

export async function fetchIndexText(signal?: AbortSignal): Promise<string> {
  if (signal) {
    // 调用方自己管取消（暂无调用方传，留口子）
    const res = await fetch(INDEX_URL, { signal, cache: "no-cache" });
    if (!res.ok) throw new Error(`index.json HTTP ${res.status}`);
    return await res.text();
  }
  let last: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => window.setTimeout(r, INDEX_RETRY_GAP_MS));
    try {
      const res = await fetchWithTimeout(INDEX_URL, INDEX_TIMEOUT_MS);
      if (!res.ok) throw new Error(`index.json HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      last = e;
      // HTTP 状态码错误重试也没用（除了 5xx，但 raw 很少给），只对网络/超时重试一次
      if (e instanceof Error && /HTTP \d{3}/.test(e.message)) break;
    }
  }
  const msg = last instanceof Error ? last.message : String(last);
  throw new Error(msg === "The user aborted a request." ? "index.json 请求超时" : msg);
}

/** 本机解释器探活结果（主程序侧查，面板只用来决定要不要提示） */
export interface PanelRuntimes {
  python: boolean;
  node: boolean;
}

export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
}

/**
 * 面板会话失效（401）：一次性 key 过期或主程序重启了。
 * 这条要单独认出来 —— 服务端的报错文案是中文，界面得给本地化的一句人话。
 */
export class PanelSessionExpired extends Error {
  constructor() {
    super("session expired");
    this.name = "PanelSessionExpired";
  }
}

/** 服务端返回的错误：带 HTTP 状态码，便于界面分类处理 */
export class PanelError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PanelError";
    this.status = status;
  }
}

async function panelFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "x-workshop-key": sessionKey(),
      "content-type": "application/json",
      ...((init?.headers as Record<string, string>) ?? {}),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // 非 JSON 错误体：下面按状态码报
  }
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error;
    // 401 = 会话失效：这一类不把服务端的中文原文透给界面
    if (res.status === 401) throw new PanelSessionExpired();
    throw new PanelError(res.status, message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

/** 主程序读回来的一个文件（路径相对插件根，内容是 base64） */
export interface RawPickedFile {
  path: string;
  size: number;
  /** 超过 10MB / 累计超 20MB 的文件留空串（前端据 size 报「太大」） */
  content: string;
}

export interface PickFoldersResult {
  cancelled: boolean;
  dirs: { dirName: string; files: RawPickedFile[] }[];
}

/** 安装请求体：官方件给 zip 直链，社区件给逐文件清单 */
export interface InstallRequest {
  id: string;
  kind: "official" | "community";
  url?: string;
  dir?: string;
  files?: { path: string; sha256: string; url: string; size: number }[];
  /** index.json 声称的权限：Rust 侧要和插件包内 plugin.json 实际申请的对上才装 */
  permissions?: string[];
}

export interface InstallOutcome {
  id: string;
  name: string;
  version: string;
  files: number;
  dir: string;
}

/** 已装清单 + 解释器探活 + 本地 API 开关（主程序侧查，面板只用来决定提示什么） */
export interface PanelState {
  plugins: InstalledPlugin[];
  runtimes: PanelRuntimes;
  appVersion: string;
  /**
   * 设置 → 插件 → 本地 API 是否开着。
   * 插件全靠它拿数据：关着的时候装完也跑不起来 —— 面板要提醒用户去开，
   * 但**不能替用户开**（那是用户自己的开关）。
   */
  apiEnabled: boolean;
  /**
   * 首次导览看过了没有。存在主程序 prefs 里，**不是**面板的 localStorage ——
   * 面板窗口每次打开端口都不同，origin 一变 localStorage 就换一份。
   */
  tourDone: boolean;
}

export const panelApi = {
  /** 已装插件清单 + 本机解释器探活 + 主程序版本 + 本地 API 开关 */
  plugins: () => panelFetch<PanelState>("/api/plugins"),
  install: (body: InstallRequest) =>
    panelFetch<InstallOutcome>("/api/install", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  uninstall: (id: string) =>
    panelFetch<{ ok: boolean }>("/api/uninstall", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
  /**
   * 外链交给系统浏览器打开（面板是 webview，自己开不了外部页面）。
   *
   * 开浏览器会让面板失焦 —— 而面板是「失焦即藏」的（点主窗口任何地方就消失）。
   * 这个失焦是**软件自己造成的**，所以先置守位，等用户切回来（window focus）再清；
   * 60 秒兜底清一次，避免用户一直不回来后守位永远挂着。
   */
  openUrl: (url: string) => {
    void holdBlurGuard();
    return panelFetch<{ ok: boolean }>("/api/open-url", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
  },
  /** 失焦守卫：`true` = 接下来的失焦不要藏窗口（选文件夹的系统对话框就靠它） */
  setBlurGuard: (locked: boolean) =>
    panelFetch<{ ok: boolean; locked: boolean }>("/api/blur-guard", {
      method: "POST",
      body: JSON.stringify({ locked }),
    }),
  /**
   * 让主程序弹系统目录对话框（**可多选**）并**把文件内容读回来**（base64）。
   *
   * 面板不用 `<input webkitdirectory>`：那条路一弹对话框面板就失焦（失焦即藏），
   * 而且等于让页面自己去翻用户磁盘 —— 与「面板碰不到文件系统」的既有口径相反。
   */
  pickFolders: () =>
    panelFetch<PickFoldersResult>("/api/pick-folders", { method: "POST", body: "{}" }),
  /**
   * 选 zip 分发包。主程序在内存里解压、剥掉唯一的外层目录，
   * 返回结构与 `pickFolders` **完全一致** —— 前端不用分两套草稿逻辑。
   */
  pickPackages: () =>
    panelFetch<PickFoldersResult>("/api/pick-packages", { method: "POST", body: "{}" }),
  /** 记下「导览看过了」（存主程序 prefs，跨面板窗口有效） */
  markTourDone: () =>
    panelFetch<{ ok: boolean }>("/api/tour-done", { method: "POST", body: "{}" }),
  /**
   * 清单缓存（跨面板窗口、跨重启）：主程序数据目录里的 `workshop-index-cache.json`。
   *
   * 面板每次打开都是新窗口，端口随机 → origin 变 → **localStorage 等于没有**。
   * 所以「打开不用等网络」这件事只能靠主程序这边存一份。**都是尽力而为**：
   * 老版本主程序没有这两个端点，面板照旧走网络（`catch` 掉即可）。
   */
  getIndexCache: () =>
    panelFetch<{ cache: { entries: unknown; fetchedAt: number } | null }>("/api/index-cache"),
  setIndexCache: (entries: unknown, fetchedAt: number) =>
    panelFetch<{ ok: boolean }>("/api/index-cache", {
      method: "POST",
      body: JSON.stringify({ entries, fetchedAt }),
    }),
  /**
   * 当前登录用户的令牌（M3）：主程序用 DPAPI 加密存在本机。
   *
   * 令牌**只有一个来源**：用户在本机走完一次 GitHub 设备码登录。面板不再接收
   * 粘贴进来的令牌、也不内置任何令牌（2026-11-19 用户口径）。
   * 不能放 localStorage —— 面板每次打开的端口都不同，origin 一变就换一份。
   */
  getUploadToken: () => panelFetch<{ token: string | null }>("/api/upload-token"),
  /** 当前 GitHub 会话：`configured=false` = 软件还没配 OAuth App，不是用户没登录 */
  githubSession: () => panelFetch<GithubSession>("/api/github/session"),
  /** 发起一次设备码登录：返回 8 位码 + 浏览器地址 */
  githubDeviceStart: () =>
    panelFetch<GithubDeviceStart>("/api/github/device/start", { method: "POST", body: "{}" }),
  /** 轮询一次（节奏由面板控制，用户关窗就停） */
  githubDevicePoll: () =>
    panelFetch<GithubDevicePoll>("/api/github/device/poll", { method: "POST", body: "{}" }),
  /** 退出登录：删掉本机令牌 + 清会话缓存 */
  githubLogout: () =>
    panelFetch<{ ok: boolean }>("/api/github/logout", { method: "POST", body: "{}" }),
};

/** 见 `panelApi.githubSession` */
export interface GithubSession {
  configured: boolean;
  login: string | null;
}

export interface GithubDeviceStart {
  userCode: string;
  verificationUri: string;
  /**
   * 带 `?user_code=` 的完整地址：浏览器打开时 GitHub 会**自动填好码**。
   * 老版本主程序没有这个字段（返回 undefined），此时回落到 `verificationUri` + 手抄。
   */
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

/**
 * 轮询结果。`status` 的每个取值都对应界面上一句确定的话：
 * - `none`：没有正在进行的登录（面板重开过）
 * - `pending` / `slow_down`：继续等，后者要把间隔调大
 * - `ok`：拿到令牌，`login` 可能为 null（读登录名失败，但令牌已落盘）
 * - `expired` / `denied` / `error`：这条登录结束，要说清是什么原因
 */
export interface GithubDevicePoll {
  status: "none" | "pending" | "slow_down" | "ok" | "expired" | "denied" | "error";
  login?: string | null;
  interval?: number;
  message?: string;
}

/** 官方件 / 社区件的安装请求怎么拼（两种口径不同，但出口一样） */
export function installRequestFor(entry: WorkshopEntry): InstallRequest {
  if (entry.official) {
    return { id: entry.id, kind: "official", url: entry.download ?? undefined };
  }
  // 目录名拿不到 = 清单的 dir 字段不合法（穿越 / 盘符 / 末段非法）。
  // 这里**明确失败**：不静默跳过，也不用 id 兜底造一个目录名 —— 兜底等于把
  // 上游的异常吞掉，用户看到的会是「装上了但名字不对」的怪状态。
  const dir = communityDirFor(entry);
  if (dir === null) throw new BadRegistryDirError();
  return {
    id: entry.id,
    kind: "community",
    dir,
    permissions: entry.permissions ?? [],
    files: (entry.files ?? []).map((f) => ({
      path: f.path,
      sha256: f.sha256,
      url: f.url,
      size: f.size,
    })),
  };
}

/**
 * 失焦守位（见 `panelApi.openUrl` 的说明）。
 *
 * 面板是「失焦即藏」的，而**软件自己引发的失焦**（系统文件对话框、外部浏览器）
 * 不该把面板藏掉。`holdBlurGuard()` 置位并挂一个 60 秒兜底，
 * `releaseBlurGuard()` 在窗口重新拿到焦点时清掉。
 */
let blurGuardTimer: number | undefined;

export function holdBlurGuard(): Promise<void> {
  if (blurGuardTimer !== undefined) window.clearTimeout(blurGuardTimer);
  blurGuardTimer = window.setTimeout(() => {
    blurGuardTimer = undefined;
    void panelApi.setBlurGuard(false).catch(() => {});
  }, 60_000);
  return panelApi
    .setBlurGuard(true)
    .then(() => undefined)
    .catch(() => undefined);
}

export function releaseBlurGuard(): void {
  if (blurGuardTimer !== undefined) {
    window.clearTimeout(blurGuardTimer);
    blurGuardTimer = undefined;
  }
  void panelApi.setBlurGuard(false).catch(() => {});
}
