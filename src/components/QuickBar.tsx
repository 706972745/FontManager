import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { motion } from "motion/react";
import {
  Camera,
  ChevronRight,
  Folder,
  Minimize2,
  Pin,
  PinOff,
  Search,
  Type,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { openContextMenu } from "../design/primitives/ContextMenu";
import { easeTop, staggerDelay, spring } from "../design/springs";
import { useFontCss } from "../lib/fontLoader";
import { hasScriptNote, useScriptStatus } from "../lib/scriptCoverage";
import { ScriptChip } from "./ScriptChip";
import { FaceLine, faceLineFontSize } from "./FaceLine";
import { useT, type TKey } from "../lib/i18n";
import { useDisplayName } from "../lib/displayName";
import { copyrightExpired, effectiveCopyrightClass } from "../lib/license";
import { useFamilyMembership } from "../lib/membership";
import { buildFamilyMenu, copyText } from "../lib/menus";
import { subscribeContextMenuSize } from "../lib/menuMetrics";
import { expandQuickbarPanel, minimizeQuickbar, useQuickbarDock } from "../lib/useQuickbarDock";
import { useInView } from "../lib/useInView";
import { useWindowDrag } from "../lib/useWindowDrag";
import { INTRO_OFF, useIntro } from "../lib/useIntro";
import { WarmFooter } from "./WarmFooter";
import { LoadProgress } from "./LoadProgress";
import {
  applyFamilyFilters,
  familiesFor,
  sortFamilies,
  SIZES,
  syncQuickbarMinSize,
  useFontStore,
  type Family,
} from "../state/fontStore";
import type { FontFace } from "../lib/ipc";
import { FilterMenu } from "./TopBar";

/**
 * 只有屏幕上看得见的头几张卡片走 motion 入场动画。
 * 字体库动辄上千个族，给每张都挂一个 motion 组件会把进入速览时的主线程
 * 占住几百毫秒，窗口形变动画就被拖出可见的停顿；屏幕外的卡片本来也看不到动画。
 */
const ANIMATED_ITEMS = 24;

/**
 * 速览里的一行字重。
 *
 * 实现全在 FaceLine（完整界面展开后的字重行用的是同一个组件，样式与交互天然一致）。
 * 这里保留一层包装只是为了在 map 里少写几个 prop。
 */
function QuickFaceRow({
  family,
  face,
  probeText,
  onHover,
}: {
  family: Family;
  face: FontFace;
  /** 用户输入的示例文字（空串 = 不标注） */
  probeText: string;
  onHover: (faceId: string | null) => void;
}) {
  // 和完整界面展开后的字重行是同一个组件（0.9.3-5 起两处完全一致）
  return <FaceLine family={family} face={face} probeText={probeText} onHover={onHover} />;
}

function QuickItem({ family, index }: { family: Family; index: number }) {
  const t = useT();
  // 速览里同样按界面语言显示字体名（与完整界面一个口径）
  const displayName = useDisplayName();
  const sampleText = useFontStore((s) => s.sampleText);
  const sizeIndex = useFontStore((s) => s.sizeIndex);
  // 版权状态：手动设置优先，否则按版权信息自动识别（与完整界面卡片一致）
  const copyrightOverride = useFontStore((s) => s.copyrightStatus[family.name]);
  const copyrightExpiry = useFontStore((s) => s.copyrightExpiry[family.name]);
  const { inSnapshots, inCollections } = useFamilyMembership(family.name);
  const size = SIZES[sizeIndex];
  const lead = family.faces.find((f) => f.style === "Regular") ?? family.faces[0];
  // 首屏这几张立刻加载字体；其余等滚动到附近再说，避免上千个 FontFace 一起加载
  const [itemRef, inView] = useInView<HTMLDivElement>();
  /** 鼠标正悬停的字重行：卡片预览临时用它渲染，移开恢复 Regular（与完整界面一致） */
  const [hoverFaceId, setHoverFaceId] = useState<string | null>(null);
  const previewFace = family.faces.find((f) => f.id === hoverFaceId) ?? lead;
  const { fontFamily } = useFontCss(index < ANIMATED_ITEMS || inView ? previewFace : null);
  const fontStyle = previewFace.italic ? "italic" : "normal";
  const previewWeight = previewFace === lead ? undefined : previewFace.weight;
  // 与完整界面主列表一致：优先用户输入的示例文本，否则用族名
  const text = sampleText.trim() || family.name;
  // 缺语言文字的判定只看用户真正输入的示例文字（没输入就不标）
  const probeText = sampleText.trim();
  const scriptStatus = useScriptStatus(lead, probeText);

  // 权重：手动设置 > 字体自带版权信息 > 文件夹备注 / 版权信息文件判定的版权
  const licCls = effectiveCopyrightClass(
    lead.license ?? null,
    copyrightOverride,
    lead.copyrightClass ?? null,
  );
  const licExpired = licCls === "timelimited" && copyrightExpired(copyrightExpiry);
  const licTitle = licExpired
    ? `${t("copyright.expiryDate")}: ${copyrightExpiry} — ${t("copyright.expired")}`
    : licCls === "timelimited" && copyrightExpiry
      ? `${t("copyright.expiryDate")}: ${copyrightExpiry}`
      : t("detail.copyright");
  // 版权原文：优先字形版权声明，退回到许可文本（与详情面板「版权信息」一致）
  const copyright = family.copyright || family.license || lead.copyright || lead.license || "";
  const hasChips =
    family.tags.length > 0 || inSnapshots.length > 0 || inCollections.length > 0;

  // 窗口形变期间一律不动：此时只有窗口自己在变大变小，内容再逐个入场会显得抖
  const intro = useIntro();
  const animated = intro && index < ANIMATED_ITEMS;
  /** 展开这一族的字重列表（默认只显示字族，和完整界面一个思路） */
  const [expanded, setExpanded] = useState(false);
  // 展开字重后里面还有按钮，<button> 不能嵌套 <button>，所以根节点用 div + role
  const Item = animated ? motion.div : "div";
  // 超出动画范围的卡片用 CSS 过渡做悬浮/按下反馈，观感一致但没有 motion 的初始化开销
  const plainProps = animated
    ? {
        initial: { opacity: 0, y: 12 },
        animate: { opacity: 1, y: 0 },
        transition: { ...spring, delay: staggerDelay(index) },
        whileHover: { y: -1 },
        whileTap: { scale: 0.99 },
      }
    : {};

  return (
    <Item
      ref={itemRef}
      role="button"
      tabIndex={0}
      className="qb-item"
      title={t("quickbar.copyHint", { name: family.name })}
      onClick={() => copyText(family.name, t("copy.familyName"))}
      onKeyDown={(e) => {
        // div[role=button] 不会自己响应键盘：Enter / Space 得手动接（§5 第 31 条）。
        // 焦点在子控件（展开字重、字重行）上时那个控件负责，这里不抢。
        if (e.key !== "Enter" && e.key !== " ") return;
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        // Space 同时是主界面的「启用 / 停用」：卡片自己消费掉，别再冒泡
        e.stopPropagation();
        copyText(family.name, t("copy.familyName"));
      }}
      onContextMenu={(e) => openContextMenu(e, buildFamilyMenu(family))}
      {...plainProps}
    >
      <span className="qb-item-head">
        <span
          className="qb-item-glyph"
          style={fontFamily ? { fontFamily, fontStyle, fontWeight: previewWeight } : undefined}
          aria-hidden="true"
        >
          Aa
        </span>
        <span className="qb-item-info">
          <span
            className="qb-item-name"
            style={fontFamily ? { fontFamily, fontStyle, fontWeight: previewWeight } : undefined}
          >
            {displayName(family)}
          </span>
          {/* 画不出示例文字的语言时，这一行直接换成「无中文」这类标注（与完整界面一致） */}
          {hasScriptNote(scriptStatus) ? (
            <span className="qb-item-noscript" style={{ minHeight: size * 1.15 }}>
              <ScriptChip status={scriptStatus} />
            </span>
          ) : (
            <motion.span
              className="qb-item-sample"
              style={
                fontFamily
                  ? { fontFamily, fontStyle, fontWeight: previewWeight, fontSize: size }
                  : { fontSize: size }
              }
              initial={animated ? { opacity: 0, y: 5 } : false}
              animate={animated ? { opacity: 1, y: 0 } : undefined}
              transition={animated ? spring : undefined}
            >
              {text}
            </motion.span>
          )}
        </span>
        <span className="qb-item-aside">
          <span className={`lic-chip lic-${licCls} ${licExpired ? "lic-expired" : ""}`} title={licTitle}>
            {t(`copyright.${licCls}` as TKey)}
          </span>
          {family.faces.length > 1 && (
            <button
              type="button"
              className="qb-item-meta qb-item-expand tabular"
              aria-expanded={expanded}
              aria-label={
                expanded
                  ? t("card.collapseStyles")
                  : t("card.expandStyles")
              }
              title={t("card.stylesCount", { count: family.faces.length })}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
            >
              <ChevronRight
                size={11}
                strokeWidth={2}
                style={{
                  transform: expanded ? "rotate(90deg)" : undefined,
                  transition: "transform 140ms ease",
                }}
              />
              {family.faces.length}
            </button>
          )}
        </span>
      </span>

      {hasChips && (
        <span className="qb-item-chips">
          {family.tags.map((tag) => (
            <span key={`tag-${tag}`} className="member-chip qb-chip">
              {tag}
            </span>
          ))}
          {inSnapshots.map((name) => (
            <span key={`snap-${name}`} className="member-chip member-chip-snap qb-chip" title={t("card.inSnapshot", { name })}>
              <Camera size={10} strokeWidth={1.75} />
              {name}
            </span>
          ))}
          {inCollections.map((name) => (
            <span key={`coll-${name}`} className="member-chip member-chip-coll qb-chip" title={t("card.inCollection", { name })}>
              <Folder size={10} strokeWidth={1.75} />
              {name}
            </span>
          ))}
        </span>
      )}

      {copyright && <span className="qb-item-copy">{copyright}</span>}

      {expanded && family.faces.length > 0 && (
        <div
          className="qb-faces"
          /* 字重名的大小跟着上面的示例字号走（速览面板只有卡片一半宽，取 1/8） */
          style={{ "--face-line-size": faceLineFontSize(size, 8) } as CSSProperties}
          onClick={(e) => e.stopPropagation()}
        >
          {family.faces.map((face) => (
            <QuickFaceRow
              key={face.id}
              family={family}
              face={face}
              probeText={probeText}
              onHover={setHoverFaceId}
            />
          ))}
        </div>
      )}
    </Item>
  );
}

export function QuickBar() {
  const t = useT();
  const win = getCurrentWindow();
  const fonts = useFontStore((s) => s.fonts);
  const tags = useFontStore((s) => s.tags);
  const sessionActivated = useFontStore((s) => s.sessionActivated);
  const setQuickbar = useFontStore((s) => s.setQuickbar);
  const autoHide = useFontStore((s) => s.quickbarAutoHide);
  const setAutoHide = useFontStore((s) => s.setQuickbarAutoHide);
  const sort = useFontStore((s) => s.sort);
  // 顶栏「筛选」的条件与完整界面共用同一份状态、同一套口径
  const classFilter = useFontStore((s) => s.classFilter);
  const scriptFilter = useFontStore((s) => s.scriptFilter);
  const formatFilter = useFontStore((s) => s.formatFilter);
  const featureFilter = useFontStore((s) => s.featureFilter);
  const sourceFilter = useFontStore((s) => s.sourceFilter);
  const charFilter = useFontStore((s) => s.charFilter);
  const charMatches = useFontStore((s) => s.charMatches);
  const variableOnly = useFontStore((s) => s.variableOnly);
  const toggleableOnly = useFontStore((s) => s.toggleableOnly);
  const incompleteOnly = useFontStore((s) => s.incompleteOnly);
  const licenseFilter = useFontStore((s) => s.licenseFilter);
  const copyrightStatus = useFontStore((s) => s.copyrightStatus);
  const sampleText = useFontStore((s) => s.sampleText);
  const setSampleText = useFontStore((s) => s.setSampleText);
  const sizeIndex = useFontStore((s) => s.sizeIndex);
  const setSizeIndex = useFontStore((s) => s.setSizeIndex);
  // 速览 ↔ 完整界面切换期间把内容钉在目标尺寸上，窗口形变时内容不重排
  const morph = useFontStore((s) => s.morph);
  const [query, setQuery] = useState("");

  // 拖到屏幕顶部时整个速览窗口收起成一条（contentHeight 用于动画期间钉住内容高度）
  const { docked, contentHeight, phase, bar } = useQuickbarDock(autoHide);

  /**
   * 内容可见性门控。
   *
   * 旧实现是 qb-birth 固定时长动画（挂载 300ms 延迟 + 200ms 淡入），但进入速览的
   * 真正耗时不是固定的：adoptQuickbarDock 里有一段等 QuickBar 挂载的轮询（最长 600ms），
   * 首屏上千张卡片的渲染还会堵住主线程，IPC 往返全部顺延。动画一放完（fill 结束
   * opacity 回到 1），dock 却还没接管——morph 已清、docked 未置位，这个空档渲染的是
   * 完整 qb-content，顶栏（已启用 N / 搜索框 / 完整界面按钮）就会在 34px 的窗口条里
   * 闪现（0.9.3-14 修的用户报告 bug）。
   *
   * 改成事件门控：dock 接管（docked=true）后才淡入；几何失败走「仅切换界面」分支时
   * morph 已清但 docked 永远不会来，用兜底计时器放行，保证功能不失效。
   */
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (revealed) return;
    if (docked) {
      setRevealed(true);
      return;
    }
    if (!morph) {
      const t = window.setTimeout(() => setRevealed(true), 350);
      return () => window.clearTimeout(t);
    }
  }, [docked, morph, revealed]);
  // 提示里显示的按键跟着设置走（用户可能把它改成了 Ctrl+Alt+Q 之类）
  const hotkeyLabel = useFontStore((s) => s.quickbarHotkey.label);
  const dockHint = t("quickbar.topbarHint", { hotkey: hotkeyLabel });
  // 自实现拖动：绕开系统标题栏拖动带来的「拖到顶部就最大化」
  const dragWindow = useWindowDrag();
  // 进入速览的那一下窗口正在形变，列表不要再做逐个入场的动作
  const intro = useIntro();

  // 速览窗口整段时间都挂 qb-mode：html/body 让出底色，四角交给 .qb-frame 的 CSS 圆角。
  // 不能只按 docked 挂 —— 展开的那一瞬间 docked 变 false，底色会回来，圆角外侧露出直角，
  // 和「系统圆角要等 IPC 才生效」叠在一起就是用户看到的四角闪一下。
  useEffect(() => {
    document.body.classList.add("qb-mode");
    return () => document.body.classList.remove("qb-mode");
  }, []);

  // 速览界面不接收拖放导入：拖放事件是窗口级的，这里挂一个空监听把它吃掉。
  // 速览是查名字 / 复制的浮层，把字体文件拖进来就开始装字体完全是意外行为。
  useEffect(() => {
    const promise = getCurrentWebview().onDragDropEvent(() => {});
    return () => {
      void promise.then((un) => un()).catch(() => {});
    };
  }, []);

  // 右键菜单实测尺寸变化时，同步窗口最小尺寸（宽度 ≥ 菜单宽 × 1.5，高度 ≥ 菜单高）
  useEffect(() => subscribeContextMenuSize(() => void syncQuickbarMinSize()), []);

  // 窗口边缘阴影一律不要（用户要求：完整界面和速览统一都不要）。
  // DWM 阴影还会强制窗口不透明（tauri#8308），速览收成细线时窗口必须透出桌面。
  // 进速览补一次关闭即可，退出速览也不打开——完整界面的那圈阴影同样来自它。
  useEffect(() => {
    void win.setShadow(false).catch(() => {});
  }, [win]);

  // 已启用的字族总数：顶栏「已启用 N」永远报这个数，筛选/搜索只影响下面的列表，
  // 否则勾一个筛选条件就会显示「已启用 0」，看起来像字体全被停用了。
  const enabledCount = useMemo(
    () =>
      [...familiesFor(fonts, tags).values()].filter(
        (f) => f.active || f.partial || sessionActivated.includes(f.name),
      ).length,
    [fonts, tags, sessionActivated],
  );

  const families = useMemo(() => {
    const enabled = [...familiesFor(fonts, tags).values()].filter(
      (f) => f.active || f.partial || sessionActivated.includes(f.name),
    );
    const filtered = applyFamilyFilters(enabled, {
      classFilter,
      scriptFilter,
      formatFilter,
      featureFilter,
      sourceFilter,
      charFilter,
      charMatches,
      variableOnly,
      toggleableOnly,
      incompleteOnly,
      licenseFilter,
      copyrightStatus,
    });
    const q = query.trim().toLowerCase();
    const hit = q ? filtered.filter((f) => f.name.toLowerCase().includes(q)) : filtered;
    return sortFamilies(hit, sort);
  }, [
    fonts, tags, sessionActivated, query, sort,
    classFilter, scriptFilter, formatFilter, featureFilter, sourceFilter,
    charFilter, charMatches, variableOnly, toggleableOnly, licenseFilter, copyrightStatus,
  ]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const inField =
        e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (inField && query) {
        // 先清空搜索，再按一次才退出速览界面
        e.preventDefault();
        setQuery("");
        return;
      }
      if (inField) return;
      e.preventDefault();
      void setQuickbar(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setQuickbar, query]);

  // 窗口形变期间把 qb-frame 钉在目标尺寸；收成细线时钉在细线尺寸。
  // 收起/展开动画期间 qb-frame 的高度不再走 React——由 useQuickbarDock 的
  // animateHeight 每帧直接写 DOM（带 45ms 前导量，保证内容底边始终落在窗口
  // 底边内侧，圆角画在内容自己的边缘上）；contentHeight 只负责把内层
  // .qb-pin 钉在原高度，让内容不被压缩。
  const frameStyle: CSSProperties | undefined = morph
    ? { width: `${morph.width}px`, height: `${morph.height}px` }
    : bar != null
      // 收成细线时窗口是一小段居中的短线，不再占满整个速览宽度
      ? { width: `${bar.width}px`, height: `${bar.height}px` }
      : undefined;
  const pinStyle: CSSProperties | undefined =
    contentHeight != null ? { height: `${contentHeight}px` } : undefined;

  return (
    <motion.div
      className="qb-frame"
      data-docked={docked ? "true" : undefined}
      data-dock-phase={docked ? phase : undefined}
      style={frameStyle}
      initial={intro ? { opacity: 0 } : false}
      animate={{ opacity: revealed ? 1 : 0 }}
      transition={intro ? easeTop : INTRO_OFF}
    >
      <div
        className="qb-pin"
        data-pin={contentHeight != null ? "true" : undefined}
        style={pinStyle}
      >
      {/* 抓手条：无论收起还是展开都保留，窗口始终能拖动 */}
      <div
        className="qb-grip"
        onPointerDown={dragWindow}
        data-collapsed={docked ? "true" : undefined}
        title={docked ? dockHint : undefined}
      >
        <span className="qb-grip-bar" />
      </div>

      {docked ? (
        <div
          className="qb-dockbar"
          role="button"
          tabIndex={0}
          onPointerDown={dragWindow}
          title={dockHint}
          onKeyDown={(e) => {
            // 收起态这条也是「入口」：键盘用户必须能把它叫出来（§5 第 31 条）
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            e.stopPropagation();
            void expandQuickbarPanel();
          }}
        >
          <span className="qb-dock-dot" aria-hidden="true" />
          <span className="qb-dock-label">
            {t("quickbar.collapsedHint", { hotkey: hotkeyLabel })}
          </span>
        </div>
      ) : (
        <div className="qb-content">
          <header className="qb-head" onPointerDown={dragWindow}>
            <span className="qb-title">
              {t("quickbar.title")}
              <span className="qb-count tabular">{enabledCount}</span>
            </span>

            <div className="qb-search">
              <Search size={13} strokeWidth={1.5} className="field-icon" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("quickbar.search")}
                aria-label={t("quickbar.search")}
                spellCheck={false}
              />
              {query && (
                <button
                  className="search-clear"
                  onClick={() => setQuery("")}
                  aria-label={t("top.searchClear")}
                >
                  <X size={12} strokeWidth={2} />
                </button>
              )}
            </div>

            <div className="qb-actions">
              <button
                className={`qb-btn ${autoHide ? "qb-btn-on" : ""}`}
                aria-pressed={autoHide}
                title={`${t(autoHide ? "quickbar.autoHideOn" : "quickbar.autoHideOff")}\n${dockHint}`}
                aria-label={t("quickbar.autoHide")}
                onClick={() => setAutoHide(!autoHide)}
              >
                {autoHide ? <Pin size={13} strokeWidth={1.5} /> : <PinOff size={13} strokeWidth={1.5} />}
              </button>
              <button
                className="qb-btn"
                title={t("quickbar.back")}
                aria-label={t("quickbar.back")}
                onClick={() => void setQuickbar(false)}
              >
                {t("quickbar.backShort")}
              </button>
              <button
                className="qb-btn"
                title={t("titlebar.minimize")}
                aria-label={t("titlebar.minimize")}
                onClick={() => {
                  // 贴在屏幕顶边时由 dock 接管：内容先卷走、再真最小化，且不播系统飞行动画
                  void minimizeQuickbar().then((handled) => {
                    if (!handled) void win.minimize();
                  });
                }}
              >
                <Minimize2 size={12} strokeWidth={1.6} />
              </button>
              <button
                className="qb-btn qb-btn-close"
                title={t("titlebar.close")}
                aria-label={t("titlebar.close")}
                onClick={() => void win.close()}
              >
                <X size={13} strokeWidth={1.6} />
              </button>
            </div>
          </header>

          <div className="qb-tools">
            <div className="topbar-field qb-sample">
              <Type size={13} strokeWidth={1.5} className="field-icon" />
              <input
                value={sampleText}
                onChange={(e) => setSampleText(e.target.value)}
                placeholder={t("top.samplePlaceholder")}
                aria-label={t("top.sampleAria")}
                spellCheck={false}
              />
            </div>
            <div
              className="topbar-size qb-size"
              style={{ "--fill": `${(sizeIndex / (SIZES.length - 1)) * 100}%` } as CSSProperties}
            >
              <input
                type="range"
                min={0}
                max={SIZES.length - 1}
                step={1}
                value={sizeIndex}
                onChange={(e) => setSizeIndex(Number(e.target.value))}
                aria-label={t("top.sizeAria")}
              />
              <span className="size-value tabular">{SIZES[sizeIndex]}</span>
            </div>
            <FilterMenu />
          </div>

          <div className="qb-body">
            {families.length === 0 ? (
              <p className="qb-empty">
                {enabledCount > 0 ? t("empty.search.title") : t("quickbar.empty")}
              </p>
            ) : (
              <div className="qb-list">
                {families.map((family, i) => (
                  <QuickItem key={family.name} family={family} index={i} />
                ))}
              </div>
            )}
          </div>
          <LoadProgress compact />
          <WarmFooter compact />
        </div>
      )}
      </div>
    </motion.div>
  );
}
