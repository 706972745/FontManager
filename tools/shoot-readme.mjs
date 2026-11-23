#!/usr/bin/env node
/**
 * FontManager · README 截图采集器（CDP 驱动，零依赖）
 * =====================================================================
 *
 * 一句话用法：
 *   node tools/shoot-readme.mjs --only main          # 只重拍一张，落到 _tmp/readme-shots/
 *   node tools/shoot-readme.mjs --in-place           # 全量重拍并直接覆盖仓库根目录的旧图
 *   node tools/shoot-readme.mjs --dry-run            # 不启动应用，自检工具链本身
 *
 * 为什么要重新做一套：`tools/shot.py`（PrintWindow）只能拍**窗口首屏**，
 * 切不了视图、开不了弹层；`tools/shot_next.py` 是给安装器逐屏用的。README 要的是
 * 「卡片视图 / 列表 / 样张 / 详情 / 回收站 / 命令面板 / 右键菜单 / 构造裁剪图」……
 * 这些只有拿到**调试端口**、能操作 DOM 才拍得出来。
 *
 * ---------------------------------------------------------------------
 * 构建：带 9223 的可运行 exe（与正式版互不影响）
 * ---------------------------------------------------------------------
 * 前置：Git Bash 里 `source "…/软件迭代/Fonts工程文件/env.sh"`（cargo / rustc / MSVC / SDK）。
 *
 *   cd <仓库根目录>
 *   source "../env.sh"
 *   # ① 前端先出 dist（比 pnpm build 快：跳过 tsc，截图只需要可运行的产物）
 *   npx vite build
 *   # ② 只覆盖窗口配置（9223 + 1280×820 + 无边框透明），不跑 beforeBuildCommand，
 *   #    也不打包安装器；CARGO_TARGET_DIR 指向私有目录，**绝不覆盖** rust-target/release/fontmanager.exe
 *   CARGO_TARGET_DIR="_tmp/shoot-target" \
 *     npx tauri build --config _tauri.nobuild.json --config _tauri.local.json --no-bundle
 *   # 产物：_tmp/shoot-target/release/fontmanager.exe
 *
 * 已实测的两点（用 `-r echo` 让 Tauri 只打印 cargo 命令行、不真编译）：
 *   1. `-c a.json -c b.json` 可以叠加，后者的键覆盖前者 —— 所以
 *      「`_tauri.nobuild.json` 清掉 beforeBuildCommand」+「`_tauri.local.json` 换窗口参数」能同时生效；
 *   2. Tauri CLI 会**自动**追加 `--features tauri/custom-protocol --release`，
 *      不需要再手写（`待办清单` / 旧交接文档里那条「独立 exe 必须带 custom-protocol」
 *      指的是直接 `cargo build` 的路径；走 `tauri build` 时它自己加）。
 *
 * 更省事的替代路线（无需编译，换机器时首选）：
 *   直接跑已有的 rust-target/release/fontmanager.exe，靠 WebView2 的环境变量补调试端口：
 *     WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" \
 *       ../../../rust-target/release/fontmanager.exe
 *   `--launch` 就是这么干的（见 launchApp）。代价是它和正式版共享单实例锁与用户数据目录，
 *   所以**必须等另一个实例退出**。
 *
 * ---------------------------------------------------------------------
 * 单实例与它人的测试
 * ---------------------------------------------------------------------
 * 本工具默认**不启动**应用：先探测 9223，能连上就直接采集（谁开的都行）。
 * 只有当 `--launch` 给了 exe 且 9223 没人应答时才会自己拉起进程。
 *
 * ---------------------------------------------------------------------
 * 参数
 * ---------------------------------------------------------------------
 *   --only a,b        只拍指定场景（--list 看全部）
 *   --in-place        写到仓库根目录（覆盖旧图）；默认写 _tmp/readme-shots/
 *   --out <dir>       自定义输出目录
 *   --dsf <n>         deviceScaleFactor，默认 1.25 → 1280×820 出 1600×1025（与旧图完全一致）
 *   --bg <#rrggbb>    透明像素的底色，默认 #ffffff（窗口是 transparent: true）
 *   --port <n>        CDP 端口，默认 9223（与 _tauri.local.json 一致）
 *   --exe <path>      --launch 时用的 exe，默认 <repo>/_tmp/shoot-target/release/fontmanager.exe
 *   --launch          9223 没人应答时拉起 --exe
 *   --build           先构建（vite build + tauri build --no-bundle，见上）
 *   --dry-run         自检：PNG 编解码 / CDP 客户端关联与超时 / 场景表一致性，不启动应用
 *   --list            列出场景表
 *   --verbose         打印每一步
 *
 * 退出码：0 = 全部成功；1 = 至少一个场景失败（失败原因打在汇总表里）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { attach, listTargets, Cdp, MockTransport, waitForDevtools } from "./shoot/cdp.mjs";
import { decodePng, encodePng, flatten, crop, imageStats, selfTest, Img } from "./shoot/png.mjs";
import { SCENES, pickScenes, MAIN_VIEWPORT, FAMILY_PREFERS } from "./shoot/scenes.mjs";

const REPO = path.resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------- 参数解析

function parseArgs(argv) {
  const opts = {
    only: "",
    out: path.join(REPO, "_tmp", "readme-shots"),
    inPlace: false,
    dsf: 1.25,
    bg: [255, 255, 255],
    port: 9223,
    exe: path.join(REPO, "_tmp", "shoot-target", "release", "fontmanager.exe"),
    launch: false,
    build: false,
    dryRun: false,
    list: false,
    verbose: false,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    switch (a) {
      case "--only":
        opts.only = rest[++i] ?? "";
        break;
      case "--out":
        opts.out = path.resolve(rest[++i] ?? opts.out);
        break;
      case "--in-place":
        opts.inPlace = true;
        break;
      case "--dsf":
        opts.dsf = Number(rest[++i] ?? opts.dsf);
        break;
      case "--bg":
        opts.bg = parseColor(rest[++i] ?? "#ffffff");
        break;
      case "--port":
        opts.port = Number(rest[++i] ?? opts.port);
        break;
      case "--exe":
        opts.exe = path.resolve(rest[++i] ?? opts.exe);
        break;
      case "--launch":
        opts.launch = true;
        break;
      case "--build":
        opts.build = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--list":
        opts.list = true;
        break;
      case "--verbose":
        opts.verbose = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new Error(`未知参数：${a}（--help 看用法）`);
    }
  }
  if (!Number.isFinite(opts.port) || opts.port <= 0) throw new Error(`--port 非法：${opts.port}`);
  if (!Number.isFinite(opts.dsf) || opts.dsf <= 0) throw new Error(`--dsf 非法：${opts.dsf}`);
  if (!Number.isFinite(opts.dsf)) opts.dsf = 1.25;
  if (opts.inPlace) opts.out = REPO;
  return opts;
}

function parseColor(text) {
  const m = /^#?([0-9a-f]{6})$/i.exec(text.trim());
  if (!m) throw new Error(`--bg 只接受 #rrggbb：${text}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// ------------------------------------------------------------------ 小工具

/** 判断指定端口上有没有 CDP 端点（用来决定「要不要自己拉进程」） */
async function devtoolsAlive(port) {
  try {
    const list = await listTargets(port, { timeoutMs: 1500 });
    return list.some((t) => t.type === "page");
  } catch {
    return false;
  }
}

/** 东（中日韩）字符在等宽终端里占两格，汇总表才对得齐 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0) ?? 0;
    w += c >= 0x1100 &&
      (c <= 0x115f ||
        (c >= 0x2e80 && c <= 0xa4cf) ||
        (c >= 0xac00 && c <= 0xd7a3) ||
        (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe30 && c <= 0xfe6f) ||
        (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6))
      ? 2
      : 1;
  }
  return w;
}

function padRight(s, width) {
  const text = String(s ?? "");
  return text + " ".repeat(Math.max(0, width - dispWidth(text)));
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? REPO,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: "inherit",
      shell: process.platform === "win32", // npx 在 Windows 上是 .cmd
    });
    child.on("error", (err) => reject(new Error(`${cmd} 启动失败：${err.message}`)));
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} 退出码 ${code}`)),
    );
  });
}

// ------------------------------------------------------------------ 构建/启动

async function buildExe(opts) {
  const targetDir = path.join(REPO, "_tmp", "shoot-target");
  console.log("\n== 构建：前端产物 ==");
  await runCmd("npx", ["vite", "build"]);
  console.log("\n== 构建：Rust exe（私有 target 目录，不会覆盖 rust-target/release）==");
  await runCmd(
    "npx",
    [
      "tauri",
      "build",
      "--config",
      "_tauri.nobuild.json",
      "--config",
      "_tauri.local.json",
      "--no-bundle",
    ],
    { env: { CARGO_TARGET_DIR: targetDir } },
  );
  const exe = path.join(targetDir, "release", "fontmanager.exe");
  if (!fs.existsSync(exe)) throw new Error(`构建完成但没找到产物：${exe}`);
  return exe;
}

/**
 * 拉起应用（不阻塞）。
 *
 * 关键一行是 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`：它让**已构建好的**正式 exe
 * 也能开出 9223 —— 于是「只想重拍 README」不必等一次完整的 Rust 重编译。
 * 我们自己构建的 exe 已经把端口写进 `_tauri.local.json`，这里再传一遍是幂等的。
 */
function launchApp(exe, opts) {
  if (!fs.existsSync(exe)) {
    throw new Error(
      `要启动的 exe 不存在：${exe}\n先跑一次构建，或 --exe 指向已有的 fontmanager.exe`,
    );
  }
  const port = opts.port;
  const child = spawn(exe, [], {
    cwd: path.dirname(exe),
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --force-renderer-accessibility`,
    },
  });
  child.unref();
  console.log(`已启动 ${exe}（pid ${child.pid}），等它开出 ${port} 端口…`);
  return child.pid;
}

// ------------------------------------------------------------------ 页面操作

/**
 * 等字库就绪：骨架屏消失，且要么有卡片、要么明确是空态。
 * 「字体还没扫完就拍」会拍到空库或半截卡片，是这类工具最典型的翻车方式。
 */
async function waitForLibrary(cdp, log) {
  const t0 = Date.now();
  await cdp
    .waitUntil(
      `(() => {
         if (document.querySelector('.scan-skeleton')) return false;
         if (document.querySelector('.empty-state')) return true;
         return document.querySelectorAll('[data-family]').length > 0;
       })()`,
      { timeoutMs: 120000, what: "字库就绪（骨架屏消失 + 出现卡片）" },
    )
    .catch(async (err) => {
      log(`⚠ 字库 120s 内没有就绪，继续尝试：${err.message}`);
    });
  // 卡片出来之后，字体文件本身还要加载（预览文字会先闪一次回退字体）
  await cdp.evaluate(`document.fonts ? document.fonts.ready.then(() => true) : true`).catch(() => {});
  await delay(400);
  const n = await cdp.count("[data-family]");
  log(`字库就绪（${((Date.now() - t0) / 1000).toFixed(1)}s，可见卡片 ${n} 张）`);
}

/**
 * 统一「浅色主题 + 中文界面」。
 *
 * 主题：`prefs.json` 里是 light 就不用管；万一不是，直接改 `<html data-theme>` —— 
 * 只影响 CSS 变量，不动用户偏好文件（截图工具不该改用户设置）。
 * 语言：`zfm.locale` 是 localStorage 里的，只有**重新载入**才会生效，所以这里允许重载一次。
 */
async function ensureThemeAndLocale(cdp, log) {
  // 启动瞬间 CDP 可能先给一个还没建 DOM 的 target（about:blank / 启动页），
  // 直接读 document.documentElement 会 TypeError。先等真页面出来。
  await cdp.waitUntil(`!!document.documentElement && !!document.querySelector('#root')`, {
    timeoutMs: 30000,
    what: "主窗口 DOM 就绪（#root 已挂载）",
  });
  const info = await cdp.evaluate(`({
    lang: document.documentElement?.lang || '',
    theme: document.documentElement?.dataset?.theme || '',
    stored: localStorage.getItem('zfm.locale') || '',
  })`);
  if (!/^zh/i.test(info.lang) || info.stored !== "zh-CN") {
    log(`界面语言是「${info.lang || info.stored || "未知"}」，切到 zh-CN 并重载…`);
    await cdp.evaluate(`localStorage.setItem('zfm.locale', 'zh-CN')`);
    await cdp.send("Page.reload", { ignoreCache: false });
    await delay(1500);
    await cdp.waitFor("#root", { timeoutMs: 30000, what: "重载后的 #root" });
    await waitForLibrary(cdp, log);
  }
  if (info.theme !== "light") {
    await cdp.evaluate(`document.documentElement.dataset.theme = 'light'`);
    log(`⚠ 主题原本是「${info.theme || "未知"}」，已在 DOM 上强制为 light（不改 prefs.json）`);
  }
  return info;
}

/**
 * 关掉「第一次使用？用一分钟了解你的新字体库」这类**一次性浮层**。
 *
 * 截图用的是干净数据根（ZFM_DATA_DIR 隔离），首次启动必弹；它会压在卡片列表底部，
 * 拍进 README 就是「正式版里有个引导条」的假象。点它的 ×（不是「开始导览」，
 * 那个会开全屏遮罩）。重复调用是安全的：不存在就直接返回。
 */
async function dismissTourInvite(cdp, log) {
  const sel = ".tour-invite .detail-close";
  if (!(await cdp.exists(sel))) return;
  await cdp.click(sel, { what: "首次使用引导条的关闭按钮" });
  await cdp.waitFrames({ frames: 2, settleMs: 200 });
  log("已关掉「第一次使用」引导条（干净数据根首次启动会弹，不该进 README 图）");
}

// ------------------------------------------------------------------ ctx

/**
 * 场景可用的操作集合。抽出来的目的：`scenes.mjs` 只描述「界面应该长什么样」，
 * 不关心 CDP 细节，也不关心重试 / 日志。
 */
function makeCtx({ cdp, opts, log, warn }) {
  const ctx = {
    cdp,
    port: opts.port,
    opts,
    log,
    warn,
    workshop: null,

    /** 取一个当前已渲染的字族名（虚拟列表只渲染可视区，所以只能在这些里面挑） */
    async pickFamily({ offset = 0 } = {}) {
      const names = await cdp.evaluate(
        `Array.from(document.querySelectorAll('[data-family]')).map(e => e.getAttribute('data-family')).filter(Boolean)`,
      );
      if (!Array.isArray(names) || names.length === 0) {
        throw new Error("页面上没有 [data-family] 卡片（还没扫完字体，或当前不在字族视图）");
      }
      if (opts.family) {
        const hit = names.find((n) => n.includes(opts.family));
        if (hit) return hit;
        warn(`--family「${opts.family}」不在当前渲染的卡片里，按默认规则挑`);
      }
      const preferred = names.filter((n) => FAMILY_PREFERS.some((p) => n.includes(p)));
      if (preferred.length > offset) return preferred[offset];
      return names[Math.min(2 + offset, names.length - 1)];
    },

    /** 点中一张卡片（点在文字区，避开星标 / 展开等小按钮） */
    async selectFamily(name, { offsetX = 46, offsetY = 46 } = {}) {
      const sel = `[data-family=${JSON.stringify(name)}]`;
      if (!(await cdp.exists(sel))) throw new Error(`卡片不在渲染范围里：${name}`);
      await cdp.click(sel, { offsetX, offsetY, what: `卡片「${name}」` });
      await cdp.waitFrames({ frames: 2, settleMs: 240 });
    },

    /** 切视图：0=卡片 1=列表 2=样张（顺序与 TopBar 的 VIEW_MODES 一致） */
    async setViewMode(index) {
      const rect = await cdp.evaluate(
        `(() => {
           const el = document.querySelectorAll('.view-toggle [role="tab"]')[${index}];
           if (!el) return null;
           const r = el.getBoundingClientRect();
           return { x: r.left, y: r.top, width: r.width, height: r.height };
         })()`,
      );
      if (!rect) throw new Error(`视图切换按钮 #${index} 不存在（顶栏没渲染？）`);
      await cdp.clickAt(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await cdp.waitFrames({ frames: 2, settleMs: 300 });
    },

    /** 点侧栏导航行 */
    async clickNav(kind) {
      const sel = `[data-nav-kind=${JSON.stringify(kind)}]`;
      if (!(await cdp.exists(sel))) throw new Error(`侧栏没有 ${sel}（在线入口可能被设置关掉了）`);
      await cdp.click(sel, { offsetX: 60, offsetY: 16, what: `侧栏 ${kind}` });
      await cdp.waitFrames({ frames: 2, settleMs: 320 });
    },

    async openSettings() {
      if (await cdp.exists(".settings-panel")) return;
      await cdp.click('[data-tour="settings"]', { what: "标题栏设置按钮" });
      await cdp.waitFor(".settings-panel", { what: "设置面板" });
      await cdp.waitFrames({ frames: 2, settleMs: 380 });
    },

    /** 给「设置 → 字体库文件夹」那一段打一个临时 id，供裁剪使用 */
    async markLibrarySection() {
      return await cdp.evaluate(
        `(() => {
           const labels = ['字体库文件夹', 'Library folder', '字体库', 'Font library'];
           const secs = Array.from(document.querySelectorAll('.settings-section'));
           for (const sec of secs) {
             const label = sec.querySelector('.settings-label');
             const text = (label ? label.textContent : sec.textContent) || '';
             if (labels.some((l) => text.includes(l))) { sec.id = 'zfm-crop-anchor'; return true; }
           }
           return false;
         })()`,
      );
    },

    /** 打开插件中心面板（独立窗口 = 第二个 target），返回它的 Cdp 连接 */
    async openWorkshop() {
      if (ctx.workshop) return ctx.workshop;
      const btn = '[data-hint="side.pluginCenter"]';
      if (!(await cdp.exists(btn))) {
        throw new Error(
          "标题栏没有插件中心入口 → 面板未安装（prefs.workshopInstalled 为假，或数据目录里没有 workshop.html）",
        );
      }
      await cdp.click(btn, { what: "插件中心入口" });
      const t0 = Date.now();
      let found = null;
      while (Date.now() - t0 < 25000) {
        const list = await listTargets(opts.port, { timeoutMs: 2000 }).catch(() => []);
        found = list.find((t) => t.type === "page" && /workshop/i.test(t.url ?? ""));
        if (found) break;
        await delay(300);
      }
      if (!found) {
        // 把当时 /json 里到底有什么打出来，别让人对着一句「没看到」猜：
        // 面板窗口可能用了不同 UDF（没有调试端口），也可能 URL 里没有 workshop 字样。
        const all = await listTargets(opts.port, { timeoutMs: 2000 }).catch(() => []);
        const seen = all.map((t) => `${t.type}:${(t.title || "").slice(0, 20)}:${(t.url || "").slice(0, 90)}`);
        throw new Error(
          `25s 内没在 /json 里看到插件中心窗口的 target（面板窗口可能没打开，或它不在这个调试端口下）。` +
            `当时 ${all.length} 个 target：${seen.join(" | ")}`,
        );
      }
      const panel = await attach({
        port: opts.port,
        match: (t) => t.webSocketDebuggerUrl === found.webSocketDebuggerUrl,
        label: "workshop-panel",
        timeoutMs: 8000,
      });
      await panel.waitFrames({ frames: 2, settleMs: 400 });
      ctx.workshop = panel;
      return panel;
    },
  };
  return ctx;
}

// ------------------------------------------------------------------ 复位

/**
 * 每个场景开拍前把界面复位到「字库 + 卡片视图 + 无弹层」。
 *
 * 为什么不 `Page.reload`：重载要重扫字体（几秒起步），15 张图就是十几分钟。
 * 连按 Esc + 显式关弹层足够，且更快暴露「某个弹层关不掉」这种真问题。
 */
async function resetScene(ctx, log) {
  const { cdp } = ctx;
  await cdp.clearViewport().catch(() => {});

  // 速览是个独立形态，先退出来（Alt+` 的 Esc 只归速览自己处理）
  if (await cdp.exists(".qb-frame")) {
    await cdp.pressKey("Escape").catch(() => {});
    await delay(220);
  }
  for (let i = 0; i < 3; i++) {
    await cdp.pressKey("Escape").catch(() => {});
    await delay(90);
  }
  if (await cdp.exists(".qb-frame")) {
    if (await cdp.exists('[data-hint="hint.backFull"]')) {
      await cdp.click('[data-hint="hint.backFull"]').catch(() => {});
    }
    if (!(await cdp.waitForGone(".qb-frame", { timeoutMs: 8000 }))) {
      log("⚠ 还在速览形态里，后续场景可能不准");
    }
  }

  // 弹层兜底：Esc 没关掉的，点它的关闭按钮
  for (const [panel, closer] of [
    [".settings-panel", ".settings-panel .detail-close"],
    [".shortcuts-panel", ".shortcuts-panel .detail-close"],
    [".palette-panel", ".palette-backdrop"],
  ]) {
    if (await cdp.exists(panel)) {
      if (closer && (await cdp.exists(closer))) await cdp.click(closer).catch(() => {});
      else await cdp.pressKey("Escape").catch(() => {});
      await cdp.waitForGone(panel, { timeoutMs: 3000 });
    }
  }
  // 右键菜单
  if (await cdp.exists(".ctx-menu")) {
    await cdp.pressKey("Escape").catch(() => {});
    await cdp.waitForGone(".ctx-menu", { timeoutMs: 3000 });
  }
  // 对比弹层（多选按 C 打开）也是模态的，拍之前必须关掉
  if (await cdp.exists(".compare-panel")) {
    if (await cdp.exists(".compare-panel .detail-close")) {
      await cdp.click(".compare-panel .detail-close").catch(() => {});
    } else {
      await cdp.pressKey("Escape").catch(() => {});
    }
    await cdp.waitForGone(".compare-panel", { timeoutMs: 3000 });
  }

  // 回到字库 + 卡片视图
  if (await cdp.exists('[data-nav-kind="library"]')) {
    await cdp.click('[data-nav-kind="library"]', { offsetX: 60, offsetY: 16 }).catch(() => {});
    await cdp.waitFrames({ frames: 2, settleMs: 220 });
  }
  await ctx.setViewMode(0).catch(() => {});
  await cdp.scrollToTop(".grid-scroll").catch(() => {});
  await cdp.pressKey("Escape").catch(() => {}); // 清选中
  await cdp.waitFrames({ frames: 2, settleMs: 200 });
}

// ------------------------------------------------------------------ 采集

async function collect(opts) {
  const log = (msg) => console.log(`  ${msg}`);
  const warn = (msg) => console.log(`  ⚠ ${msg}`);

  let scenes;
  try {
    scenes = pickScenes(opts.only);
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  if (!fs.existsSync(opts.out)) fs.mkdirSync(opts.out, { recursive: true });

  // 1) 应用：能连上就直接用，连不上才考虑自己拉
  let exe = opts.exe;
  if (opts.build) exe = await buildExe(opts);
  if (!(await devtoolsAlive(opts.port))) {
    if (!opts.launch) {
      console.error(
        `\n❌ ${opts.port} 端口上没有可连的 WebView2。\n` +
          `   请先启动带调试端口的应用（见本文件头部的构建命令），或加 --launch 让本脚本自己拉。\n`,
      );
      return 1;
    }
    launchApp(exe, opts);
    await waitForDevtools(opts.port, { timeoutMs: 90000 });
  } else {
    console.log(`已连上现有实例（${opts.port}），不重复启动。`);
  }

  const cdp = await attach({ port: opts.port, label: "main" });
  console.log(`已连接主窗口 target（${cdp.label}）`);

  await ensureThemeAndLocale(cdp, log);
  await waitForLibrary(cdp, log);
  await dismissTourInvite(cdp, log);

  const ctx = makeCtx({ cdp, opts, log, warn });
  const rows = [];
  const started = Date.now();

  for (const scene of scenes) {
    const t0 = Date.now();
    if (scene.skip) {
      rows.push({ scene: scene.name, file: scene.out, size: "-", bytes: "-", note: `跳过：${scene.skip}`, ok: true });
      console.log(`\n[${scene.name}] 跳过 —— ${scene.skip}`);
      continue;
    }
    console.log(`\n[${scene.name}] ${scene.title}`);
    try {
      await resetScene(ctx, log);
      // 语言切换会 Page.reload，重载后引导条可能再冒出来；每张图前兜一次
      await dismissTourInvite(cdp, log);
      if (scene.viewport === "native") await cdp.clearViewport();
      else await cdp.setViewport({ ...MAIN_VIEWPORT, deviceScaleFactor: opts.dsf });
      await cdp.waitFrames({ frames: 2, settleMs: 200 });

      const result = (await scene.run(ctx)) ?? {};
      if (result.note) log(result.note);

      // 抓哪个 target：普通场景主窗口；插件中心场景是它自己的窗口
      let shotCdp = cdp;
      if (scene.capture === "workshop") {
        if (!ctx.workshop) throw new Error("场景声明了 capture=workshop，但没打开面板");
        shotCdp = ctx.workshop;
      }
      if (scene.viewport === "native") await shotCdp.clearViewport();
      else await shotCdp.setViewport({ ...MAIN_VIEWPORT, deviceScaleFactor: opts.dsf });
      await shotCdp.waitFrames({ frames: 1, settleMs: 140 });

      const raw = await shotCdp.capture();
      let img = decodePng(raw);
      const rawW = img.width;
      const rawH = img.height;
      img = flatten(img, opts.bg);

      // 裁剪（如设置里的局部图）：CSS px → 像素，用「实际像素宽 / 布局宽」换算，
      // 不假设 dsf 一定被 WebView2 精确执行
      if (result.cropSelector) {
        const rect = await shotCdp.rect(result.cropSelector);
        if (!rect) throw new Error(`裁剪锚点不存在：${result.cropSelector}`);
        const layoutW = Number(await shotCdp.evaluate("innerWidth")) || rect.x + rect.width;
        const scale = rawW / layoutW;
        const pad = result.cropPad ?? 8;
        img = crop(img, {
          x: (rect.x - pad) * scale,
          y: (rect.y - pad) * scale,
          width: (rect.width + pad * 2) * scale,
          height: (rect.height + pad * 2) * scale,
        });
        log(`裁剪：${Math.round(rect.width)}×${Math.round(rect.height)} CSS px @${scale.toFixed(2)}×`);
      }

      const stats = imageStats(img);
      if (stats.distinct <= 1) {
        warn(`截图看起来是纯色（${img.width}×${img.height}，均值亮度 ${stats.meanLuma.toFixed(0)}）—— 窗口可能没显示`);
      }

      const file = path.join(opts.out, scene.out);
      const buf = encodePng(img);
      fs.writeFileSync(file, buf);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  → ${file}  ${img.width}×${img.height}  ${fmtBytes(buf.length)}  ${secs}s`);
      rows.push({
        scene: scene.name,
        file: scene.out,
        size: `${img.width}×${img.height}`,
        bytes: fmtBytes(buf.length),
        note: result.note ?? "",
        ok: true,
      });
    } catch (err) {
      console.log(`  ✗ 失败：${err.message}`);
      rows.push({
        scene: scene.name,
        file: scene.out,
        size: "-",
        bytes: "-",
        note: `失败：${err.message}`,
        ok: false,
      });
    }
  }

  printSummary(rows, opts, (Date.now() - started) / 1000);
  cdp.close();
  if (ctx.workshop) ctx.workshop.close();
  return rows.every((r) => r.ok) ? 0 : 1;
}

function printSummary(rows, opts, totalSecs) {
  const headers = ["场景", "文件", "尺寸", "体积", "备注"];
  const widths = [16, 22, 11, 10, 40];
  const line = (cells) => cells.map((c, i) => padRight(c, widths[i])).join(" ");
  console.log("\n" + "=".repeat(100));
  console.log(`采集汇总（输出目录：${opts.out}，deviceScaleFactor=${opts.dsf}，用时 ${totalSecs.toFixed(1)}s）`);
  console.log("-".repeat(100));
  console.log(line(headers));
  console.log("-".repeat(100));
  for (const r of rows) {
    console.log(line([r.ok ? r.scene : `✗ ${r.scene}`, r.file, r.size, r.bytes, r.note]));
  }
  console.log("=".repeat(100));
  const failed = rows.filter((r) => !r.ok);
  const skipped = rows.filter((r) => String(r.note ?? "").startsWith("跳过"));
  console.log(
    `共 ${rows.length} 个场景：成功 ${rows.length - failed.length - skipped.length}，失败 ${failed.length}，跳过 ${skipped.length}`,
  );
  if (failed.length > 0) {
    console.log("失败清单：");
    for (const f of failed) console.log(`  - ${f.scene}: ${f.note}`);
  }
}

// ------------------------------------------------------------------ dry-run

/**
/**
 * 自检（不启动应用）。验证的是「工具链本身能不能跑」，不是界面：
 *   ① PNG 编解码 / 透明底合成 / 裁剪 的像素级往返；
 *   ② CDP 客户端的请求-响应关联（含**乱序回包**）、错误传递、超时；
 *   ③ 截图链路（capture → 解码 → 合成 → 裁剪 → 落盘 → 回读）；
 *   ④ 场景表一致性：名字/文件名唯一，14 张旧图 + 2 张新图都在表里；
 *   ⑤ 真的写一个 PNG 到磁盘并打印汇总表，确认落盘与表格都正常。
 *
 * 说清楚它**不**验证什么：不验证 WebSocket 握手、不验证任何 DOM 选择器是否还存在于
 * 真实界面 —— 那两件事必须先有跑起来的应用。所以 dry-run 绿色不等于图能拍对。
 */
async function dryRun(opts) {
  const results = [];
  const pass = (name, note) => {
    results.push({ name, ok: true, note: note ?? "" });
    console.log(`  ✓ ${name}${note ? ` —— ${note}` : ""}`);
  };
  const fail = (name, err) => {
    results.push({ name, ok: false, note: err?.message ?? String(err) });
    console.log(`  ✗ ${name} —— ${err?.message ?? err}`);
  };
  /** 同步检查 */
  const check = (name, fn) => {
    try {
      pass(name, fn());
    } catch (err) {
      fail(name, err);
    }
  };
  /** 异步检查 */
  const checkAsync = async (name, fn) => {
    try {
      pass(name, await fn());
    } catch (err) {
      fail(name, err);
    }
  };

  console.log("\n== dry-run：不启动应用，自检工具链 ==\n");

  console.log("[1] PNG 编解码");
  let pngInfo = { width: 0, height: 0, bytes: 0 };
  check("encode → decode 逐像素一致 + 无透明通道", () => {
    pngInfo = selfTest();
    return `${pngInfo.width}×${pngInfo.height}，${fmtBytes(pngInfo.bytes)}`;
  });

  console.log("\n[2] CDP 客户端");
  await checkAsync("乱序回包也能按 id 关联到各自的请求", async () => {
    // 让 "slow" 的回包比 "fast" 晚 40ms —— 按到达顺序匹配的实现会在这里错配
    const transport = {
      onmessage: null,
      onclose: null,
      pendingSends: [],
      send(str) {
        const msg = JSON.parse(str);
        const isSlow = msg.params?.expression === "slow";
        this.pendingSends.push(msg);
        setTimeout(
          () => {
            // 先到的可能是后发的（fast），故意制造乱序
            this.onmessage?.(
              JSON.stringify({ id: msg.id, result: { result: { value: `echo:${msg.params.expression}` } } }),
            );
          },
          isSlow ? 40 : 0,
        );
      },
      close() {},
    };
    const cdp = new Cdp(transport, "out-of-order");
    const got = {};
    const p1 = cdp.evaluate("slow").then((v) => (got.slow = v));
    const p2 = cdp.evaluate("fast").then((v) => (got.fast = v));
    await Promise.all([p1, p2]);
    if (got.slow !== "echo:slow" || got.fast !== "echo:fast") {
      throw new Error(`回包错配：${JSON.stringify(got)}`);
    }
    return "slow / fast 各自拿到自己的结果";
  });

  await checkAsync("CDP error 转成抛错（不静默吞掉）", async () => {
    const cdp = new Cdp(
      new MockTransport(() => {
        throw new Error("页面炸了");
      }),
      "mock",
    );
    let caught = null;
    try {
      await cdp.evaluate("1+1");
    } catch (err) {
      caught = err;
    }
    if (!caught) throw new Error("错误没有传播出来");
    if (!/页面炸了/.test(caught.message)) throw new Error(`错误信息丢了：${caught.message}`);
    return caught.message.slice(0, 40);
  });

  await checkAsync("页面内异常（exceptionDetails）也能抛出来", async () => {
    const cdp = new Cdp(
      new MockTransport((method) => {
        if (method === "Runtime.evaluate") {
          return { result: { type: "undefined" }, exceptionDetails: { text: "ReferenceError", exception: { description: "foo is not defined" } } };
        }
        return {};
      }),
      "mock",
    );
    let caught = null;
    try {
      await cdp.evaluate("foo");
    } catch (err) {
      caught = err;
    }
    if (!caught || !/foo is not defined/.test(caught.message)) {
      throw new Error("页面异常没有被带出来");
    }
    return "带上了页面栈描述";
  });

  await checkAsync("无响应时按超时失败", async () => {
    const silent = { onmessage: null, onclose: null, send() {}, close() {} };
    const cdp = new Cdp(silent, "silent");
    const t0 = Date.now();
    let caught = null;
    try {
      await cdp.send("Page.enable", {}, { timeoutMs: 120 });
    } catch (err) {
      caught = err;
    }
    if (!caught) throw new Error("超时没有生效");
    return `${caught.message}（实测 ${Date.now() - t0}ms）`;
  });

  await checkAsync("连接关闭时未完成的请求全部拒绝", async () => {
    const transport = { onmessage: null, onclose: null, send() {}, close() {} };
    const cdp = new Cdp(transport, "closing");
    const p = cdp.send("Page.enable", {}, { timeoutMs: 5000 });
    transport.onclose?.();
    let caught = null;
    try {
      await p;
    } catch (err) {
      caught = err;
    }
    if (!caught || !/连接已关闭/.test(caught.message)) throw new Error("close 没有清掉挂起请求");
    return "挂起请求被拒";
  });

  console.log("\n[3] 截图链路");
  await checkAsync("waitFrames → capture → decode 通", async () => {
    const tiny = encodePng(flatten(new Img(4, 3, new Uint8Array(4 * 3 * 4).fill(200)), opts.bg));
    const cdp = new Cdp(
      new MockTransport((method) => {
        if (method === "Page.captureScreenshot") return { data: tiny.toString("base64") };
        return { result: { value: true } };
      }),
      "mock",
    );
    await cdp.waitFrames({ frames: 2, settleMs: 0 });
    const img = decodePng(await cdp.capture());
    if (img.width !== 4 || img.height !== 3) throw new Error("截图回包解码尺寸不对");
    return "rAF 包装 + capture 回包解析都正常";
  });

  await checkAsync("setViewport 发出的参数与 1280×820 一致", async () => {
    const seen = [];
    const cdp = new Cdp(
      new MockTransport((method, params) => {
        if (method === "Emulation.setDeviceMetricsOverride") seen.push(params);
        return {};
      }),
      "mock",
    );
    await cdp.setViewport({ ...MAIN_VIEWPORT, deviceScaleFactor: opts.dsf });
    if (seen.length !== 1) throw new Error("没有发出 setDeviceMetricsOverride");
    const p = seen[0];
    if (p.width !== 1280 || p.height !== 820) throw new Error(`视口不对：${p.width}×${p.height}`);
    if (p.deviceScaleFactor !== opts.dsf) throw new Error(`dsf 不对：${p.deviceScaleFactor}`);
    return `${p.width}×${p.height} @${p.deviceScaleFactor}×`;
  });

  console.log("\n[4] 场景表");
  check("场景名 / 输出文件名唯一", () => {
    const names = new Set();
    const outs = new Set();
    for (const s of SCENES) {
      if (names.has(s.name)) throw new Error(`场景名重复：${s.name}`);
      if (outs.has(s.out)) throw new Error(`输出文件名重复：${s.out}`);
      names.add(s.name);
      outs.add(s.out);
    }
    return `${SCENES.length} 个场景`;
  });
  check("README 引用的 14 张旧图都有对应场景", () => {
    const legacy = [
      "main.png",
      "view-list.png",
      "view-specimen.png",
      "detail.png",
      "online.png",
      "icons-overview.png",
      "trash.png",
      "quickbar.png",
      "palette.png",
      "contextmenu.png",
      "shortcuts.png",
      "libraries.png",
      "settings.png",
      "base.png",
    ];
    const have = new Set(SCENES.map((s) => s.out));
    const missing = legacy.filter((n) => !have.has(n));
    if (missing.length > 0) throw new Error(`缺场景：${missing.join(", ")}`);
    return "14/14（icons-overview 标记为跳过）";
  });
  check("插件中心新增的两张图在表里", () => {
    const have = new Set(SCENES.map((s) => s.out));
    for (const n of ["workshop.png", "workshop-upload.png"]) {
      if (!have.has(n)) throw new Error(`缺场景：${n}`);
    }
    return "workshop / workshop-upload";
  });
  check("每个可跑场景都有 run()", () => {
    const bad = SCENES.filter((s) => !s.skip && typeof s.run !== "function");
    if (bad.length > 0) throw new Error(bad.map((s) => s.name).join(", "));
    return "";
  });
  check("--only 过滤能命中、未知名会报错", () => {
    const one = pickScenes("main");
    if (one.length !== 1 || one[0].name !== "main") throw new Error("--only main 过滤不对");
    let threw = false;
    try {
      pickScenes("nope");
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("未知场景名应该抛错");
    return "过滤 + 报错都正常";
  });

  console.log("\n[5] 落盘");
  if (!fs.existsSync(opts.out)) fs.mkdirSync(opts.out, { recursive: true });
  const w = 320;
  const h = 200;
  const buf0 = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      buf0[i] = 240 - Math.floor((y / h) * 40);
      buf0[i + 1] = 244 - Math.floor((x / w) * 20);
      buf0[i + 2] = 250;
      // 左下角故意留透明，确认 flatten 真的把 alpha 拍掉了
      buf0[i + 3] = x < 20 && y > h - 20 ? 0 : 255;
    }
  }
  const demoBuf = encodePng(flatten(new Img(w, h, buf0), opts.bg));
  const demoPath = path.join(opts.out, "dryrun.png");
  let landOk = true;
  try {
    fs.writeFileSync(demoPath, demoBuf);
    const back = decodePng(fs.readFileSync(demoPath));
    if (back.width !== w || back.height !== h) throw new Error("落盘后回读尺寸不对");
    for (let i = 3; i < back.data.length; i += 4) {
      if (back.data[i] !== 255) throw new Error("落盘后仍有透明像素");
    }
    pass("写文件 + 回读校验", `${path.relative(REPO, demoPath)}，${fmtBytes(demoBuf.length)}`);
  } catch (err) {
    landOk = false;
    fail("写文件 + 回读校验", err);
  }

  const rows = SCENES.map((s) => ({
    scene: s.name,
    file: s.out,
    size: "-",
    bytes: "-",
    note: s.skip ? `跳过：${s.skip}` : "dry-run 未实际截图",
    ok: true,
  }));
  if (landOk) {
    rows.push({
      scene: "dryrun",
      file: "dryrun.png",
      size: `${w}×${h}`,
      bytes: fmtBytes(demoBuf.length),
      note: "自检图（纯合成）",
      ok: true,
    });
  }
  printSummary(rows, opts, 0);

  const failed = results.filter((r) => !r.ok);
  console.log(`\ndry-run 结论：${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  - ${f.name}: ${f.note}`);
  }
  return failed.length === 0 ? 0 : 1;
}

function printHelp() {
  console.log(
    [
      "用法：node tools/shoot-readme.mjs [选项]",
      "",
      "  --only a,b      只拍指定场景（--list 看全部）",
      "  --in-place      写到仓库根目录（覆盖旧图）；默认写 _tmp/readme-shots/",
      "  --out <dir>     自定义输出目录",
      "  --dsf <n>       deviceScaleFactor，默认 1.25（1280×820 → 1600×1025）",
      "  --bg <#rrggbb>  透明像素底色，默认 #ffffff",
      "  --port <n>      CDP 端口，默认 9223",
      "  --exe <path>    --launch 用的 exe",
      "  --launch        9223 没人应答时自己拉起应用",
      "  --build         先构建（vite build + tauri build --no-bundle）",
      "  --dry-run       自检工具链，不启动应用",
      "  --list          列出场景表",
      "  --verbose       打印每一步",
      "",
      "构建带 9223 的可运行 exe（先 source ../env.sh）：",
      '  npx vite build && CARGO_TARGET_DIR="_tmp/shoot-target" npx tauri build \\',
      "    --config _tauri.nobuild.json --config _tauri.local.json --no-bundle",
    ].join("\n"),
  );
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (opts.help) {
    printHelp();
    return 0;
  }
  if (opts.list) {
    console.log("场景表：");
    for (const s of SCENES) {
      console.log(`  ${padRight(s.name, 18)} → ${padRight(s.out, 22)} ${s.skip ? `[跳过] ${s.skip}` : s.title}`);
    }
    return 0;
  }
  if (opts.dryRun) return await dryRun(opts);
  return await collect(opts);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error("\n未捕获异常：", err);
    process.exitCode = 1;
  },
);
