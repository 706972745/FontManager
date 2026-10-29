import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { MotionConfig, motion } from "motion/react";
import { Clock, Camera, FolderOpen, History, Monitor, Power, PowerOff, SearchX, Star, Tag as TagIcon, Type } from "lucide-react";
import { useEffect, useMemo } from "react";
import { DetailPanel } from "./components/DetailPanel";
import { ResizeGrips } from "./components/ResizeGrips";
import { Titlebar } from "./components/Titlebar";
import { DropZone } from "./components/DropZone";
import { FontGrid } from "./components/FontGrid";
import { FontList } from "./components/FontList";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { TrashView } from "./components/TrashView";
import { OnlineView } from "./components/OnlineView";
import { AboutView } from "./components/AboutView";
import { WaterfallView } from "./components/WaterfallView";
import { SnapshotBar } from "./components/SnapshotBar";
import { CompareOverlay } from "./components/CompareOverlay";
import { SelectionBar } from "./components/SelectionBar";
import { SettingsOverlay } from "./components/SettingsOverlay";
import { ShortcutsOverlay } from "./components/ShortcutsOverlay";
import { CommandPalette } from "./components/CommandPalette";
import { QuickBar } from "./components/QuickBar";
import { WarmFooter } from "./components/WarmFooter";
import { LoadProgress } from "./components/LoadProgress";
import { BulkTagPrompt } from "./components/BulkTagPrompt";
import { DuplicateDialog } from "./components/DuplicateDialog";
import { Onboarding } from "./components/Onboarding";
import { ContextMenuHost, isContextMenuOpen, openContextMenuAt } from "./design/primitives/ContextMenu";
import { buildFamilyMenu } from "./lib/menus";
import { Toaster, toast } from "./design/primitives/Toast";
import { easeTop, spring } from "./design/springs";
import { INTRO_OFF, useIntro } from "./lib/useIntro";
import { expandQuickbarPanel } from "./lib/useQuickbarDock";
import { familiesFor, selectVisibleFamilies, useFontStore, type Nav } from "./state/fontStore";
import { useT } from "./lib/i18n";

function ScanSkeleton() {
  const t = useT();
  const { done, total } = useFontStore((s) => s.scanProgress);
  return (
    <div className="scan-skeleton">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="skeleton skeleton-card" style={{ animationDelay: `${i * 0.08}s` }} />
      ))}
      <div className="scan-progress tabular">
        {total > 0 ? t("scan.reading", { done, total }) : t("scan.finding")}
      </div>
    </div>
  );
}

function EmptyLibrary({ searching, nav }: { searching: boolean; nav: Nav }) {
  const t = useT();
  const intro = useIntro();

  let icon = <Type size={26} strokeWidth={1.5} />;
  let title = t("empty.library.title");
  let hint = t("empty.library.body");
  if (searching) {
    icon = <SearchX size={26} strokeWidth={1.5} />;
    title = t("empty.search.title");
    hint = t("empty.search.body");
  } else if (nav.kind === "favorites") {
    icon = <Star size={26} strokeWidth={1.5} />;
    title = t("empty.favorites.title");
    hint = t("empty.favorites.body");
  } else if (nav.kind === "lastImported") {
    icon = <History size={26} strokeWidth={1.5} />;
    title = t("empty.lastImported.title");
    hint = t("empty.lastImported.body");
  } else if (nav.kind === "collection") {
    icon = <FolderOpen size={26} strokeWidth={1.5} />;
    title = t("empty.collection.title");
    hint = t("empty.collection.body", { name: nav.name });
  } else if (nav.kind === "snapshot") {
    icon = <Camera size={26} strokeWidth={1.5} />;
    title = t("empty.snapshot.title");
    hint = t("empty.snapshot.body");
  } else if (nav.kind === "tag") {
    icon = <TagIcon size={26} strokeWidth={1.5} />;
    title = t("empty.tag.title");
    hint = t("empty.tag.body");
  } else if (nav.kind === "activated") {
    icon = <Power size={26} strokeWidth={1.5} />;
    title = t("empty.activated.title");
    hint = t("empty.activated.body");
  } else if (nav.kind === "activatedSession") {
    icon = <Clock size={26} strokeWidth={1.5} />;
    title = t("empty.session.title");
    hint = t("empty.session.body");
  } else if (nav.kind === "deactivated") {
    icon = <PowerOff size={26} strokeWidth={1.5} />;
    title = t("empty.deactivated.title");
    hint = t("empty.deactivated.body");
  } else if (nav.kind === "system") {
    icon = <Monitor size={26} strokeWidth={1.5} />;
    title = t("empty.system.title");
    hint = t("empty.system.body");
  }
  return (
    <motion.div
      className="empty-state"
      initial={intro ? { opacity: 0, y: 16 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={intro ? spring : INTRO_OFF}
    >
      <span className="empty-tile">{icon}</span>
      <h2>{title}</h2>
      <p>{hint}</p>
    </motion.div>
  );
}

/**
 * 是否有「顶层弹层」正在占着键盘：弹窗、浮层、右键菜单、导览、输入提示。
 *
 * 全局字库快捷键必须在它们打开时整体让路 —— 否则 Escape 会穿透去清选择、
 * Ctrl+K / `?` 会再叠一个弹窗上来、焦点陷阱也会互相打架（§5 第 8 条）。
 */
function topLayerOpen(): boolean {
  const st = useFontStore.getState();
  return (
    st.compare != null ||
    st.settingsOpen ||
    st.helpOpen ||
    st.paletteOpen ||
    st.tourStep != null ||
    st.bulkTagFor != null ||
    st.pendingCollectionFor != null ||
    st.pendingSnapshotFor != null ||
    st.duplicateReport != null ||
    st.onlineDetail != null ||
    isContextMenuOpen()
  );
}

/** 当前页面是否在「浏览字族」（回收站 / 关于 / 在线栏目没有字族可操作） */
function familyNav(nav: Nav): boolean {
  return nav.kind !== "trash" && nav.kind !== "about" && nav.kind !== "online";
}

function MainContent() {
  const phase = useFontStore((s) => s.phase);
  const nav = useFontStore((s) => s.nav);
  const viewMode = useFontStore((s) => s.viewMode);
  const fonts = useFontStore((s) => s.fonts);
  // 扫描途中陆续到达的字体：有就先铺出来，别让用户对着骨架屏等整库
  const scanFonts = useFontStore((s) => s.scanFonts);
  const tags = useFontStore((s) => s.tags);
  const collections = useFontStore((s) => s.collections);
  const snapshots = useFontStore((s) => s.snapshots);
  const favorites = useFontStore((s) => s.favorites);
  const sessionActivated = useFontStore((s) => s.sessionActivated);
  const lastImported = useFontStore((s) => s.lastImported);
  const notes = useFontStore((s) => s.notes);
  const search = useFontStore((s) => s.search);
  const classFilter = useFontStore((s) => s.classFilter);
  const scriptFilter = useFontStore((s) => s.scriptFilter);
  const variableOnly = useFontStore((s) => s.variableOnly);
  const toggleableOnly = useFontStore((s) => s.toggleableOnly);
  const formatFilter = useFontStore((s) => s.formatFilter);
  const featureFilter = useFontStore((s) => s.featureFilter);
  const sourceFilter = useFontStore((s) => s.sourceFilter);
  const charFilter = useFontStore((s) => s.charFilter);
  const charMatches = useFontStore((s) => s.charMatches);
  const sort = useFontStore((s) => s.sort);
  const licenseFilter = useFontStore((s) => s.licenseFilter);
  const copyrightStatus = useFontStore((s) => s.copyrightStatus);

  // 扫描中就用「已经读到的那些」先渲染；扫完 fonts 会被权威结果整体替换
  const displayFonts = phase === "scanning" && scanFonts.length > 0 ? scanFonts : fonts;

  const families = useMemo(
    () =>
      selectVisibleFamilies({
        fonts: displayFonts, tags, collections, snapshots, favorites, sessionActivated, lastImported, notes, search,
        classFilter, scriptFilter, formatFilter, featureFilter, sourceFilter, charFilter, charMatches,
        variableOnly, toggleableOnly, licenseFilter, copyrightStatus, nav, sort,
      }),
    [displayFonts, tags, collections, snapshots, favorites, sessionActivated, lastImported, notes, search, classFilter, scriptFilter, formatFilter, featureFilter, sourceFilter, charFilter, charMatches, variableOnly, toggleableOnly, licenseFilter, copyrightStatus, nav, sort],
  );

  // 非字族浏览页面（回收站 / 关于 / 在线栏目）没有「可见字族顺序」，必须清空：
  // 以前这里照样写入，导致在这些页面按 Delete / 空格仍在操作字库里选中的字族
  // ——删掉的东西根本不在屏幕上（§5 第 7 条）。
  const browsable = familyNav(nav);
  useEffect(() => {
    useFontStore.setState({ visibleOrder: browsable ? families.map((f) => f.name) : [] });
  }, [families, browsable]);

  if (nav.kind === "trash") return <TrashView />;
  if (nav.kind === "about") return <AboutView />;
  if (nav.kind === "online") return <OnlineView />;
  // 一个字体都还没读到才显示骨架屏；已经开始出结果就直接上列表（底部进度条还在）
  if (phase === "scanning" && scanFonts.length === 0) return <ScanSkeleton />;
  const body =
    families.length === 0 ? (
      <EmptyLibrary
        nav={nav}
        searching={
          search.trim().length > 0 ||
          classFilter.length > 0 ||
          scriptFilter.length > 0 ||
          formatFilter.length > 0 ||
          featureFilter.length > 0 ||
          sourceFilter !== "all" ||
          charFilter.length > 0 ||
          variableOnly ||
          toggleableOnly
        }
      />
    ) : viewMode === "waterfall" ? (
      <WaterfallView families={families} />
    ) : viewMode === "grid" ? (
      <FontGrid families={families} />
    ) : (
      <FontList families={families} />
    );
  if (nav.kind === "snapshot") {
    return (
      <div className="snapshot-view">
        <SnapshotBar name={nav.name} />
        {body}
      </div>
    );
  }
  return body;
}

export default function App() {
  const t = useT();
  const init = useFontStore((s) => s.init);
  const motionPref = useFontStore((s) => s.motionPref);
  const quickbar = useFontStore((s) => s.quickbar);
  const morph = useFontStore((s) => s.morph);
  // 窗口形变期间不要再播放入场动画，否则内容跳动和窗口缩放两套运动会互相打架
  const intro = useIntro();

  useEffect(() => {
    void init().then(() => {
      if (!useFontStore.getState().startMinimized) void getCurrentWindow().show();
    });
  }, [init]);

  // 软件已经开着时用户又点了一次桌面 / 开始菜单图标（原生侧拦下第二个进程并发来这个事件）：
  // 不管此刻停在速览细线、最小化还是托盘里，都回到已经在开着的那个「完整界面」。
  useEffect(() => {
    let un: (() => void) | undefined;
    void listen("app://activate", async () => {
      const st = useFontStore.getState();
      // 速览 → 完整界面走它自己的还原流程（还原窗口几何、取消置顶、再显示出来）
      if (st.quickbar) await st.setQuickbar(false);
      const win = getCurrentWindow();
      await win.unminimize().catch(() => {});
      await win.show().catch(() => {});
      await win.setFocus().catch(() => {});
    })
      .then((f) => {
        un = f;
      })
      .catch((e) => console.warn("[single-instance] 监听唤起事件失败", e));
    return () => un?.();
  }, []);

  // 系统级 Alt+`：即使软件在后台、鼠标在别的软件里，也能把速览面板叫出来。
  // 停在完整界面时按它 = 切进速览，并立刻把面板展开（默认进入是收成顶部一条）。
  useEffect(() => {
    let un: (() => void) | undefined;
    void listen("quickbar://hotkey", async () => {
      const st = useFontStore.getState();
      if (st.quickbar) return; // 已经在速览里：交给速览自己的监听处理展开 / 收起
      // 设置里关掉「在完整界面按快捷键唤出速览」时就什么都不做——
      // 有些用户把这个键注册给了别的软件，只想在速览里用它来展开/收起
      if (!st.quickbarHotkeyOpens) return;
      // 可能被最小化在任务栏里 / 藏在托盘：先进速览前把窗口捞回来，
      // 否则进速览那一步的改尺寸会被系统吞掉（最小化状态下改几何无效）
      const win = getCurrentWindow();
      await win.unminimize().catch(() => {});
      await win.show().catch(() => {});
      await st.setQuickbar(true);
      await expandQuickbarPanel().catch(() => {});
    })
      .then((f) => {
        un = f;
      })
      .catch((e) => console.warn("[hotkey] 监听全局快捷键失败", e));
    return () => un?.();
  }, []);

  // 系统级热键注册失败（多半是撞了别的软件 / 输入法）：明确告诉用户，
  // 否则「按了没反应」根本无从排查。payload 是被占用的那组键。
  useEffect(() => {
    let un: (() => void) | undefined;
    void listen<string>("quickbar://hotkey-error", (e) => {
      toast.error(t("toast.hotkeyFailed"), String(e.payload ?? ""));
    })
      .then((f) => {
        un = f;
      })
      .catch(() => {});
    return () => un?.();
  }, [t]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 更靠内的一层（弹层自己的 handler、卡片上的键盘处理）已经消费掉这个键
      if (e.defaultPrevented) return;
      const tgt = e.target instanceof Element ? e.target : null;
      const inField =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement ||
        !!tgt?.closest("[contenteditable='true'], [contenteditable=''], [role='textbox']");
      /**
       * 焦点在「本身就吃 Space 的控件」上时全局快捷键让路：
       * 以前只排除 input / textarea，焦点落在按钮上按 Space 会既切字体又点按钮（§5 第 6 条）。
       * 注意不要排除 div[role=button]（字族卡片），那张卡片没有自己的 Space 行为。
       */
      const onButton = !!tgt?.closest("button, a[href], select, [contenteditable='true']");
      // 速览界面有自己的一套快捷键，主界面的快捷键在这里一律不生效
      const st = useFontStore.getState();
      if (st.quickbar) return;

      // Ctrl/⌘+K 与「?」允许用来关掉自己 —— 否则一旦有弹层就再也关不掉了。
      // 打开则互斥：已经开着别的顶层弹层时不给再叠一个（§5 第 8 条）。
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (st.paletteOpen) {
          st.setPaletteOpen(false);
          return;
        }
        if (topLayerOpen()) return;
        st.setPaletteOpen(true);
        return;
      }
      if (e.key === "?" && !inField && !onButton) {
        if (st.helpOpen) {
          e.preventDefault();
          st.setHelpOpen(false);
          return;
        }
        if (topLayerOpen()) return;
        e.preventDefault();
        st.setHelpOpen(true);
        return;
      }

      // 任一顶层弹层 / 右键菜单 / 导览开着：其余全局快捷键整体让路。
      // Escape 由最上层自己的 handler 消费（它们都是 window 级监听），
      // 这里再处理就会「关弹窗的同时把选择也清了」。
      if (topLayerOpen()) return;

      if (e.key === "Escape" && !inField) {
        st.setComparePicking(false);
        st.select(null);
      }
      if (e.key === "/" && !inField) {
        e.preventDefault();
        document.getElementById("global-search")?.focus();
      }

      if ((e.key === "a" || e.key === "A") && (e.metaKey || e.ctrlKey) && !inField) {
        const st = useFontStore.getState();
        if (st.compare || st.settingsOpen || st.helpOpen || st.paletteOpen) return;
        e.preventDefault();
        st.selectAll();
      }

      const arrows = ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"];
      if (arrows.includes(e.key) && !inField) {
        const st = useFontStore.getState();
        if (st.compare || st.settingsOpen || st.helpOpen) return;
        const order = st.visibleOrder;
        if (order.length === 0) return;
        e.preventDefault();
        const cur = st.selectedFamily ? order.indexOf(st.selectedFamily) : -1;
        const next =
          e.key === "Home" ? 0
          : e.key === "End" ? order.length - 1
          : e.key === "ArrowDown" || e.key === "ArrowRight"
            ? Math.min(cur + 1, order.length - 1)
            : Math.max(cur - 1, 0);
        st.selectWith(order[next], e.shiftKey ? "range" : "single", order);
      }
      if (e.key === " " && !inField && !onButton) {
        const st = useFontStore.getState();
        if (!familyNav(st.nav)) return;
        if (st.compare || st.settingsOpen || st.helpOpen || !st.selectedFamily) return;
        e.preventDefault();
        const fam = familiesFor(st.fonts, st.tags).get(st.selectedFamily);
        if (fam?.deactivatable) {
          void st.setFamilyActive(fam.name, !fam.active);
        }
      }

      if ((e.key === "c" || e.key === "C") && !inField && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const st = useFontStore.getState();
        if (st.compare || st.settingsOpen || st.helpOpen || st.selection.length < 2) return;
        e.preventDefault();
        st.openCompare(st.selection);
      }

      if ((e.key === "f" || e.key === "F") && !inField && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const st = useFontStore.getState();
        if (st.compare || st.settingsOpen || st.helpOpen || !st.selectedFamily) return;
        e.preventDefault();
        void st.toggleFavorite(st.selectedFamily);
      }
      if (e.key === "Delete" && !inField) {
        const st = useFontStore.getState();
        // 回收站 / 关于 / 在线栏目没有「字族浏览」上下文：这里的 Delete 一律不碰字库，
        // 否则会删掉屏幕上根本不存在的那个选中字族（§5 第 7 条）
        if (!familyNav(st.nav)) return;
        if (st.compare || st.settingsOpen || st.helpOpen) return;
        const doomed = st.selection.length > 0
          ? st.selection
          : st.selectedFamily ? [st.selectedFamily] : [];
        if (doomed.length === 0) return;
        e.preventDefault();
        for (const name of doomed) void st.uninstallFamily(name);
      }

      if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
        const st = useFontStore.getState();
        if (!familyNav(st.nav)) return;
        if (inField || st.compare || st.settingsOpen || st.helpOpen || !st.selectedFamily) return;
        e.preventDefault();
        const fam = familiesFor(st.fonts, st.tags).get(st.selectedFamily);
        if (!fam) return;
        const card = document.querySelector(`[data-family="${CSS.escape(fam.name)}"]`);
        const r = card?.getBoundingClientRect();
        openContextMenuAt(
          r ? r.left + Math.min(r.width / 2, 240) : window.innerWidth / 2,
          r ? Math.min(r.top + 40, window.innerHeight - 80) : window.innerHeight / 2,
          buildFamilyMenu(fam),
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 圆角半径全局常量：完整界面（.app-frame）和速览（.qb-frame）用同一个值——
  // 8 物理像素 / DPR（= Win11 DWM 圆角的固定半径，完整界面原来是系统圆角）。
  // 不做取整：CSS 支持小数，除出来是多少就是多少，任何 DPR 下都精确等于 8 物理像素。
  useEffect(() => {
    const dpr = window.devicePixelRatio || 1;
    document.documentElement.style.setProperty("--qb-radius", `${8 / dpr}px`);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("is-morphing", morph != null);
    return () => document.body.classList.remove("is-morphing");
  }, [morph]);

  if (quickbar) {
    return (
      <MotionConfig reducedMotion={motionPref === "reduced" ? "always" : "user"}>
        <QuickBar />
        <ContextMenuHost />
        <Toaster />
        <ResizeGrips />
      </MotionConfig>
    );
  }

  return (
    <MotionConfig reducedMotion={motionPref === "reduced" ? "always" : "user"}>
      <motion.div
        // 从速览切回来时把内容钉在主界面尺寸上，窗口只是逐步把它露出来；
        // morph-fade 让内容随窗口一起浮现，节奏与 Windows 的窗口动画一致
        className={morph ? "app-frame morph-fade" : "app-frame"}
        style={morph ? { width: `${morph.width}px`, height: `${morph.height}px` } : undefined}
        initial={intro ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        transition={intro ? easeTop : INTRO_OFF}
      >
        <Titlebar />
        <div className="app-shell">
          <Sidebar />
          <div className="app-main">
            <TopBar />
            <main className="app-content">
              <MainContent />
            </main>
            <LoadProgress />
            <WarmFooter />
          </div>
          <DetailPanel />
        </div>
      </motion.div>
      <DropZone />
      <SelectionBar />
      <CompareOverlay />
      <SettingsOverlay />
      <ShortcutsOverlay />
      <CommandPalette />
      <BulkTagPrompt />
      <Onboarding />
      <ContextMenuHost />
      <DuplicateDialog />
      <Toaster />
      <ResizeGrips />
    </MotionConfig>
  );
}
