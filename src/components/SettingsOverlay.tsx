import { open, save } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowUpRight,
  BookOpen,
  DatabaseBackup,
  Eye,
  FolderDown,
  FolderOpen,
  FolderPlus,
  FolderSync,
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
  "https://github.com/TheHolyOneZ/ZFontManager/blob/main/docs/TRANSLATING.md";

const REQUEST_LANGUAGE_URL =
  "https://github.com/TheHolyOneZ/ZFontManager/issues/new?title=Language%20request%3A%20";

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

  const pickLibraryDir = async () => {
    const dir = await open({ directory: true, title: t("settings.libraryFolderTitle") });
    if (!dir) return;
    void updateSettings({ ...settings, libraryDir: dir, libraryDirEnabled: true });
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
    const dest = await save({
      title: t("settings.exportDataTitle"),
      defaultPath: "zfontmanager-library.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (dest) await useFontStore.getState().exportLibraryData(dest);
  };

  const importData = async () => {
    const src = await open({
      title: t("settings.importDataTitle"),
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (typeof src === "string") await useFontStore.getState().importLibraryData(src);
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
                    <Languages size={13} strokeWidth={1.5} /> {t("settings.language")}
                  </div>
                  <div className="settings-sub">{t("settings.languageSub")}</div>
                </div>
                <LanguageSelect />
              </div>
              <div className="settings-translate">
                <div className="settings-translate-text">
                  <div className="settings-translate-title">{t("settings.translateTitle")}</div>
                  <div className="settings-sub">{t("settings.translateSub")}</div>
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
                  <div className="settings-label">{t("settings.closeToTray")}</div>
                  <div className="settings-sub">{t("settings.closeToTraySub")}</div>
                </div>
                <PillToggle
                  on={closeToTray}
                  onChange={(on) => setCloseToTray(on)}
                  label={t("settings.closeToTray")}
                />
              </div>

              <div className="settings-row">
                <div>
                  <div className="settings-label">{t("settings.autostart")}</div>
                  <div className="settings-sub">{t("settings.autostartSub")}</div>
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
                  <div className="settings-label">{t("settings.startMinimized")}</div>
                  <div className="settings-sub">{t("settings.startMinimizedSub")}</div>
                </div>
                <PillToggle
                  on={startMinimized}
                  onChange={(on) => setStartMinimized(on)}
                  label={t("settings.startMinimized")}
                />
              </div>

              <div className="settings-row">
                <div>
                  <div className="settings-label">{t("settings.restoreOnLaunch")}</div>
                  <div className="settings-sub">{t("settings.restoreOnLaunchSub")}</div>
                </div>
                <PillToggle
                  on={restoreOnLaunch}
                  onChange={(on) => setRestoreOnLaunch(on)}
                  label={t("settings.restoreOnLaunch")}
                />
              </div>

              <div className="settings-row">
                <div>
                  <div className="settings-label">{t("settings.quickbarHotkey")}</div>
                  <div className="settings-sub">{t("settings.quickbarHotkeySub")}</div>
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
                  <div className="settings-label">{t("settings.quickbarHotkeyOpens")}</div>
                  <div className="settings-sub">{t("settings.quickbarHotkeyOpensSub")}</div>
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
                  <div className="settings-label">{t("settings.watch")}</div>
                  <div className="settings-sub">{t("settings.watchSub")}</div>
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
                  <div className="settings-label">{t("settings.autoActivate")}</div>
                  <div className="settings-sub">{t("settings.autoActivateSub")}</div>
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
                  <div className="settings-label">{t("settings.watchedFolders")}</div>
                  <div className="settings-sub">{t("settings.watchedFoldersSub")}</div>
                </div>
                <div className="settings-folders">
                  {settings.extraDirs.map((dir) => (
                    <div key={dir} className="settings-folder">
                      <FolderOpen size={13} strokeWidth={1.5} />
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
                    <FolderPlus size={13} strokeWidth={1.5} />
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
                  <div className="settings-label">{t("settings.libraryFolder")}</div>
                  <div className="settings-sub">{t("settings.libraryFolderSub")}</div>
                </div>
                <div className="settings-folders">
                  <div className={`settings-folder ${customDirActive ? "settings-dim" : ""}`}>
                    <span className="settings-folder-tag">{t("settings.libraryDefault")}</span>
                    <button
                      className="path-link detail-mono settings-folder-path"
                      data-hint-text={defaultLibDir}
                      onClick={() => void revealItemInDir(defaultLibDir).catch(() => {})}
                    >
                      <FolderOpen size={13} strokeWidth={1.5} />
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
                        <span className="settings-folder-path">{t("settings.libraryCustom")}</span>
                      </div>
                      <div className="settings-sub">{t("settings.libraryCustomSub")}</div>
                    </div>
                    <button className="settings-add-folder" onClick={() => void pickLibraryDir()}>
                      <FolderPlus size={13} strokeWidth={1.5} />
                      {t("settings.libraryAddFolder")}
                    </button>
                  </div>
                  {settings.libraryDir && (
                    <div className={`settings-folder ${customDirActive ? "" : "settings-dim"}`}>
                      <button
                        className="path-link detail-mono settings-folder-path"
                        data-hint-text={settings.libraryDir}
                        onClick={() =>
                          void revealItemInDir(settings.libraryDir ?? "").catch(() => {})
                        }
                      >
                        <FolderOpen size={13} strokeWidth={1.5} />
                        <span className="settings-folder-path">{settings.libraryDir}</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </section>

            {!IS_LINUX && (
              <section className="settings-section">
                <div className="detail-heading">{t("settings.affinity")}</div>
                <div className="settings-row">
                  <div>
                    <div className="settings-label">{t("settings.affinityConnection")}</div>
                    <div className="settings-sub">{affinityDetail}</div>
                  </div>
                  <span className={`affinity-dot ${affinityDot}`} aria-hidden />
                </div>
                <div className="settings-row" data-relation="enable-below">
                  <div>
                    <div className="settings-label">{t("settings.affinityEnable")}</div>
                    <div className="settings-sub">{t("settings.affinityEnableSub")}</div>
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
                    <div className="settings-label">{t("settings.affinityDeactivate")}</div>
                    <div className="settings-sub">{t("settings.affinityDeactivateSub")}</div>
                  </div>
                  <PillToggle
                    on={settings.affinityDeactivateOnQuit}
                    onChange={(on) =>
                      void updateSettings({ ...settings, affinityDeactivateOnQuit: on })
                    }
                    label={t("settings.affinityDeactivate")}
                  />
                </div>
                <div className="settings-sub">{t("settings.affinityHelp")}</div>
              </section>
            )}

            <section className="settings-section">
              <div className="detail-heading">{t("settings.online")}</div>
              <div className="settings-row">
                <div>
                  <div className="settings-label">{t("settings.onlineEnable")}</div>
                  <div className="settings-sub">{t("settings.onlineEnableSub")}</div>
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
              <div className="settings-sub settings-hosts detail-mono">{t("settings.onlineHosts")}</div>
              <div className="settings-sub">{t("settings.onlineHelp")}</div>
            </section>

            <section className="settings-section">
              <div className="detail-heading">{t("settings.libraryData")}</div>
              <div className="settings-row">
                <div>
                  <div className="settings-label">
                    <DatabaseBackup size={13} strokeWidth={1.5} /> {t("settings.curation")}
                  </div>
                  <div className="settings-sub">{t("settings.curationSub")}</div>
                </div>
                <div className="settings-data-actions">
                  <button className="settings-data-btn" onClick={() => void exportData()}>
                    <FolderDown size={13} strokeWidth={1.5} />
                    {t("settings.export")}
                  </button>
                  <button className="settings-data-btn" onClick={() => void importData()}>
                    <FolderOpen size={13} strokeWidth={1.5} />
                    {t("settings.import")}
                  </button>
                </div>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-label">{t("settings.dedupe")}</div>
                  <div className="settings-sub">{t("settings.dedupeSub")}</div>
                  <div className="settings-sub">{t("settings.dedupeWhy")}</div>
                  <div className="settings-sub">{t("settings.dedupeRule")}</div>
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
                  <div className="settings-sub">{t("settings.labelResyncSub")}</div>
                  <div className="settings-sub">{t("settings.labelResyncWhy")}</div>
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
                    <SunMoon size={13} strokeWidth={1.5} /> {t("settings.theme")}
                  </div>
                  <div className="settings-sub">{t("settings.themeSub")}</div>
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
                    <Eye size={13} strokeWidth={1.5} /> {t("settings.reduceMotion")}
                  </div>
                  <div className="settings-sub">{t("settings.reduceMotionSub")}</div>
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
                    <Eye size={13} strokeWidth={1.5} /> {t("settings.reduceTransparency")}
                  </div>
                  <div className="settings-sub">{t("settings.reduceTransparencySub")}</div>
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
                    <Volume2 size={13} strokeWidth={1.5} /> {t("settings.interfaceSounds")}
                  </div>
                  <div className="settings-sub">{t("settings.interfaceSoundsSub")}</div>
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
              ZFontManager {displayVersion(t)} · {APP_LICENSE} · {t("settings.footerNote")} ·{" "}
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
