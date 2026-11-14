/**
 * 安装器 / 卸载器的前端逻辑（路线 C，规格书 §4A.5 的状态机）。
 *
 * 三条设计约束，改之前先读：
 *
 * 1. **不引 React、不引状态库**。这份界面只有 7 屏、状态是线性的，用原生 TS 直接改
 *    DOM 就够，产物 30KB 上下 —— 这就是"0 体积 1:1 还原"的前提（规格书 §9.5 C1）。
 * 2. **界面上的每个数字都由 Rust 给**（版本、路径、字节数、剩余空间）。这里不猜、
 *    不拼常量：屏 3 的路径必须是真装上的路径，不能是 `%LOCALAPPDATA%` 这种模板。
 * 3. **进度只认 `setup:progress` 事件**，不自己拍脑袋跑动画。装到哪一步就是哪一步；
 *    演练模式（没有安装包可驱动）由 Rust 发同一套事件，UI 完全不知道区别。
 */

import "./setup.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { normalizeInstallDir } from "../lib/installDir";

type Mode = "install" | "uninstall";

interface SetupEnv {
  mode: Mode;
  version: string;
  /** 用户这台机器上已安装的版本（没装就是 null） */
  installedVersion: string | null;
  /** 默认安装位置（首次安装 = %LOCALAPPDATA%\FontManager） */
  defaultDir: string;
  /** 已安装的话 = 注册表里的真实安装位置 */
  installDir: string | null;
  /** 安装包体积（字节）—— 欢迎屏"需要空间"用 */
  payloadBytes: number;
  /** 程序本体占用（字节）—— 卸载屏"占用空间"用，只算程序不含 data */
  appBytes: number;
  dataDir: string;
  dataBytes: number;
  freeBytes: number;
  /** 驱动真装的安装包路径；null = 演练模式（只走界面，不写盘） */
  setupExe: string | null;
  demo: boolean;
  elevated: boolean;
}

interface Progress {
  percent: number;
  /** 状态行整行（"正在安装 · 12.4 MB / 23.7 MB"） */
  label: string;
  sub: string;
  /** 追加到日志区的一行；空字符串 = 这一拍不追加 */
  log: string;
  done: boolean;
  /** 非空 = 失败，值是给人看的原因 */
  failed: string | null;
  /** 失败/取消时的收尾动作：cancelled 表示用户自己取消的 */
  cancelled: boolean;
}

/** 一个正在运行的 fontmanager.exe（Rust 侧已排除安装器自己） */
interface RunningProc {
  pid: number;
  path: string;
}

/** `setup:blocked`：引擎还没启动就被"程序还开着"挡住，等用户决定 */
interface Blocked {
  kind: Mode;
  count: number;
  pids: number[];
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const body = document.body;
const app = $("#app");

let env: SetupEnv | null = null;
let mode: Mode = "install";
let targetDir = "";
let purgeData = false;
let wantRun = true;
let wantDesktop = true;
let busy = false;
/** 用户在"程序还在运行"对话框里选了关闭之后要重做的那一步 */
let pendingRetry: (() => Promise<void>) | null = null;

/* ───────────────── 小工具 ───────────────── */

function mb(bytes: number): string {
  if (!bytes) return "0 MB";
  const m = bytes / 1024 / 1024;
  return m >= 100 ? `${Math.round(m)} MB` : `${m.toFixed(1)} MB`;
}

function gb(bytes: number): string {
  const g = bytes / 1024 / 1024 / 1024;
  if (g >= 10) return `${g.toFixed(0)} GB`;
  if (g >= 1) return `${g.toFixed(1)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}


/** 只显示尾部的路径：`C:\Users\x\AppData\Local\FontManager` → `…\Local\FontManager` */
function tail(path: string, keep = 3): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= keep + 1) return path;
  return "…\\" + parts.slice(-keep).join("\\");
}

/* ───────────────── 屏切换 ───────────────── */

function stepOf(name: "install" | "uninstall", n: number) {
  const attr = name === "install" ? "data-istep" : "data-ustep";
  // 安装屏和卸载屏共用同一个 #app：切到哪一套，就把另一套的 .on 摘掉。
  // 否则两个 .state.on 同时存在，任何按 `.state.on` 找当前屏的代码都会摸错套。
  app.querySelectorAll<HTMLElement>(".state.on").forEach((el) => {
    if (!el.hasAttribute(attr)) el.classList.remove("on");
  });
  app.querySelectorAll<HTMLElement>(`.state[${attr}]`).forEach((el) => {
    el.classList.toggle("on", Number(el.getAttribute(attr)) === n);
  });
  // 焦点交给主按钮：Enter 直接往下走，不用先点一下窗口
  const cur = app.querySelector<HTMLElement>(`.state[${attr}].on`);
  const primary = cur?.querySelector<HTMLButtonElement>(".btn-primary");
  primary?.focus({ preventScroll: true });
}

function goInstall(n: number) {
  stepOf("install", n);
}
function goUninstall(n: number) {
  stepOf("uninstall", n);
}

function pushLog(el: HTMLElement, line: string) {
  if (!line) return;
  const div = document.createElement("div");
  div.textContent = line;
  el.insertBefore(div, el.firstChild);
  while (el.children.length > 5) el.lastElementChild?.remove();
}

/* ───────────────── 「已用 N 秒」自己走字（2.1.8） ─────────────────
 * 为什么需要：Rust 那边只在**跳步**时才发一次 `sub`，装到某一步之后长时间没有
 * 新事件（真机上 24 MB 解压 + 注册表 + 快捷方式合计 40 秒上下），于是「已用 0 秒」
 * 冻在那儿一动不动，进度条也不动 —— 用户实测原话「等太久，我还以为卡了」。
 *
 * 这里只接管**计时**，不碰百分比：约束 3 说的是"进度不自己拍脑袋跑"，时钟不是
 * 进度，它是"我还在干活"的唯一证据。所以：
 *   · 每秒把 sub 改成真实秒数（和 Rust 发的 `已用 N 秒` 同口径，不会互相打脸）
 *   · 超过 20 秒补一句"正在写入，请勿关闭窗口" —— 沉默超过这个时长，任何界面
 *     都会被当成死机
 *   · 给填充条 `<i>` 挂 `running` 类，由 CSS 做呼吸动画（纯视觉，不改宽度、不改百分比）
 * 收尾必须 stopTicker()：失败/取消/完成三种出口都会走到 finish*()。
 */
let tickTimer = 0;
let tickFrom = 0;

function startTicker(subSel: string, progSel: string) {
  stopTicker();
  tickFrom = Date.now();
  const sub = $(subSel);
  const prog = $(progSel);
  prog.classList.add("running");
  tickTimer = window.setInterval(() => {
    if (!busy) {
      stopTicker();
      return;
    }
    const s = Math.round((Date.now() - tickFrom) / 1000);
    sub.textContent = s >= 20 ? `已用 ${s} 秒 · 正在写入，请勿关闭窗口` : `已用 ${s} 秒`;
  }, 1000);
}

function stopTicker() {
  if (tickTimer) window.clearInterval(tickTimer);
  tickTimer = 0;
  document.querySelectorAll(".prog i.running").forEach((e) => e.classList.remove("running"));
}

/* ───────────────── 首屏：把真实环境填进去 ───────────────── */

async function boot() {
  env = await invoke<SetupEnv>("setup_env");
  mode = env.mode;
  body.classList.toggle("mode-install", mode === "install");
  body.classList.toggle("mode-uninstall", mode === "uninstall");
  $("#ver").textContent = env.installedVersion ?? env.version;

  if (mode === "install") {
    targetDir = env.defaultDir;
    $("#mInstallDir").textContent = tail(env.defaultDir, 2);
    $("#mNeeded").textContent = `约 ${mb(env.payloadBytes)}`;
    $("#mDataDir").textContent = "<安装目录>\\data";
    $("#iSub0").textContent = env.elevated
      ? "预计 5 秒 · 当前已是管理员权限"
      : "预计 5 秒 · 无需管理员权限";
    $("#iStatus0").textContent = env.installedVersion
      ? `检测到已安装 ${env.installedVersion} · 将直接覆盖升级`
      : "准备就绪 · 即将开始安装";
    if (env.demo) {
      // 演练模式：把话说在前面，绝不让用户以为真装了
      $("#iStatus0").textContent = "演练模式 · 当前没有可驱动的安装包";
      $("#iSub0").textContent = "只走界面流程，不写注册表、不落文件";
    }
    // 首屏就把"有实例没关"说出来，比等到点"安装"才弹窗从容（弹窗仍然要弹，
    // 因为在开始装之前必须确认一次）
    void invoke<RunningProc[]>("setup_running")
      .then((list) => {
        if (!list.length) return;
        $("#iStatus0").textContent = "FontManager 正在运行 · 安装前会请你先关闭";
        $("#iSub0").textContent = `检测到 ${list.length} 个正在运行的实例（不影响继续）`;
      })
      .catch(() => {});
    goInstall(0);
  } else {
    targetDir = env.installDir ?? "";
    $("#uInstallDir").textContent = tail(targetDir || "（未检测到安装）", 2);
    $("#uUsed").textContent = mb(env.appBytes);
    $("#uDataDir").textContent = `${tail(env.dataDir, 2)}（${gb(env.dataBytes)}）`;
    if (!env.installDir) {
      // 没装 / 注册表里没有：别让用户点一个注定失败的"卸载"
      $("#uWarn").style.display = "";
      $("#uPurgeRow").style.display = "none";
      const btn = app.querySelector<HTMLButtonElement>("[data-act='uninstall']");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "未安装";
      }
    }
    goUninstall(0);
  }

  body.classList.add("ready");
}

/* ───────────────── 进度事件 ───────────────── */

async function wireProgress() {
  await listen<Progress>("setup:progress", (e) => {
    const p = e.payload;
    if (mode === "install") {
      if (!busy && !p.done) return; // 已经收尾的迟到事件不带节奏
      const status = $("#iStatus");
      const prog = $("#iProg");
      const sub = $("#iSub");
      status.textContent = p.label;
      prog.style.width = `${Math.max(0, Math.min(100, p.percent))}%`;
      sub.textContent = p.sub;
      pushLog($("#iLog"), p.log);
      if (p.done) finishInstall(p);
    } else {
      if (!busy && !p.done) return;
      $("#uStatus").textContent = p.label;
      $("#uProg").style.width = `${Math.max(0, Math.min(100, p.percent))}%`;
      $("#uSub").textContent = p.sub;
      pushLog($("#uLog"), p.log);
      if (p.done) finishUninstall(p);
    }
  });

  // 引擎被"程序还开着"挡住（`setup_install` 内部的兜底检测触发）。
  // 注意**不能**当成失败处理：没有 done 事件，进度屏停在原地，等用户决定。
  await listen<Blocked>("setup:blocked", (e) => {
    busy = false;
    const kind = e.payload.kind;
    pendingRetry = kind === "install" ? () => startInstall(true) : () => startUninstall(true);
    openRunModal(e.payload.count, kind);
  });
}

/* ───────────────── 程序还在运行（2.1.7） ───────────────── */

function openRunModal(count: number, kind: Mode) {
  $("#runTitle").textContent = "FontManager 正在运行";
  $("#runBody").textContent =
    kind === "install"
      ? `检测到 ${count} 个 FontManager 进程正在运行。安装需要替换程序文件，得先把它们关掉 —— 否则文件被占用，会出现「装完了版本还是旧的」。`
      : `检测到 ${count} 个 FontManager 进程正在运行。卸载需要删除程序文件，得先把它们关掉 —— 否则文件删不掉，只能留到下次开机再清理。`;
  $("#runNote").textContent =
    kind === "install" ? "关闭时，正在进行的操作会丢失。" : "关闭软件不会动你的字体库与设置。";
  $("#runModal").hidden = false;
  app
    .querySelector<HTMLButtonElement>(".modal-acts [data-act='run-close']")
    ?.focus({ preventScroll: true });
}

function closeRunModal() {
  $("#runModal").hidden = true;
}

/**
 * 动手前先看有没有别的实例在跑。有 → 弹窗并返回 true（调用方直接收工，等用户决定）。
 *
 * 这里查不到就当"没有"：真正的闸门在 Rust 侧（`setup_install` 会再查一遍并回
 * `setup:blocked`），前端这一查只是为了不把用户先扔到进度屏上再弹回来。
 */
async function blockedByRunning(next: () => Promise<void>): Promise<boolean> {
  let list: RunningProc[] = [];
  try {
    list = await invoke<RunningProc[]>("setup_running");
  } catch (err) {
    console.warn("[setup] 运行中检测失败，交给 Rust 侧兜底", err);
    return false;
  }
  if (!list.length) return false;
  pendingRetry = next;
  openRunModal(list.length, mode);
  return true;
}

/* ───────────────── 安装 ───────────────── */

function finishInstall(p: Progress) {
  busy = false;
  stopTicker();
  if (p.failed || p.cancelled) {
    // 取消：退回欢迎屏，不留半装目录（目录清理由 Rust 做）
    goInstall(p.cancelled ? 0 : 2);
    if (!p.cancelled) {
      $("#iStatus").textContent = p.failed ?? "安装失败";
      $("#iProg").style.width = "100%";
      $("#iSub").textContent = "详细日志：%TEMP%\\FontManager-setup.log";
      const acts = $("#iActs3");
      acts.innerHTML =
        '<button class="btn btn-ghost" data-act="to-welcome">返回</button>' +
        '<button class="btn btn-primary" data-act="install">重试</button>';
    }
    return;
  }
  const title = $("#iDoneTitle");
  const doneBody = $("#iDoneBody");
  if (env?.demo) {
    title.textContent = "演练完成";
    doneBody.textContent =
      "界面流程已经走完，但这次没有写任何文件、也没有改注册表 —— 因为没有可驱动的安装包（--setup-exe 未传入）。";
    $("#iDoneChecks").style.display = "none";
  } else {
    title.textContent = "安装完成";
    doneBody.textContent = `FontManager ${env?.version ?? ""} 已安装。数据在安装目录的 data 文件夹，卸载时你可以决定是否保留。`;
    $("#iDoneChecks").style.display = "";
  }
  goInstall(3);
}

async function startInstall(force = false) {
  if (busy) return;
  // 有人在跑就先问，别把用户扔进进度屏再弹回来
  if (!force && (await blockedByRunning(() => startInstall(true)))) return;
  busy = true;
  goInstall(2);
  $("#iLog").innerHTML = "";
  $("#iProg").style.width = "0%";
  $("#iStatus").textContent = "正在安装…";
  $("#iSub").textContent = "已用 0 秒";
  startTicker("#iSub", "#iProg");
  try {
    await invoke("setup_install", {
      dir: targetDir,
      desktopShortcut: wantDesktop,
      runAfter: wantRun,
      forceCloseRunning: force,
    });
  } catch (err) {
    finishInstall({
      percent: 100,
      label: "安装失败",
      sub: String(err),
      log: "",
      done: true,
      failed: String(err),
      cancelled: false,
    });
  }
}

/* ───────────────── 卸载 ───────────────── */

function finishUninstall(p: Progress) {
  busy = false;
  stopTicker();
  if (p.failed) {
    $("#uStatus").textContent = p.failed;
    $("#uProg").style.width = "100%";
    $("#uSub").textContent = "详细日志：%TEMP%\\FontManager-setup.log";
    return;
  }
  if (p.cancelled) {
    goUninstall(0);
    return;
  }
  $("#uDoneBody").textContent = purgeData
    ? "FontManager 已从这台电脑移除，你的数据与字体库也已全部删除。"
    : `FontManager 已从这台电脑移除。你的数据保留在 ${env?.dataDir ?? ""}，重新安装会直接接上。`;
  goUninstall(2);
}

async function startUninstall(force = false) {
  if (busy) return;
  if (!force && (await blockedByRunning(() => startUninstall(true)))) return;
  busy = true;
  goUninstall(1);
  $("#uLog").innerHTML = "";
  $("#uProg").style.width = "0%";
  startTicker("#uSub", "#uProg");
  $("#uStatus").textContent = "正在移除…";
  $("#uSub").textContent = "已用 0 秒";
  try {
    await invoke("setup_uninstall", {
      dir: targetDir,
      purgeData,
      forceCloseRunning: force,
    });
  } catch (err) {
    finishUninstall({
      percent: 100,
      label: "卸载失败",
      sub: String(err),
      log: "",
      done: true,
      failed: String(err),
      cancelled: false,
    });
  }
}

/* ───────────────── 交互 ───────────────── */

async function pickDir() {
  const picked = await invoke<string | null>("setup_pick_dir", { current: targetDir });
  if (!picked) return;
  // 一律落到 `<所选目录>\FontManager`：用户点「桌面\新建文件夹」是想装到那儿，
  // 不是把一堆文件摊在桌面根上。已经叫 FontManager 的目录不再套一层（见 lib/installDir.ts）。
  const dir = normalizeInstallDir(picked);
  targetDir = dir;
  $("#pathBox").textContent = dir;
  window.setTimeout(() => {
    const hint = $("#pathHint");
    hint.textContent = "正在检查这个位置…";
    invoke<{ ok: boolean; hint: string }>("setup_check_dir", { dir })
      .then((r) => (hint.textContent = r.hint))
      .catch(() => (hint.textContent = ""));
  }, 30);
}

function bind() {
  app.addEventListener("click", async (ev) => {
    const t = ev.target as HTMLElement;

    const winBtn = t.closest<HTMLElement>("[data-win]");
    if (winBtn) {
      const action = winBtn.dataset.win === "min" ? "minimize" : "close";
      await invoke("setup_window", { action });
      return;
    }

    const chk = t.closest<HTMLElement>("[data-chk]");
    if (chk) {
      const on = chk.querySelector(".box")!.classList.toggle("on");
      if (chk.dataset.chk === "run") wantRun = on;
      else wantDesktop = on;
      return;
    }
    if (t.closest("#uPurgeRow")) {
      purgeData = $("#uPurgeBox").classList.toggle("on");
      return;
    }

    const btn = t.closest<HTMLButtonElement>("[data-act]");
    if (!btn) return;

    switch (btn.dataset.act) {
      case "close":
        await invoke("setup_window", { action: "close" });
        break;
      case "to-location":
        $("#pathBox").textContent = targetDir;
        $("#mNeeded2").textContent = `约 ${mb(env?.payloadBytes ?? 0)}`;
        goInstall(1);
        invoke<{ ok: boolean; hint: string }>("setup_check_dir", { dir: targetDir })
          .then((r) => ($("#pathHint").textContent = r.hint))
          .catch(() => ($("#pathHint").textContent = ""));
        break;
      case "browse":
        await pickDir();
        break;
      case "to-welcome":
        goInstall(0);
        break;
      case "install":
        await startInstall();
        break;
      case "run-cancel":
        // 取消 = 回到能再按一次的那一屏，什么都不改（不杀进程、不写盘）
        closeRunModal();
        pendingRetry = null;
        busy = false;
        if (mode === "install") {
          goInstall(1);
          $("#pathBox").textContent = targetDir;
        } else {
          goUninstall(0);
        }
        break;
      case "run-close": {
        // 用户明确同意关闭：这一步才允许结束别人的进程
        const btns = Array.from(app.querySelectorAll<HTMLButtonElement>(".modal-acts .btn"));
        btns.forEach((b) => (b.disabled = true));
        let left = -2;
        try {
          const r = await invoke<{ closed: number; remaining: RunningProc[] }>(
            "setup_close_running",
          );
          left = r.remaining.length;
        } catch (err) {
          console.warn("[setup] 结束进程失败", err);
        }
        btns.forEach((b) => (b.disabled = false));
        if (left !== 0) {
          $("#runBody").textContent =
            left > 0
              ? `还有 ${left} 个 FontManager 进程没能关闭（可能以管理员身份运行）。请手动退出 FontManager 后再试。`
              : "无法结束正在运行的 FontManager，请手动退出后再试。";
          return;
        }
        const retry = pendingRetry;
        closeRunModal();
        pendingRetry = null;
        if (retry) await retry();
        break;
      }
      case "cancel-install":
        // 不直接取消：先弹确认（规格书 §4.7）。屏 3 的按钮挨着「返回」，
        // 没有这一层就等于允许手滑废掉一次四十多秒的安装。
        $("#cancelModal").hidden = false;
        break;
      case "cancel-yes":
        $("#cancelModal").hidden = true;
        {
          const c = app.querySelector<HTMLButtonElement>("[data-act='cancel-install']");
          if (c) {
            c.textContent = "正在取消…";
            c.disabled = true;
          }
        }
        await invoke("setup_cancel");
        break;
      case "cancel-no":
        $("#cancelModal").hidden = true;
        break;
      case "uninstall":
        await startUninstall();
        break;
      case "open-dir":
        await invoke("setup_window", { action: "open-install-dir" });
        break;
      case "finish":
        await invoke("setup_window", {
          action: "finish",
          launch: mode === "install" ? wantRun : false,
        });
        break;
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== "Escape") return;
    // 遮罩开着 = 必须先在"关闭软件并继续 / 取消"里选一个，别让 Enter 穿透到底下
    if (!$("#runModal").hidden) {
      ev.preventDefault();
      const act = ev.key === "Enter" ? "run-close" : "run-cancel";
      app.querySelector<HTMLButtonElement>(`[data-act='${act}']`)?.click();
      return;
    }
    // 「取消安装」的确认：Enter 与 Esc 都回「继续安装」（安全默认），
    // 想真取消必须正面点一次那个按钮 —— 见 setup.html 里的注释。
    if (!$("#cancelModal").hidden) {
      ev.preventDefault();
      app.querySelector<HTMLButtonElement>("[data-act='cancel-no']")?.click();
      return;
    }
    // 屏号**必须**限定在当前模式里取：安装屏与卸载屏都在同一个 DOM 里，
    // 只写 `.state.on` 会摸到另一套屏（2026-11-14 实测：卸载时取到安装屏 1
    // 的 data-istep，屏号算成 0，Enter 又把"卸载"按钮点了一次）。
    const cur = (mode === "install" ? "data-istep" : "data-ustep") as string;
    const n = Number(
      app.querySelector(`.state[${cur}].on`)?.getAttribute(cur) ?? 0,
    );
    // 屏 3（安装中）期间所有按键都不该直接生效 —— 但 Esc 可以**开确认框**，
    // 别让只能鼠标点（规格书 §4.6「屏 3 除外：Esc 需要走确认」）。
    if (busy) {
      if (ev.key === "Escape" && mode === "install" && n === 2) {
        ev.preventDefault();
        $("#cancelModal").hidden = false;
      }
      return;
    }
    // **必须吃掉默认行为**：stepOf 会把焦点交给主按钮，浏览器自己也会拿 Enter
    // 去点那个按钮 —— 否则一次按键 = 两次 click（2026-11-14 实测：卸载被启动了
    // 两次，第二次在 uninstall.exe 已被删掉之后跑，界面报"找不到卸载程序"）。
    ev.preventDefault();
    if (ev.key === "Escape") {
      if (mode === "install" && n === 0) invoke("setup_window", { action: "close" });
      if (mode === "uninstall" && n === 0) invoke("setup_window", { action: "close" });
      if (n === 2 || n === 3) invoke("setup_window", { action: "finish", launch: false });
      return;
    }
    if (mode === "install") {
      if (n === 0) $("[data-act='to-location']").click();
      else if (n === 1) $("[data-act='install']").click();
      else if (n === 3) $("[data-act='finish']").click();
    } else {
      if (n === 0) $("[data-act='uninstall']").click();
      else if (n === 2) $("[data-act='finish']").click();
    }
  });
}

/* ───────────────── 启动 ───────────────── */

(async () => {
  bind();
  try {
    await wireProgress();
  } catch (err) {
    // 进度事件只是"锦上添花"：订阅不到就退回静态进度条，**绝不能因此白屏**。
    // （2026-11-14 实际踩到：listen 抛错把整个启动链拒了，.ready 永远加不上，
    //   用户看到的就是一个纯白圆角框，连报障都无从说起。）
    console.warn("[setup] 订阅进度事件失败，改用静态进度", err);
  }
  try {
    await boot();
  } catch (err) {
    showBootError(err);
  }
})();

/** 启动失败时的最后一道防线：把错误与 Tauri 内部状态摊在页面上（见 setup.html 的注释）。
 *
 * **只在界面还没就绪时接管**。界面一旦 `ready`，任何运行期错误（比如拖拽窗口被 ACL 拒绝、
 * 某个非关键 invoke 失败）都不许盖住界面 —— 2026-11-14 实测踩过：安装已经装完，
 * 一个 `start_dragging not allowed by ACL` 就把整屏糊成红字，用户会以为装坏了。
 */
function showBootError(err: unknown) {
  if (document.body.classList.contains("ready")) {
    console.warn("[setup] 运行期错误（界面已就绪，不覆盖）", err);
    return;
  }
  document.body.classList.add("ready");
  if (document.getElementById("boot-err")) return;
  const w = window as unknown as { __TAURI_INTERNALS__?: Record<string, unknown> };
  const internals = w.__TAURI_INTERNALS__;
  const diag = [
    `__TAURI_INTERNALS__ = ${typeof internals}`,
    `transformCallback = ${typeof internals?.transformCallback}`,
    `invoke = ${typeof internals?.invoke}`,
  ].join("\n");
  const d = document.createElement("pre");
  d.id = "boot-err";
  d.style.cssText =
    "position:fixed;inset:0;z-index:99999;margin:0;padding:18px;overflow:auto;" +
    "background:#fff;color:#b3261e;font:12px/1.55 ui-monospace,Consolas,monospace;" +
    "white-space:pre-wrap";
  d.textContent =
    "安装界面启动失败：\n\n" +
    String((err as { stack?: string })?.stack ?? err) +
    "\n\n" +
    diag;
  document.body.appendChild(d);
}
