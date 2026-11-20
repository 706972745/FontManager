import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * 托盘自绘菜单的逻辑（tray.html 的脚本，独立 vite 入口）。
 *
 * 职责边界：这里**只渲染 + invoke**。窗口的创建 / 定位 / 显示 / 失焦隐藏全在
 * Rust 侧（lib.rs 的 open_tray_menu / build_tray_menu_window）；每次显示 Rust 会
 * emit `tray://show`，本页收到后重新拉一次 `tray_menu_data`（库列表 / 当前语言
 * 可能已经变了）并重放入场动画。
 *
 * 为什么不进 i18n 体系：独立页不加载 React 应用、不参与 i18n:check，九语文案
 * 就维护在下面的 L10N 常量（tray.html 文件头注释有指引）。其中**插件中心 /
 * 设置 / 检查更新各状态**的译名照抄 src/locales 的对应 key（来源写在表旁），
 * 别另造一套。
 *
 * 检查更新只调用 `check_update`（force=true）：**只读版本号，绝不触发
 * download / install 路径** —— 结果直接写在这一项的文字上，3 秒后恢复。
 */

/** 后端 `tray_menu_data` 的载荷（camelCase，Rust 侧 rename_all） */
interface TrayMenuData {
  /** 库列表（关掉自定义库 = 空数组；len <= 1 时不渲染切换项） */
  libs: TrayLib[];
  /** 语言偏好：九语之一或 "system" */
  langPref: string;
  /** 主题偏好："light" | "dark" | "system" */
  theme: string;
  version: string;
}

interface TrayLib {
  /** 库目录（切库时原样传回 tray_switch_library） */
  dir: string;
  /** 目录名（显示用） */
  name: string;
  /** 当前生效的库 */
  active: boolean;
}

/** `check_update` 返回里托盘用得到的字段（其余字段见 update.rs 的 UpdateInfo） */
interface UpdateBrief {
  current: string;
  latest: string;
  has_update: boolean;
}

/** 九种界面语言（与 src/lib/i18n.ts 的 LOCALES 同一份口径，顺序一致） */
const LOCALE_CODES = [
  "en",
  "de",
  "es",
  "fr",
  "pt-BR",
  "ru",
  "ja",
  "zh-CN",
  "zh-TW",
] as const;

type LocaleCode = (typeof LOCALE_CODES)[number];

/**
 * 九语文案表。每列一种语言；译名来源：
 * - pluginCenter ← locales 的 `side.pluginCenter`；
 * - settings ← locales 的 `settings.title`；
 * - checkUpdate / checking / failed ← locales 的 `settings.updateCheck` /
 *   `settings.updateChecking` / `settings.updateFailed`；
 * - openMain / libs / langs / upToDate / found / quit ← 本表原创（主包没有对应词条）。
 */
const L10N: Record<LocaleCode, Record<TrayKey, string>> = {
  en: {
    openMain: "Open FontManager",
    pluginCenter: "Plugin Center",
    settings: "Settings",
    libs: "Switch font library",
    langs: "Switch language",
    checkUpdate: "Check for updates",
    checking: "Checking…",
    upToDate: "You're up to date",
    found: "New version {v} available",
    failed: "Couldn't check, try again later",
    quit: "Quit",
  },
  de: {
    openMain: "FontManager öffnen",
    pluginCenter: "Plugin-Center",
    settings: "Einstellungen",
    libs: "Schriftbibliothek wechseln",
    langs: "Sprache wechseln",
    checkUpdate: "Jetzt prüfen",
    checking: "Wird geprüft…",
    upToDate: "Alles aktuell",
    found: "Neue Version {v} verfügbar",
    failed: "Prüfung fehlgeschlagen, später erneut versuchen",
    quit: "Beenden",
  },
  es: {
    openMain: "Abrir FontManager",
    pluginCenter: "Centro de plugins",
    settings: "Ajustes",
    libs: "Cambiar biblioteca de fuentes",
    langs: "Cambiar idioma",
    checkUpdate: "Comprobar ahora",
    checking: "Comprobando…",
    upToDate: "Ya está actualizado",
    found: "Nueva versión {v} disponible",
    failed: "No se pudo comprobar, inténtalo más tarde",
    quit: "Salir",
  },
  fr: {
    openMain: "Ouvrir FontManager",
    pluginCenter: "Centre de plugins",
    settings: "Réglages",
    libs: "Changer de bibliothèque de polices",
    langs: "Changer de langue",
    checkUpdate: "Vérifier maintenant",
    checking: "Vérification…",
    upToDate: "Déjà à jour",
    found: "Nouvelle version {v} disponible",
    failed: "Vérification impossible, réessayez plus tard",
    quit: "Quitter",
  },
  "pt-BR": {
    openMain: "Abrir o FontManager",
    pluginCenter: "Central de Plugins",
    settings: "Configurações",
    libs: "Trocar biblioteca de fontes",
    langs: "Trocar idioma",
    checkUpdate: "Verificar agora",
    checking: "Verificando…",
    upToDate: "Você está atualizado",
    found: "Nova versão {v} disponível",
    failed: "Não foi possível verificar, tente mais tarde",
    quit: "Sair",
  },
  ru: {
    openMain: "Открыть FontManager",
    pluginCenter: "Центр плагинов",
    settings: "Настройки",
    libs: "Сменить библиотеку шрифтов",
    langs: "Сменить язык",
    checkUpdate: "Проверить сейчас",
    checking: "Проверка…",
    upToDate: "У вас последняя версия",
    found: "Доступна новая версия {v}",
    failed: "Не удалось проверить, попробуйте позже",
    quit: "Выход",
  },
  ja: {
    openMain: "FontManager を開く",
    pluginCenter: "プラグインセンター",
    settings: "設定",
    libs: "フォントライブラリを切り替え",
    langs: "言語を切り替え",
    checkUpdate: "今すぐ確認",
    checking: "確認中…",
    upToDate: "最新です",
    found: "新しいバージョン {v} があります",
    failed: "確認できませんでした。後でもう一度",
    quit: "終了",
  },
  "zh-CN": {
    openMain: "打开主界面",
    pluginCenter: "插件中心",
    settings: "设置",
    libs: "切换字体库",
    langs: "切换语言",
    checkUpdate: "检查更新",
    checking: "检查中…",
    upToDate: "已是最新",
    found: "发现新版 {v}",
    failed: "检查失败，稍后再试",
    quit: "退出软件",
  },
  "zh-TW": {
    openMain: "開啟主介面",
    pluginCenter: "插件中心",
    settings: "設定",
    libs: "切換字體庫",
    langs: "切換語言",
    checkUpdate: "檢查更新",
    checking: "正在檢查…",
    upToDate: "已是最新",
    found: "發現新版 {v}",
    failed: "檢查失敗，稍後再試",
    quit: "結束軟體",
  },
};

type TrayKey =
  | "openMain"
  | "pluginCenter"
  | "settings"
  | "libs"
  | "langs"
  | "checkUpdate"
  | "checking"
  | "upToDate"
  | "found"
  | "failed"
  | "quit";

/** 语言在菜单里的**自称**（不翻译：用户按母语认自己的语言，主包 LOCALES 同口径） */
const LOCALE_NAMES: Record<LocaleCode, string> = {
  en: "English",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  "pt-BR": "Português (Brasil)",
  ru: "Русский",
  ja: "日本語",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
};

/** 与 i18n.ts 的 REGION_HINTS 同一小份（托盘解析 "system" 只用得上这几条） */
const REGION_HINTS: Record<string, LocaleCode> = {
  zh: "zh-CN",
  "zh-hans": "zh-CN",
  "zh-cn": "zh-CN",
  "zh-sg": "zh-CN",
  "zh-my": "zh-CN",
  "zh-hant": "zh-TW",
  "zh-tw": "zh-TW",
  "zh-hk": "zh-TW",
  "zh-mo": "zh-TW",
  pt: "pt-BR",
  "pt-pt": "pt-BR",
};

/** "system"（或坏值）→ 按 navigator.languages 逐级匹配；与 i18n.ts 同判据 */
function resolveLocale(langPref: string): LocaleCode {
  if ((LOCALE_CODES as readonly string[]).includes(langPref)) {
    return langPref as LocaleCode;
  }
  const tags =
    typeof navigator !== "undefined" && navigator.languages?.length
      ? navigator.languages
      : [navigator.language];
  for (const tag of tags) {
    if (!tag) continue;
    const lower = tag.toLowerCase();
    if ((LOCALE_CODES as readonly string[]).includes(lower)) return lower as LocaleCode;
    if (REGION_HINTS[lower]) return REGION_HINTS[lower];
    const primary = lower.split("-")[0];
    if (REGION_HINTS[primary]) return REGION_HINTS[primary];
    const byPrimary = (LOCALE_CODES as readonly string[]).find(
      (c) => c.toLowerCase().split("-")[0] === primary,
    );
    if (byPrimary) return byPrimary as LocaleCode;
  }
  return "en";
}

/** 文案插值：{v} → 版本号 */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole);
}

/** 菜单用的 16px 线性图标（lucide 的几何，独立页引不了包，内联最小 SVG） */
const ICONS: Record<string, string> = {
  main: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg>',
  puzzle:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 7V5a2 2 0 1 0-4 0v2H7a2 2 0 0 0-2 2v3h2a2 2 0 1 1 0 4H5v3a2 2 0 0 0 2 2h3v-2a2 2 0 1 1 4 0v2h3a2 2 0 0 0 2-2v-3h-2a2 2 0 1 1 0-4h2V9a2 2 0 0 0-2-2h-3z"/></svg>',
  gear: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  globe:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/></svg>',
  refresh:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>',
  power:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v8"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/></svg>',
};

// ───────────────── 渲染 ─────────────────

let root: HTMLElement | null = null;
/** 检查更新进行中：防重入，且 tray://show 的重渲染要避开这一项 */
let updateBusy = false;
/** 最近一次渲染的数据（重渲染时复用；preview 模式下就是模拟数据） */
let lastData: TrayMenuData | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 一行普通菜单项（图标 + 文案 + 动作）。动作由 Rust 命令完成，本页只 invoke。 */
function actionRow(
  icon: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const row = el("button", "trm-item");
  row.type = "button";
  const ico = el("span", "trm-ico");
  ico.innerHTML = icon;
  row.appendChild(ico);
  row.appendChild(el("span", "trm-label", label));
  row.addEventListener("click", onClick);
  return row;
}

/** 一行子选项（库目录 / 语言名），选中态 = 底色 + 左侧 2px 竖线 + 文字色 */
function optionRow(
  label: string,
  hint: string | null,
  selected: boolean,
  onClick: () => void,
): HTMLButtonElement {
  const row = el("button", "trm-opt" + (selected ? " sel" : ""));
  row.type = "button";
  row.appendChild(el("span", "trm-name", label));
  // 库行在名字右侧带一个弱化的目录尾段（多个库同名时靠它分辨）
  if (hint) row.appendChild(el("span", "trm-dir", hint));
  row.addEventListener("click", onClick);
  return row;
}

function groupLabel(text: string): HTMLElement {
  return el("div", "trm-group", text);
}

/** 检查更新项：点击后文字在原地变状态，3 秒后恢复（不弹设置页、不下载安装） */
function updateRow(label: string): HTMLButtonElement {
  const row = actionRow(ICONS.refresh, label, () => void runUpdateCheck(row));
  row.dataset.label = label;
  return row;
}

async function runUpdateCheck(row: HTMLButtonElement): Promise<void> {
  if (updateBusy) return;
  const copy = L10N[resolveLocale(lastData?.langPref ?? "system")];
  updateBusy = true;
  row.disabled = true;
  row.classList.add("trm-update-state", "trm-update-busy");
  row.querySelector(".trm-label")!.textContent = copy.checking;
  const restore = (): void => {
    row.classList.remove("trm-update-state", "trm-update-busy", "trm-update-found", "trm-update-failed");
    row.querySelector(".trm-label")!.textContent = row.dataset.label ?? "";
    row.disabled = false;
    updateBusy = false;
  };
  try {
    const info = await invoke<UpdateBrief>("check_update", { force: true });
    const done = (): void => {
      // 3 秒后恢复原文案；期间窗口被藏起也照走（重渲染时会重建这一项）
      window.setTimeout(restore, 3000);
    };
    row.classList.remove("trm-update-busy");
    if (info?.has_update) {
      row.classList.add("trm-update-found");
      row.querySelector(".trm-label")!.textContent = fill(copy.found, { v: info.latest });
    } else {
      row.classList.add("trm-update-failed");
      row.querySelector(".trm-label")!.textContent = copy.upToDate;
    }
    done();
  } catch {
    // 无网络 / 接口失败：说人话，绝不静默
    row.classList.remove("trm-update-busy");
    row.classList.add("trm-update-failed");
    row.querySelector(".trm-label")!.textContent = copy.failed;
    window.setTimeout(restore, 3000);
  }
}

/** 按数据整棵重建菜单内容（每次显示都重建一次，几十个节点的开销可以忽略） */
function render(data: TrayMenuData): void {
  if (!root) return;
  lastData = data;
  const locale = resolveLocale(data.langPref);
  const copy = L10N[locale];
  root.replaceChildren();

  // 排序（主理人定）：打开主界面 → 插件中心 → 设置 → 字体库切换（条件）→
  // 切换语言 → 检查更新 → 分隔线 → 退出软件
  root.appendChild(
    actionRow(ICONS.main, copy.openMain, () => void invoke("tray_open_main", { target: "main" })),
  );
  root.appendChild(
    actionRow(ICONS.puzzle, copy.pluginCenter, () =>
      void invoke("tray_open_main", { target: "pluginCenter" }),
    ),
  );
  root.appendChild(
    actionRow(ICONS.gear, copy.settings, () => void invoke("tray_open_main", { target: "settings" })),
  );

  // 「切换字体库」只在多库时渲染（判定在数据侧：libs.len() <= 1 整组不渲染）
  if (data.libs.length > 1) {
    root.appendChild(groupLabel(copy.libs));
    for (const lib of data.libs) {
      root.appendChild(
        optionRow(
          lib.name,
          lib.name === baseName(lib.dir) ? null : tailOf(lib.dir),
          lib.active,
          () => void invoke("tray_switch_library", { dir: lib.dir }),
        ),
      );
    }
  }

  root.appendChild(groupLabel(copy.langs));
  for (const code of LOCALE_CODES) {
    root.appendChild(
      optionRow(LOCALE_NAMES[code], null, code === locale, () =>
        void invoke("tray_set_locale", { code }),
      ),
    );
  }

  root.appendChild(updateRow(copy.checkUpdate));
  root.appendChild(el("div", "trm-sep"));
  root.appendChild(
    actionRow(ICONS.power, copy.quit, () => void invoke("tray_quit")),
  );
}

/** 目录末段（弱化提示），路径分隔符兼容两种写法 */
function tailOf(dir: string): string {
  const norm = dir.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/** 目录名与末段一致时不再重复显示提示 */
function baseName(dir: string): string {
  return tailOf(dir);
}

/** 重放入场动画（窗口复用，页面不重载，动画要手动放） */
function replayEntrance(): void {
  if (!root) return;
  root.classList.remove("in");
  // 强制回流才能让同一个动画重放
  void root.offsetWidth;
  root.classList.add("in");
}

// ───────────────── 启动 ─────────────────

/** 离线预览：?preview=1 时不用 Tauri，全部数据来自 URL 参数（截图核对用） */
function previewData(): TrayMenuData | null {
  const params = new URLSearchParams(location.search);
  if (params.get("preview") !== "1") return null;
  const count = Math.max(0, Math.min(3, Number(params.get("libs") ?? "0")));
  const names = ["默认字体库", "插画组共享库", "备用库"];
  const libs: TrayLib[] = Array.from({ length: count }, (_, i) => ({
    dir: `C:/字体库/${names[i] ?? `库${i + 1}`}`,
    name: names[i] ?? `库${i + 1}`,
    active: i === 0,
  }));
  return {
    libs,
    langPref: params.get("lang") ?? "zh-CN",
    theme: params.get("theme") ?? "system",
    version: "preview",
  };
}

async function main(): Promise<void> {
  root = document.getElementById("trm");
  if (!root) return;

  const preview = previewData();
  if (preview) {
    // 预览模式：主题同样走「强制属性 > @media」，并给页面一个中性底色，
    // 否则无头截图落到透明通道上看不清
    if (preview.theme === "light" || preview.theme === "dark") {
      document.documentElement.dataset.theme = preview.theme;
    }
    document.body.style.background = preview.theme === "light" ? "#e7eaf0" : "#2a2a30";
    render(preview);
    root.classList.add("in");
    return;
  }

  // 正式模式：先按现有偏好渲染一帧，之后每次 tray://show 重拉一次。
  // 首帧拉不到（后端极端时序）不致命 —— 下面的 show 监听每次都会再试。
  const refresh = async (): Promise<void> => {
    if (updateBusy) return;
    try {
      const data = await invoke<TrayMenuData>("tray_menu_data");
      // 主题可能变了（用户在主窗口里换了深浅色）：每次都校正一次。
      // system 不写属性，交给 tray.html 的 @media（与 splash 同口径）。
      if (data.theme === "light" || data.theme === "dark") {
        document.documentElement.dataset.theme = data.theme;
      } else {
        delete document.documentElement.dataset.theme;
      }
      render(data);
    } catch {
      // 拉不到就维持现状：菜单空着也比崩掉好，下次 show 再试
    }
  };
  await refresh();

  // Rust 侧每次 show 菜单都会发这个事件：重拉数据 + 重放动画。
  // 检查更新进行中不重建（会把「检查中…」的结果态冲掉），只重放动画。
  // 页面与窗口同寿命（失焦只是 hide），无需解绑。
  void listen("tray://show", () => {
    void refresh();
    replayEntrance();
  }).catch(() => {});

  // Esc 收起（点别处由 Rust 侧失焦 hide 兜底）
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") void invoke("tray_menu_hide");
  });
}

void main();
