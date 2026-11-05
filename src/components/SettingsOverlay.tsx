import { open, save } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowUpRight,
  BookOpen,
  DatabaseBackup,
  Eye,
  FolderOpen,
  FolderSync,
  Info,
  Languages,
  MessageSquarePlus,
  Scaling,
  SunMoon,
  Volume2,
  X,
} from "lucide-react";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { LoaderCircle } from "lucide-react";
import { ArtIcon } from "./ArtIcon";
import { PillToggle } from "../design/primitives/PillToggle";
import { springSoft } from "../design/springs";
import { ipc } from "../lib/ipc";
import { toast } from "../design/primitives/Toast";
import { useFontStore } from "../state/fontStore";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useModalLayer } from "../lib/modalLayer";
import { useT } from "../lib/i18n";
import { LanguageSelect } from "./LanguageSelect";
import { LabelResyncDialog } from "./LabelResyncDialog";
import { APP_LICENSE, displayVersion } from "../lib/version";
import { DEFAULT_HOTKEY, hotkeyFromEvent } from "../lib/hotkey";

const IS_LINUX = navigator.platform.toUpperCase().includes("LINUX");

const TRANSLATE_GUIDE_URL =
  "https://github.com/TheHolyOneZ/FontManager/blob/main/docs/TRANSLATING.md";

const REQUEST_LANGUAGE_URL =
  "https://github.com/TheHolyOneZ/FontManager/issues/new?title=Language%20request%3A%20";

/** 「导出时连字体一起打包」的记忆位（本机习惯，不进 state.json） */
const EXPORT_FONTS_KEY = "zfm.exportFonts";

/** 最多保存几个字体库地址（与后端 store::MAX_LIBRARY_DIRS 一致） */
const MAX_LIBRARY_DIRS = 3;

/** 保存对话框的默认文件名：ZFonts-2026-11-03.P-FontManager */
function packFileName(now = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `ZFonts-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.P-FontManager`;
}

/**
 * 说明性小字的「悬停版」（2026-11-04 用户要求）。
 *
 * 原来每条设置项下面都压着一行灰色说明，一屏里一半是解释文字，扫读时反而找不到设置项本身。
 * 现在说明收进标题右侧的 ⓘ，悬停 1 秒由全局 <HoverHintHost> 弹出，和项目里其它按钮同一套机制。
 *
 * 边界：**只收「说明」**。连接状态、扫描进度、去重结果这类实时信息必须常驻，
 * 收进悬停里就等于让用户看不见当前状态了。
 */
function SettingHint({ text }: { text: string }) {
  return (
    <span className="settings-hint" data-hint-text={text} role="img" aria-label={text} tabIndex={0}>
      <Info size={12} strokeWidth={1.7} />
    </span>
  );
}

/**
 * radiogroup 的方向键 + roving tabindex（§5 第 30 条残留）。
 * 全局方向键是「换选中字族」的，不拦住的话在设置里按 ←/→ 动的是背后看不见的列表。
 * 焦点移动即选中（原生 radio 语义），Tab 只在当前选项上停一次。
 */
function radioKeys(e: ReactKeyboardEvent<HTMLDivElement>) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")].filter(
    (b) => !b.disabled && b.offsetParent !== null,
  );
  if (items.length === 0) return;
  e.preventDefault();
  e.stopPropagation();
  const cur = items.indexOf(document.activeElement as HTMLButtonElement);
  const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
  const next = items[(cur + dir + items.length) % items.length];
  next.focus();
  next.click();
}

export function SettingsOverlay() {
  const t = useT();
  const openState = useFontStore((s) => s.settingsOpen);
  // 只有本层在弹层栈顶时才吃 Escape（§5 第 8 条：上层弹窗开着不能把下层关掉）
  const isTopLayer = useModalLayer(openState);
  const setSettingsOpen = useFontStore((s) => s.setSettingsOpen);
  const settings = useFontStore((s) => s.settings);
  const updateSettings = useFontStore((s) => s.updateSettings);
  const motionPref = useFontStore((s) => s.motionPref);
  const setMotionPref = useFontStore((s) => s.setMotionPref);
  const transparencyPref = useFontStore((s) => s.transparencyPref);
  const setTransparencyPref = useFontStore((s) => s.setTransparencyPref);
  const uiScale = useFontStore((s) => s.uiScale);
  const appliedScale = useFontStore((s) => s.appliedScale);
  const setUiScale = useFontStore((s) => s.setUiScale);
  const soundPref = useFontStore((s) => s.soundPref);
  const setSoundPref = useFontStore((s) => s.setSoundPref);
  const themePref = useFontStore((s) => s.themePref);
  const setThemePref = useFontStore((s) => s.setThemePref);
  const scanning = useFontStore((s) => s.phase === "scanning");
  const scanProgress = useFontStore((s) => s.scanProgress);
  const trapRef = useFocusTrap<HTMLDivElement>(openState);
  const [defaultLibDir, setDefaultLibDir] = useState("");
  const closeToTray = useFontStore((s) => s.closeToTray);
  const setCloseToTray = useFontStore((s) => s.setCloseToTray);
  const startMinimized = useFontStore((s) => s.startMinimized);
  const setStartMinimized = useFontStore((s) => s.setStartMinimized);
  const restoreOnLaunch = useFontStore((s) => s.restoreOnLaunch);
  const setRestoreOnLaunch = useFontStore((s) => s.setRestoreOnLaunch);
  const quickbarHotkey = useFontStore((s) => s.quickbarHotkey);
  const setQuickbarHotkey = useFontStore((s) => s.setQuickbarHotkey);
  const quickbarHotkeyOpens = useFontStore((s) => s.quickbarHotkeyOpens);
  const setQuickbarHotkeyOpens = useFontStore((s) => s.setQuickbarHotkeyOpens);
  /** 正在录制新快捷键：这段时间拦截所有按键，别让它们落到页面别处 */
  const [recording, setRecording] = useState(false);
  const [autostart, setAutostart] = useState(false);
  /** 开机自启的读取代次：晚到的旧读取不许覆盖用户刚改的值（§5 第 25 条） */
  const autostartReadGen = useRef(0);
  /** 开机自启的保存代次：只回滚「最后一次」的失败，别把后来成功的值拨回去 */
  const autostartSaveGen = useRef(0);
  /** 保存串行链：连点两下时落盘顺序必须跟点击顺序一致（§5 第 25 条残留） */
  const autostartSaveChain = useRef<Promise<void>>(Promise.resolve());
  const affinityConnection = useFontStore((s) => s.affinityConnection);
  const refreshAffinityConnection = useFontStore((s) => s.refreshAffinityConnection);
  const pollAffinityLink = useFontStore((s) => s.pollAffinityLink);
  /** 目录名重算对话框（版权判定 v7 的迁移入口，默认只预演） */
  const [resyncOpen, setResyncOpen] = useState(false);
  /**
   * 「导出时连字体文件一起打包」的选择。
   *
   * 记在本机（localStorage）：这是个使用习惯，不是数据 —— 用户决定搬家一次，
   * 之后每次打开设置都还要重新勾一遍会很烦。默认不勾（导出整包要写几 GB，不能默认干）。
   */
  const [exportFonts, setExportFonts] = useState(() => {
    try {
      return localStorage.getItem(EXPORT_FONTS_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    // 设置面板关掉时一并收掉子对话框：不然它会浮在一个已经消失的面板上方
    if (!openState) setResyncOpen(false);
  }, [openState]);

  useEffect(() => {
    if (!openState) return;
    // 读取代次：打开设置时的那次读取可能比用户点开关还慢，
    // 晚到的「旧值」会把刚拨过去的状态盖回去（§5 第 25 条）。
    const gen = ++autostartReadGen.current;
    void ipc
      .getAutostart()
      .then((v) => {
        if (gen === autostartReadGen.current) setAutostart(v);
      })
      .catch(() => {});
  }, [openState]);

  useEffect(() => {
    if (openState && !IS_LINUX && settings.affinityEnabled) void refreshAffinityConnection();
  }, [openState, settings.affinityEnabled, refreshAffinityConnection]);

  useEffect(() => {
    if (!openState || IS_LINUX || !settings.affinityEnabled) return;
    const id = window.setInterval(() => void pollAffinityLink(), 2000);
    return () => window.clearInterval(id);
  }, [openState, settings.affinityEnabled, pollAffinityLink]);

  useEffect(() => {
    if (!openState || defaultLibDir) return;
    void ipc.defaultLibraryDir().then(setDefaultLibDir).catch(() => {});
  }, [openState, defaultLibDir]);

  useEffect(() => {
    if (!openState) return;
    // capture + 最上层消费：设置面板是模态的，Escape 只能它来关（§5 第 8 条）。
    // 用 stopImmediatePropagation 压住同一 target 上的其他 window 监听
    // （否则关设置的同时，主界面的 Escape 还会顺手把选择清掉）。
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!isTopLayer()) return;
      if (recording) return; // 录制中由录制监听器处理（它自己会退出录制）
      if (e.defaultPrevented) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [openState, setSettingsOpen, recording, isTopLayer]);

  // 设置关掉就一定要退出快捷键录制：录制监听器是 capture 阶段拦全应用按键的，
  // 面板都没了它还在，整个界面会「所有键都打不进去」（§5 第 10 条）。
  useEffect(() => {
    if (!openState) setRecording(false);
  }, [openState]);

  useEffect(() => {
    if (!openState || !recording) return;
    const onKey = (e: KeyboardEvent) => {
      // 录制期间所有按键都归我们：既别触发页面快捷键，也别触发「Esc 关闭设置」
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const spec = hotkeyFromEvent(e);
      // 只按了修饰键（Ctrl / Alt / Shift / Win）：等用户接着按主键
      if (!spec) return;
      setRecording(false);
      void setQuickbarHotkey(spec);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, setQuickbarHotkey]);

  const addFolder = async () => {
    const dir = await open({ directory: true, title: t("settings.addFolderTitle") });
    if (!dir || settings.extraDirs.includes(dir)) return;
    void updateSettings({ ...settings, extraDirs: [...settings.extraDirs, dir] });
  };

  /** 已保存的库地址：后端会把当前库排在第一个；老版本 state 没列表时兜底成单条 */
  const libraryDirs =
    settings.libraryDirs.length > 0
      ? settings.libraryDirs
      : settings.libraryDir
        ? [settings.libraryDir]
        : [];

  /** 点库地址行 = 切到这个库。同一个库不重复触发（换库要重扫，代价不小） */
  const switchLibraryDir = (dir: string) => {
    if (settings.libraryDirEnabled && settings.libraryDir === dir) return;
    void updateSettings({ ...settings, libraryDir: dir, libraryDirEnabled: true });
  };

  /** 添加库：最多 3 个；已经在列表里就直接切过去，不重复加 */
  const addLibraryDir = async () => {
    if (libraryDirs.length >= MAX_LIBRARY_DIRS) {
      toast.info(t("settings.libraryLimit", { count: MAX_LIBRARY_DIRS }));
      return;
    }
    const dir = await open({ directory: true, title: t("settings.libraryFolderTitle") });
    if (!dir) return;
    if (libraryDirs.includes(dir)) {
      switchLibraryDir(dir);
      return;
    }
    void updateSettings({
      ...settings,
      libraryDir: dir,
      libraryDirs: [...libraryDirs, dir],
      libraryDirEnabled: true,
    });
  };

  /** 从列表里摘掉一个库地址（只动清单，不动硬盘上的字体文件）；摘的是当前库就顺延到第一个 */
  const removeLibraryDir = (dir: string) => {
    const next = libraryDirs.filter((d) => d !== dir);
    if (next.length === 0) {
      void updateSettings({
        ...settings,
        libraryDir: null,
        libraryDirs: [],
        libraryDirEnabled: false,
      });
      return;
    }
    void updateSettings({
      ...settings,
      libraryDirs: next,
      libraryDir: settings.libraryDir === dir ? next[0] : settings.libraryDir,
      libraryDirEnabled: true,
    });
  };

  const setCustomDirEnabled = (on: boolean) => {
    if (on === settings.libraryDirEnabled) return;
    void updateSettings({ ...settings, libraryDirEnabled: on });
  };

  const customDirActive = settings.libraryDirEnabled && settings.libraryDir != null;

  const affinityDetail = !settings.affinityEnabled
    ? t("settings.affinityDisabled")
    : !affinityConnection
    ? t("settings.affinityChecking")
    : affinityConnection.reachable
      ? `${t("settings.affinityOnline")}${affinityConnection.version ? ` · ${affinityConnection.version}` : ""} · ${t("settings.affinityDocs", { count: affinityConnection.docCount })}`
      : (affinityConnection.error
          ? `${t("settings.affinityOffline")} · ${affinityConnection.error}`
          : t("settings.affinityOffline"));
  const affinityDot = !settings.affinityEnabled
    ? "affinity-dot-off"
    : !affinityConnection
    ? ""
    : affinityConnection.reachable
      ? "affinity-dot-on"
      : "affinity-dot-off";

  /**
   * 归置「与系统重复」的库内字体：先干跑拿到数量，用户确认后再真移。
   * dryRun 只统计不动文件；真移动后必须重扫一次，把已挪走的条目从库里剔掉。
   */
  const runDedupe = async (dryRun: boolean) => {
    try {
      const r = await ipc.dedupeFontLibrary(dryRun);
      // 归置口径收紧后，会有文件被保留下来，两类原因要分别说清楚：
      // ① 同名不同版本（PS 名对上、字节不同）；② 只是文件名撞车，其实不是同一个字体
      const notes: string[] = [];
      if (r.skippedDifferent > 0) {
        notes.push(t("settings.dedupeSkippedSub", { count: r.skippedDifferent }));
      }
      if (r.skippedPartial > 0) {
        notes.push(t("settings.dedupeSkippedPartial", { count: r.skippedPartial }));
      }
      const skippedNote = notes.length > 0 ? notes.join("；") : undefined;
      if (r.moved === 0 && r.failed === 0) {
        toast.info(t("settings.dedupeNone"), skippedNote);
        return;
      }
      if (dryRun) {
        toast.info(t("settings.dedupePreviewResult", { count: r.moved }), skippedNote);
        return;
      }
      toast.success(t("settings.dedupeDone", { count: r.moved }), r.dest);
      void useFontStore.getState().rescan();
    } catch (e) {
      toast.error(t("settings.dedupeFailed"), String(e));
    }
  };

  /** 按归置清单把搬走的字体退回去（误归置时的后悔药） */
  const restoreDedupe = async () => {
    try {
      const r = await ipc.restoreDedupedFonts();
      if (r.moved === 0) {
        toast.info(t("settings.dedupeRestoreNone"));
        return;
      }
      toast.success(
        t("settings.dedupeRestoreDone", { count: r.moved }),
        r.failed > 0 ? t("settings.dedupeRestorePartial", { count: r.failed }) : undefined,
      );
      void useFontStore.getState().rescan();
    } catch (e) {
      toast.error(t("settings.dedupeFailed"), String(e));
    }
  };

  const exportData = async () => {
    // 勾了「连字体一起」就走整包（.P-FontManager，超 2GB 自动分卷），
    // 否则只出整理数据（.L-FontManager）。文件里自带用途说明，见 lib/fileKinds.ts
    const dest = await save({
      title: exportFonts ? t("settings.exportPackTitle") : t("settings.exportDataTitle"),
      defaultPath: exportFonts ? packFileName() : "fontmanager-library.L-FontManager",
      filters: exportFonts
        ? [{ name: "FontManager", extensions: ["P-FontManager"] }]
        : [{ name: "FontManager", extensions: ["L-FontManager"] }],
    });
    if (!dest) return;
    // 整包要写很久，进度条在窗口底部：设置面板留着会把它盖住
    if (exportFonts) setSettingsOpen(false);
    if (exportFonts) await useFontStore.getState().exportLibraryPack(dest);
    else await useFontStore.getState().exportLibraryData(dest);
  };

  const importData = async () => {
    const src = await open({
      title: t("settings.importDataTitle"),
      multiple: false,
      filters: [
        // 三种导出文件都收：S 快照 / P 整包 / L 整理数据；json 是老备份
        { name: "FontManager", extensions: ["P-FontManager", "S-FontManager", "L-FontManager"] },
        { name: "JSON", extensions: ["json"] },
      ],
    });
    if (typeof src !== "string") return;
    // 整包要解很久，同样把面板收起来，让底部进度条露出来。
    // 只是近似判断：真正的类型按内容嗅探（后缀被改过的文件也能正确导入）
    if (/\.(s|p)-fontmanager$/i.test(src)) setSettingsOpen(false);
    await useFontStore.getState().importLibraryFile(src);
  };

  return (
    <>
    <AnimatePresence>
      {openState && (
        <motion.div
          className="compare-backdrop settings-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={() => setSettingsOpen(false)}
        >
          <motion.div
            ref={trapRef}
            className="settings-panel"
            initial={{ y: 32, scale: 0.97, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 20, scale: 0.98, opacity: 0 }}
            transition={springSoft}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={t("settings.title")}
          >
            <div className="settings-scroll">
            <header className="compare-head">
              <h2 className="compare-title">{t("settings.title")}</h2>
              <button
                className="detail-close"
                aria-label={t("settings.close")}
                onClick={() => setSettingsOpen(false)}
              >
                <X size={15} strokeWidth={1.5} />
              </button>
            </header>

            <section className="settings-section">
              <div className="detail-heading">{t("settings.language")}</div>
              <div className="settings-row">
                <div>
                  <div className="settings-label">
                    <Languages size={13} strokeWidth={1.5} /> {t("settings.language")}<SettingHint text={t("settings.languageSub")} /></div>
                </div>
                <LanguageSelect />
              </div>
              <div className="settings-translate">
                <div className="settings-translate-text">
                  <div className="settings-translate-title">
                    {t("settings.translateTitle")}
                    <SettingHint text={t("settings.translateSub")} />
                  </div>
                </div>
                <div className="settings-data-actions">
                  <button
                    className="settings-data-btn"
                    onClick={() => void openUrl(TRANSLATE_GUIDE_URL).catch(() => {})}
                  >
                    <BookOpen size={13} strokeWidth={1.5} />
                    {t("settings.translateGuide")}
                    <ArrowUpRight size={12} strokeWidth={1.5} className="settings-btn-arrow" />
                  </button>
                  <button
                    className="settings-data-btn"
                    onClick={() => void openUrl(REQUEST_LANGUAGE_URL).catch(() => {})}
                  >
                    <MessageSquarePlus size={13} strokeWidth={1.5} />
                    {t("settings.requestLanguage")}
                    <ArrowUpRight size={12} strokeWidth={1.5} className="settings-btn-arrow" />
                  </button>
                </div>
              </div>
            </section>

            <section className="settings-section">
              <div className="detail-heading">{t("settings.system")}</div>

              <div className="settings-row">
                <div>
                  <div className="settings-label">{t("settings.closeToTray")}<SettingHint text={t("settings.closeToTraySub")} /></div>
                </div>
                <PillToggle
                  on={closeToTray}
                  onChange={(on) => setCloseToTray(on)}
                  label={t("settings.closeToTray")}
                />
              </div>

              <div className="settings-row">
                <div>
                  <div className="settings-label">{t("settings.autostart")}<SettingHint text={t("settings.autostartSub")} /></div>
                </div>
                <PillToggle
                  on={autostart}
                  onChange={(on) => {
                    setAutostart(on);
                    // 用户已经表达了新意图：让在飞的旧读取作废
                    autostartReadGen.current++;
                    const gen = ++autostartSaveGen.current;
                    // 串行化：两次开关的落盘顺序必须跟点击顺序一致，否则重启后读到的
                    // 可能是先点的那一次（§5 第 25 条残留）
                    autostartSaveChain.current = autostartSaveChain.current.then(async () => {
                      try {
                        await ipc.setAutostart(on);
                      } catch (e) {
                        // 只回滚最后一次：连点两下时，先失败的那次不该把后来的值改回去
                        if (gen !== autostartSaveGen.current) return;
                        // 回填真实状态，而不是简单取反 —— 前一次写失败时取反是错的
                        try {
                          const real = await ipc.getAutostart();
                          autostartReadGen.current++;
                          setAutostart(real);
                        } catch {
                          setAutostart(!on);
                        }
                        toast.error(t("toast.autostartFailed"), String(e));
                      }
                    });
                  }}
                  label={t("settings.autostart")}
                />
              </div>

              <div className="settings-row">
                <div>
                  <div className="settings-label">{t("settings.startMinimized")}<SettingHint text={t("settings.startMinimizedSub")} /></div>
                </div>
                <PillToggle
                  on={startMinimized}
                  onChange={(on) => setStartMinimized(on)}
                  label={t("settings.startMinimized")}
                />
              </div>

              <div className="settings-row">
                <div>
                  <div className="settings-label">{t("settings.restoreOnLaunch")}<SettingHint text={t("settings.restoreOnLaunchSub")} /></div>
                </div>
                <PillToggle
                  on={restoreOnLaunch}
                  onChange={(on) => setRestoreOnLaunch(on)}
                  label={t("settings.restoreOnLaunch")}
                />
              </div>

              <div className="settings-row">
                <div>
                  <div className="settings-label">{t("settings.quickbarHotkey")}<SettingHint text={t("settings.quickbarHotkeySub")} /></div>
                </div>
                <div className="hotkey-edit">
                  <button
                    type="button"
                    className={`hotkey-field ${recording ? "hotkey-field-recording" : ""}`}
                    onClick={() => setRecording((v) => !v)}
                    aria-label={t("settings.quickbarHotkey")}
                  >
                    {recording ? t("settings.quickbarHotkeyRecording") : quickbarHotkey.label}
                  </button>
                  {quickbarHotkey.label !== DEFAULT_HOTKEY.label && !recording && (
                    <button
                      type="button"
                      className="hotkey-reset"
                      onClick={() => void setQuickbarHotkey(DEFAULT_HOTKEY)}
                      data-hint-text={t("settings.quickbarHotkeyReset")}
                    >
                      {t("settings.quickbarHotkeyReset")}
                    </button>
                  )}
                </div>
              </div>

              <div className="settings-row">
                <div>
                  <div className="settings-label">{t("settings.quickbarHotkeyOpens")}<SettingHint text={t("settings.quickbarHotkeyOpensSub")} /></div>
                </div>
                <PillToggle
                  on={quickbarHotkeyOpens}
                  onChange={(on) => setQuickbarHotkeyOpens(on)}
                  label={t("settings.quickbarHotkeyOpens")}
                />
              </div>
            </section>

            <section className="settings-section">
              <div className="detail-heading">{t("settings.library")}</div>

              <div className="settings-row">
                <div>
                  <div className="settings-label">{t("settings.watch")}<SettingHint text={t("settings.watchSub")} /></div>
                </div>
                <PillToggle
                  on={settings.watchEnabled}
                  onChange={(on) =>
                    void updateSettings({ ...settings, watchEnabled: on })
                  }
                  label={t("settings.watch")}
                />
              </div>

              <div className="settings-row">
                <div>
                  <div className="settings-label">{t("settings.autoActivate")}<SettingHint text={t("settings.autoActivateSub")} /></div>
                </div>
                <PillToggle
                  on={settings.autoActivateImports}
                  onChange={(on) =>
                    void updateSettings({ ...settings, autoActivateImports: on })
                  }
                  label={t("settings.autoActivate")}
                />
              </div>

              <div className="settings-row settings-col">
                <div>
                  <div className="settings-label">{t("settings.watchedFolders")}<SettingHint text={t("settings.watchedFoldersSub")} /></div>
                </div>
                <div className="settings-folders">
                  {settings.extraDirs.map((dir) => (
                    <div key={dir} className="settings-folder">
                      <ArtIcon name="folder" size={14} />
                      <span className="detail-mono settings-folder-path">{dir}</span>
                      <button
                        data-hint="hint.removeFolder"
                        aria-label={t("settings.removeFolder", { dir })}
                        onClick={() =>
                          void updateSettings({
                            ...settings,
                            extraDirs: settings.extraDirs.filter((d) => d !== dir),
                          })
                        }
                      >
                        <X size={12} strokeWidth={1.5} />
                      </button>
                    </div>
                  ))}
                  <button
                    className="settings-add-folder"
                    onClick={() => void addFolder()}
                    disabled={scanning}
                  >
                    <ArtIcon name="folder" size={14} />
                    {t("settings.addFolder")}
                  </button>
                  {scanning && (
                    <div className="settings-scanning tabular" role="status" aria-live="polite">
                      <LoaderCircle size={13} strokeWidth={1.5} className="settings-scanning-icon" />
                      {scanProgress.total > 0
                        ? t("scan.reading", { done: scanProgress.done, total: scanProgress.total })
                        : t("settings.scanningFolders")}
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section className="settings-section">
              <div className="detail-heading">{t("settings.libraryFolder")}</div>
              <div className="settings-row settings-col">
                <div>
                  <div className="settings-label">{t("settings.libraryFolder")}<SettingHint text={t("settings.libraryFolderSub")} /></div>
                </div>
                <div className="settings-folders">
                  <div className={`settings-folder ${customDirActive ? "settings-dim" : ""}`}>
                    <span className="settings-folder-tag">{t("settings.libraryDefault")}</span>
                    <button
                      className="path-link detail-mono settings-folder-path"
                      data-hint-text={defaultLibDir}
                      onClick={() => void revealItemInDir(defaultLibDir).catch(() => {})}
                    >
                      <ArtIcon name="folder" size={14} />
                      <span className="settings-folder-path">{defaultLibDir}</span>
                    </button>
                  </div>
                  <div className={`settings-row ${customDirActive ? "" : "settings-dim"}`}>
                    <div>
                      <div className="settings-label">
                        <PillToggle
                          on={settings.libraryDirEnabled}
                          onChange={(on) => setCustomDirEnabled(on)}
                          label={t("settings.libraryCustom")}
                        />
                        <span className="settings-folder-path">{t("settings.libraryCustom")}</span><SettingHint text={t("settings.libraryCustomSub")} /></div>
                    </div>
                    <button
                      className="settings-add-folder"
                      onClick={() => void addLibraryDir()}
                      disabled={libraryDirs.length >= MAX_LIBRARY_DIRS}
                      data-hint-text={
                        libraryDirs.length >= MAX_LIBRARY_DIRS
                          ? t("settings.libraryLimit", { count: MAX_LIBRARY_DIRS })
                          : undefined
                      }
                    >
                      <ArtIcon name="folder" size={14} />
                      {t("settings.libraryAddFolder")}
                    </button>
                  </div>
                  {libraryDirs.length > 0 && (
                    <div className="settings-library-list">
                      {libraryDirs.map((dir) => {
                        const active = customDirActive && dir === settings.libraryDir;
                        return (
                          <div
                            key={dir}
                            className={`settings-folder settings-library-row ${
                              active ? "settings-library-active" : ""
                            } ${customDirActive ? "" : "settings-dim"}`}
                          >
                            {/* 整行可点：切到这个库 */}
                            <button
                              className="path-link detail-mono settings-folder-path"
                              data-hint-text={t("settings.librarySwitchHint")}
                              aria-pressed={active}
                              onClick={() => switchLibraryDir(dir)}
                            >
                              <ArtIcon name="folder" size={14} />
                              <span className="settings-folder-path">{dir}</span>
                              {active && (
                                <span className="settings-library-current">
                                  {t("settings.libraryCurrent")}
                                </span>
                              )}
                            </button>
                            <button
                              className="settings-library-open"
                              data-hint-text={t("settings.libraryReveal")}
                              aria-label={t("settings.libraryReveal")}
                              onClick={() => void revealItemInDir(dir).catch(() => {})}
                            >
                              <FolderOpen size={13} strokeWidth={1.5} />
                            </button>
                            <button
                              className="settings-library-remove"
                              data-hint-text={t("settings.libraryRemove")}
                              aria-label={t("settings.libraryRemove")}
                              onClick={() => removeLibraryDir(dir)}
                            >
                              <X size={12} strokeWidth={1.5} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </section>

            {!IS_LINUX && (
              <section className="settings-section">
                <div className="detail-heading">
                {t("settings.affinity")}
                <SettingHint text={t("settings.affinityHelp")} />
              </div>
                <div className="settings-row">
                  <div>
                    <div className="settings-label">{t("settings.affinityConnection")}</div>
                    <div className="settings-sub">{affinityDetail}</div>
                  </div>
                  <span className={`affinity-dot ${affinityDot}`} aria-hidden />
                </div>
                <div className="settings-row" data-relation="enable-below">
                  <div>
                    <div className="settings-label">{t("settings.affinityEnable")}<SettingHint text={t("settings.affinityEnableSub")} /></div>
                  </div>
                  <PillToggle
                    on={settings.affinityEnabled}
                    onChange={(on) => {
                      void updateSettings({ ...settings, affinityEnabled: on }).then(() =>
                        refreshAffinityConnection(),
                      );
                    }}
                    label={t("settings.affinityEnable")}
                  />
                </div>
                <div className="settings-row">
                  <div>
                    <div className="settings-label">{t("settings.affinityDeactivate")}<SettingHint text={t("settings.affinityDeactivateSub")} /></div>
                  </div>
                  <PillToggle
                    on={settings.affinityDeactivateOnQuit}
                    onChange={(on) =>
                      void updateSettings({ ...settings, affinityDeactivateOnQuit: on })
                    }
                    label={t("settings.affinityDeactivate")}
                  />
                </div>

              </section>
            )}

            <section className="settings-section">
              <div className="detail-heading">
                {t("settings.online")}
                <SettingHint text={`${t("settings.onlineHelp")}
${t("settings.onlineHosts")}`} />
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-label">{t("settings.onlineEnable")}<SettingHint text={t("settings.onlineEnableSub")} /></div>
                </div>
                <PillToggle
                  on={settings.onlineFontsEnabled}
                  onChange={(on) => {
                    void updateSettings({ ...settings, onlineFontsEnabled: on });
                    if (!on) useFontStore.setState({ onlineFamilies: null, onlineDetail: null });
                  }}
                  label={t("settings.onlineEnable")}
                />
              </div>

            </section>

            <section className="settings-section">
              <div className="detail-heading">{t("settings.libraryData")}</div>
              <div className="settings-row">
                <div>
                  <div className="settings-label">
                    <DatabaseBackup size={13} strokeWidth={1.5} /> {t("settings.curation")}<SettingHint text={t("settings.curationSub")} /></div>
                  <label className="settings-check" data-hint-text={t("settings.exportPackHint")}>
                    <input
                      type="checkbox"
                      checked={exportFonts}
                      onChange={(e) => {
                        const next = e.target.checked;
                        setExportFonts(next);
                        try {
                          localStorage.setItem(EXPORT_FONTS_KEY, next ? "1" : "0");
                        } catch {
                          // 隐私模式下写不进去：只影响「下次还记不记得」，不影响这次导出
                        }
                      }}
                    />
                    <span>{t("settings.exportPackToggle")}</span>
                  </label>
                </div>
                <div className="settings-data-actions">
                  <button
                    className="settings-data-btn"
                    onClick={() => void exportData()}
                    title={exportFonts ? t("settings.exportPackTitle") : t("settings.exportDataTitle")}
                  >
                    {/* 勾了「连字体一起」显示整包图标，否则显示纯整理数据图标 */}
                    <ArtIcon name={exportFonts ? "exportPack" : "exportData"} size={14} />
                    {t("settings.export")}
                  </button>
                  <button className="settings-data-btn" onClick={() => void importData()}>
                    <FolderOpen size={14} strokeWidth={1.5} />
                    {t("settings.import")}
                  </button>
                </div>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-label">
                    {t("settings.dedupe")}
                    <SettingHint
                      text={`${t("settings.dedupeSub")}
${t("settings.dedupeWhy")}
${t("settings.dedupeRule")}`}
                    />
                  </div>
                </div>
                <div className="settings-data-actions">
                  <button
                    className="settings-data-btn"
                    data-hint="hint.dedupePreview"
                    onClick={() => void runDedupe(true)}
                  >
                    {t("settings.dedupePreview")}
                  </button>
                  <button
                    className="settings-data-btn"
                    data-hint="hint.dedupeRun"
                    onClick={() => void runDedupe(false)}
                  >
                    {t("settings.dedupeRun")}
                  </button>
                  <button
                    className="settings-data-btn"
                    data-hint="hint.dedupeRestore"
                    onClick={() => void restoreDedupe()}
                  >
                    {t("settings.dedupeRestore")}
                  </button>
                </div>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-label">
                    <FolderSync size={13} strokeWidth={1.5} /> {t("settings.labelResync")}
                  </div>
                  <SettingHint
                    text={`${t("settings.labelResyncSub")}
${t("settings.labelResyncWhy")}`}
                  />
                </div>
                <div className="settings-data-actions">
                  <button
                    className="settings-data-btn"
                    onClick={() => setResyncOpen(true)}
                    disabled={scanning}
                  >
                    {t("settings.labelResyncOpen")}
                  </button>
                </div>
              </div>
            </section>

            <section className="settings-section">
              <div className="detail-heading">{t("settings.appearance")}</div>
              <div className="settings-row">
                <div>
                  <div className="settings-label">
                    <SunMoon size={13} strokeWidth={1.5} /> {t("settings.theme")}<SettingHint text={t("settings.themeSub")} /></div>
                </div>
                <div
                  className="view-toggle sound-toggle"
                  role="radiogroup"
                  aria-label={t("settings.theme")}
                  onKeyDown={radioKeys}
                >
                  {(["dark", "light", "system"] as const).map((mode) => (
                    <button
                      key={mode}
                      role="radio"
                      aria-checked={themePref === mode}
                      tabIndex={themePref === mode ? 0 : -1}
                      className={`view-btn sound-btn ${themePref === mode ? "view-btn-active" : ""}`}
                      onClick={() => setThemePref(mode)}
                    >
                      {t(`theme.${mode}`)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-label">
                    <Eye size={13} strokeWidth={1.5} /> {t("settings.reduceMotion")}<SettingHint text={t("settings.reduceMotionSub")} /></div>
                </div>
                <PillToggle
                  on={motionPref === "reduced"}
                  onChange={(on) => setMotionPref(on ? "reduced" : "system")}
                  label={t("settings.reduceMotion")}
                />
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-label">
                    <Eye size={13} strokeWidth={1.5} /> {t("settings.reduceTransparency")}<SettingHint text={t("settings.reduceTransparencySub")} /></div>
                </div>
                <PillToggle
                  on={transparencyPref === "reduced"}
                  onChange={(on) => setTransparencyPref(on ? "reduced" : "full")}
                  label={t("settings.reduceTransparency")}
                />
              </div>
              <div className="settings-row settings-col">
                <div>
                  <div className="settings-label">
                    <Scaling size={13} strokeWidth={1.5} /> {t("settings.uiScale")}
                  </div>
                  <div className="settings-sub">
                    {uiScale === "auto"
                      ? t("settings.uiScaleAutoSub", { percent: Math.round(appliedScale * 100) })
                      : t("settings.uiScaleSub")}
                  </div>
                </div>
                <div
                  className="view-toggle sound-toggle scale-toggle"
                  role="radiogroup"
                  aria-label={t("settings.uiScale")}
                  onKeyDown={radioKeys}
                >
                  {(["auto", 0.8, 0.9, 1, 1.1, 1.25] as const).map((step) => (
                    <button
                      key={String(step)}
                      role="radio"
                      aria-checked={uiScale === step}
                      tabIndex={uiScale === step ? 0 : -1}
                      className={`view-btn sound-btn ${uiScale === step ? "view-btn-active" : ""}`}
                      onClick={() => setUiScale(step)}
                    >
                      {step === "auto" ? t("settings.uiScaleAuto") : `${Math.round(step * 100)}%`}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className="settings-section">
              <div className="detail-heading">{t("settings.sound")}</div>
              <div className="settings-row">
                <div>
                  <div className="settings-label">
                    <Volume2 size={13} strokeWidth={1.5} /> {t("settings.interfaceSounds")}<SettingHint text={t("settings.interfaceSoundsSub")} /></div>
                </div>
                <div
                  className="view-toggle sound-toggle"
                  role="radiogroup"
                  aria-label={t("settings.soundLevelAria")}
                  onKeyDown={radioKeys}
                >
                  {(["off", "subtle", "on"] as const).map((lvl) => (
                    <button
                      key={lvl}
                      role="radio"
                      aria-checked={soundPref === lvl}
                      tabIndex={soundPref === lvl ? 0 : -1}
                      className={`view-btn sound-btn ${soundPref === lvl ? "view-btn-active" : ""}`}
                      onClick={() => setSoundPref(lvl)}
                    >
                      {t(`sound.${lvl}`)}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <footer className="settings-footer tabular">
              <img className="settings-footer-icon" src="/favicon.png" alt="" draggable={false} />
              FontManager {displayVersion(t)} · {APP_LICENSE} · {t("settings.footerNote")} ·{" "}
              <button
                className="settings-replay"
                onClick={() => {
                  setSettingsOpen(false);
                  useFontStore.getState().startTour();
                }}
              >
                {t("settings.replayTour")}
              </button>
            </footer>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
    <LabelResyncDialog open={openState && resyncOpen} onClose={() => setResyncOpen(false)} />
    </>
  );
}
