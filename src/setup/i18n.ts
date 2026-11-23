/**
 * 安装器 / 卸载器（路线 C）的双语字典。
 *
 * 为什么要独立一份：setup 是独立 vite 入口，**不能** import 主应用的
 * `src/lib/i18n.ts` —— 那个模块会把 React 一起拉进安装器 bundle（规格书 §9.5 C1）。
 *
 * 两种取词方式：
 *   · `t(key, vars)` —— main.ts 里的动态文案（带版本号 / 路径 / 秒数）；
 *   · `applyStatic()` —— setup.html 里写死的静态文案。为不改动 47 处 DOM 结构，
 *     这里按「中文原文（空白归一化）」做映射，启动时把文本节点整体换成英文。
 *     只在拿到 `setup_env.lang` 之后调用一次；那时 body 还没加 `.ready`（不可见），
 *     不会闪中文。
 */
export type Lang = "zh" | "en";

const STATIC_EN: Record<string, string> = {
  "© 2026 IIEOzo. 保留所有权利。": "© 2026 IIEOzo. All rights reserved.",
  "你的全部字体，一键启停，永不离开你的电脑。":
    "All your fonts, on and off with one click — never leaving your computer.",
  "程序、字体库和全部数据都装在下面这个目录里 —— 想整体搬走，直接搬这个文件夹就行。（Python / Node 运行时按需下载，不在安装包内。）":
    "The app, your font library and all your data live in the folder below — to move everything, just move the folder. (Python / Node runtimes download on demand; they are not in the installer.)",
  "准备就绪 · 即将开始安装": "Ready · about to install",
  "预计 5 秒 · 无需管理员权限": "About 5 seconds · no administrator rights needed",
  "安装位置": "Install location",
  "需要空间": "Space needed",
  "包含内容": "Included",
  "程序本体 · 卸载程序": "App · uninstaller",
  "数据目录": "Data folder",
  "取消": "Cancel",
  "继续": "Continue",
  "选择安装位置": "Choose install location",
  "换一个盘，字体库、缓存和全部数据都跟着走。":
    "Switch drives and your library, cache and all data move with it.",
  "浏览…": "Browse…",
  "完成后": "When done",
  "程序 + data 全部在此目录": "App + data all in this folder",
  "卸载时": "On uninstall",
  "可选「同时删除数据」，默认只删程序":
    "Optional “delete data”; by default only the app is removed",
  "返回": "Back",
  "安装": "Install",
  "正在安装…": "Installing…",
  "取消安装": "Cancel install",
  "安装完成": "Installed",
  "立即运行 FontManager": "Launch FontManager now",
  "在桌面创建快捷方式": "Create a desktop shortcut",
  "打开安装目录": "Open install folder",
  "完成": "Done",
  "卸载 FontManager": "Uninstall FontManager",
  "将从这台电脑移除 FontManager。程序文件、卸载程序和开始菜单项都会被删除。":
    "This will remove FontManager from this computer. The app, uninstaller and Start menu entry will be deleted.",
  "你的字体库、分组、快照与设置默认保留 —— 重新安装会直接接上。":
    "Your font library, groups, snapshots and settings are kept by default — reinstalling picks up right where you left off.",
  "这台电脑上找不到 FontManager 的卸载信息 —— 可能已经卸载过，或安装时没有写入注册表。":
    "FontManager's uninstall information couldn't be found on this computer — it may already be uninstalled, or the installer couldn't write to the registry.",
  "占用空间": "Space used",
  "同时删除全部数据与字体库": "Also delete all data and the font library",
  "包含字体库、分组、快照与全部设置 —— 删除后无法恢复。":
    "Includes your font library, groups, snapshots and all settings — this cannot be undone.",
  "卸载": "Uninstall",
  "正在移除…": "Uninstalling…",
  "卸载完成": "Uninstalled",
  "关闭": "Close",
  "你的字体 · 你的电脑 · 你的决定": "Your fonts · your computer · your choice",
  "FontManager 正在运行": "FontManager is running",
  "关闭时，正在进行的操作会丢失。": "Your current work will be lost when it closes.",
  "关闭软件并继续": "Close and continue",
  "要取消安装吗？": "Cancel the install?",
  "已经写进安装目录的文件会被删除；如果这个目录是本次安装才新建的，目录本身也会一并清掉。":
    "Files already written to the install folder will be removed; if this folder was created for this install, the folder itself will also be removed.",
  "你的字体库和已有数据不受影响。": "Your font library and existing data are not affected.",
  "继续安装": "Keep installing",
};

const ATTR_EN: Record<string, string> = {
  "最小化": "Minimize",
  "关闭": "Close",
};

const DYN = {
  "install.size": { zh: "约 {size}", en: "About {size}" },
  "install.dataDir": { zh: "<安装目录>\\data", en: "<install folder>\\data" },
  "install.eta.admin": {
    zh: "预计 5 秒 · 当前已是管理员权限",
    en: "About 5 seconds · already running as administrator",
  },
  "install.eta.normal": {
    zh: "预计 5 秒 · 无需管理员权限",
    en: "About 5 seconds · no administrator rights needed",
  },
  "install.upgrade": {
    zh: "检测到已安装 {v} · 将直接覆盖升级",
    en: "Found {v} installed · it will be upgraded in place",
  },
  "install.ready": { zh: "准备就绪 · 即将开始安装", en: "Ready · about to install" },
  "install.demo": {
    zh: "演练模式 · 当前没有可驱动的安装包",
    en: "Demo mode · no installer to drive",
  },
  "install.demoSub": {
    zh: "只走界面流程，不写注册表、不落文件",
    en: "UI walkthrough only — no registry or files are written",
  },
  "install.running": {
    zh: "FontManager 正在运行 · 安装前会请你先关闭",
    en: "FontManager is running · you'll be asked to close it before installing",
  },
  "install.runningSub": {
    zh: "检测到 {n} 个正在运行的实例（不影响继续）",
    en: "{n} running instance(s) detected (you can continue)",
  },
  "uninstall.notDetected": { zh: "（未检测到安装）", en: "(not installed)" },
  "uninstall.data": { zh: "{path}（{size}）", en: "{path} ({size})" },
  "uninstall.notInstalled": { zh: "未安装", en: "Not installed" },
  "run.title": { zh: "FontManager 正在运行", en: "FontManager is running" },
  "run.body.install": {
    zh: "检测到 {n} 个 FontManager 进程正在运行。安装需要替换程序文件，得先把它们关掉 —— 否则文件被占用，会出现「装完了版本还是旧的」。",
    en: "Found {n} FontManager process(es) running. Installing replaces the app files, so they need to close first — otherwise the files stay locked and the version won't change after installing.",
  },
  "run.body.uninstall": {
    zh: "检测到 {n} 个 FontManager 进程正在运行。卸载需要删除程序文件，得先把它们关掉 —— 否则文件删不掉，只能留到下次开机再清理。",
    en: "Found {n} FontManager process(es) running. Uninstalling deletes the app files, so they need to close first — otherwise they can't be removed and will be left for the next boot.",
  },
  "run.note.install": {
    zh: "关闭时，正在进行的操作会丢失。",
    en: "Your current work will be lost when it closes.",
  },
  "run.note.uninstall": {
    zh: "关闭软件不会动你的字体库与设置。",
    en: "Closing the app won't touch your font library or settings.",
  },
  "run.left": {
    zh: "还有 {n} 个 FontManager 进程没能关闭（可能以管理员身份运行）。请手动退出 FontManager 后再试。",
    en: "{n} FontManager process(es) still couldn't be closed (they may be running as administrator). Quit FontManager manually and try again.",
  },
  "run.failed": {
    zh: "无法结束正在运行的 FontManager，请手动退出后再试。",
    en: "Couldn't close the running FontManager. Quit it manually and try again.",
  },
  "install.failed": { zh: "安装失败", en: "Install failed" },
  "install.logPath": {
    zh: "详细日志：%TEMP%\\FontManager-setup.log",
    en: "Details: %TEMP%\\FontManager-setup.log",
  },
  "install.retry": { zh: "重试", en: "Retry" },
  "install.back": { zh: "返回", en: "Back" },
  "install.demoTitle": { zh: "演练完成", en: "Demo complete" },
  "install.demoBody": {
    zh: "界面流程已经走完，但这次没有写任何文件、也没有改注册表 —— 因为没有可驱动的安装包（--setup-exe 未传入）。",
    en: "The UI walkthrough is complete, but nothing was written and no registry keys were changed — there was no installer to drive (--setup-exe was not passed).",
  },
  "install.doneTitle": { zh: "安装完成", en: "Installed" },
  "install.doneBody": {
    zh: "FontManager {v} 已安装。数据在安装目录的 data 文件夹，卸载时你可以决定是否保留。",
    en: "FontManager {v} is installed. Your data lives in the data folder next to the app; you choose on uninstall whether to keep it.",
  },
  "install.installing": { zh: "正在安装…", en: "Installing…" },
  "install.elapsedZero": { zh: "已用 0 秒", en: "0 s elapsed" },
  "install.elapsed": { zh: "已用 {s} 秒", en: "{s} s elapsed" },
  "install.elapsedWarn": {
    zh: "已用 {s} 秒 · 正在写入，请勿关闭窗口",
    en: "{s} s elapsed · writing files, don't close this window",
  },
  "uninstall.failed": { zh: "卸载失败", en: "Uninstall failed" },
  "uninstall.removing": { zh: "正在移除…", en: "Uninstalling…" },
  "uninstall.donePurged": {
    zh: "FontManager 已从这台电脑移除，你的数据与字体库也已全部删除。",
    en: "FontManager has been removed from this computer, and all your data and fonts have been deleted.",
  },
  "uninstall.doneKept": {
    zh: "FontManager 已从这台电脑移除。你的数据保留在 {path}，重新安装会直接接上。",
    en: "FontManager has been removed from this computer. Your data is kept at {path}; reinstalling picks up right where you left off.",
  },
  "install.cancelling": { zh: "正在取消…", en: "Cancelling…" },
  "install.checking": { zh: "正在检查这个位置…", en: "Checking this location…" },
  "boot.failed": { zh: "安装界面启动失败：", en: "The installer UI failed to start:" },
  "boot.resource": { zh: "资源加载失败：", en: "Failed to load resource: " },
  "boot.promise": { zh: "Promise 未处理：", en: "Unhandled promise: " },
  "boot.unknown": { zh: "未知错误", en: "Unknown error" },
};

let current: Lang = "zh";

/** 系统语言 → 安装器语言：任何中文都算中文，其余一律英文。 */
export function detectLang(): Lang {
  const tag =
    typeof navigator !== "undefined"
      ? (navigator.languages?.[0] || navigator.language || "").toLowerCase()
      : "";
  return tag.startsWith("zh") ? "zh" : "en";
}

export function setLang(lang: Lang): void {
  current = lang;
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const entry = (DYN as Record<string, { zh: string; en: string }>)[key];
  let s = entry ? entry[current] : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** 把 setup.html 里写死的中文文案换成英文（只做一次，在 `.ready` 之前）。 */
export function applyStatic(): void {
  if (current !== "en") return;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    const raw = node.nodeValue ?? "";
    const key = norm(raw);
    const hit = STATIC_EN[key];
    if (hit) node.nodeValue = hit;
    node = walker.nextNode();
  }

  document.querySelectorAll<HTMLElement>("[title]").forEach((el) => {
    const v = el.getAttribute("title");
    if (v && ATTR_EN[v]) el.setAttribute("title", ATTR_EN[v]);
  });
}
