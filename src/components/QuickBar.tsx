import { getCurrentWindow } from "@tauri-apps/api/window";
import { motion } from "motion/react";
import { Camera, Folder, Minimize2, Pin, PinOff, Search, Type, X } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { openContextMenu } from "../design/primitives/ContextMenu";
import { easeTop, staggerDelay, spring } from "../design/springs";
import { useFontCss } from "../lib/fontLoader";
import { useT, type TKey } from "../lib/i18n";
import { copyrightExpired, effectiveCopyrightClass } from "../lib/license";
import { useFamilyMembership } from "../lib/membership";
import { buildFamilyMenu, copyText } from "../lib/menus";
import { subscribeContextMenuSize } from "../lib/menuMetrics";
import { TOP_BAR_HOTKEY, minimizeQuickbar, useQuickbarDock } from "../lib/useQuickbarDock";
import { useInView } from "../lib/useInView";
import { useWindowDrag } from "../lib/useWindowDrag";
import { INTRO_OFF, useIntro } from "../lib/useIntro";
import { WarmFooter } from "./WarmFooter";
import {
  familiesFor,
  sortFamilies,
  SIZES,
  syncQuickbarMinSize,
  useFontStore,
  type Family,
} from "../state/fontStore";
import { SortMenu } from "./TopBar";

/**
 * 只有屏幕上看得见的头几张卡片走 motion 入场动画。
 * 字体库动辄上千个族，给每张都挂一个 motion 组件会把进入速览时的主线程
 * 占住几百毫秒，窗口形变动画就被拖出可见的停顿；屏幕外的卡片本来也看不到动画。
 */
const ANIMATED_ITEMS = 24;

function QuickItem({ family, index }: { family: Family; index: number }) {
  const t = useT();
  const sampleText = useFontStore((s) => s.sampleText);
  const sizeIndex = useFontStore((s) => s.sizeIndex);
  // 版权状态：手动设置优先，否则按版权信息自动识别（与完整界面卡片一致）
  const copyrightOverride = useFontStore((s) => s.copyrightStatus[family.name]);
  const copyrightExpiry = useFontStore((s) => s.copyrightExpiry[family.name]);
  const { inSnapshots, inCollections } = useFamilyMembership(family.name);
  const size = SIZES[sizeIndex];
  const lead = family.faces.find((f) => f.style === "Regular") ?? family.faces[0];
  // 首屏这几张立刻加载字体；其余等滚动到附近再说，避免上千个 FontFace 一起加载
  const [itemRef, inView] = useInView<HTMLButtonElement>();
  const { fontFamily } = useFontCss(index < ANIMATED_ITEMS || inView ? lead : null);
  const fontStyle = lead.italic ? "italic" : "normal";
  // 与完整界面主列表一致：优先用户输入的示例文本，否则用族名
  const text = sampleText.trim() || family.name;

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
  const Item = animated ? motion.button : "button";
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
      type="button"
      className="qb-item"
      title={t("quickbar.copyHint", { name: family.name })}
      onClick={() => copyText(family.name, t("copy.familyName"))}
      onContextMenu={(e) => openContextMenu(e, buildFamilyMenu(family))}
      {...plainProps}
    >
      <span className="qb-item-head">
        <span className="qb-item-glyph" style={fontFamily ? { fontFamily, fontStyle } : undefined} aria-hidden="true">
          Aa
        </span>
        <span className="qb-item-info">
          <span className="qb-item-name" style={fontFamily ? { fontFamily, fontStyle } : undefined}>
            {family.name}
          </span>
          <motion.span
            className="qb-item-sample"
            style={fontFamily ? { fontFamily, fontStyle, fontSize: size } : { fontSize: size }}
            initial={animated ? { opacity: 0, y: 5 } : false}
            animate={animated ? { opacity: 1, y: 0 } : undefined}
            transition={animated ? spring : undefined}
          >
            {text}
          </motion.span>
        </span>
        <span className="qb-item-aside">
          <span className={`lic-chip lic-${licCls} ${licExpired ? "lic-expired" : ""}`} title={licTitle}>
            {t(`copyright.${licCls}` as TKey)}
          </span>
          {family.faces.length > 1 && (
            <span className="qb-item-meta tabular">{family.faces.length}</span>
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
  const sampleText = useFontStore((s) => s.sampleText);
  const setSampleText = useFontStore((s) => s.setSampleText);
  const sizeIndex = useFontStore((s) => s.sizeIndex);
  const setSizeIndex = useFontStore((s) => s.setSizeIndex);
  // 速览 ↔ 完整界面切换期间把内容钉在目标尺寸上，窗口形变时内容不重排
  const morph = useFontStore((s) => s.morph);
  const [query, setQuery] = useState("");

  // 拖到屏幕顶部时整个速览窗口收起成一条（contentHeight 用于动画期间钉住内容高度）
  const { docked, contentHeight, phase, bar } = useQuickbarDock(autoHide);
  const dockHint = t("quickbar.topbarHint", { hotkey: TOP_BAR_HOTKEY });
  // 自实现拖动：绕开系统标题栏拖动带来的「拖到顶部就最大化」
  const dragWindow = useWindowDrag();
  // 进入速览的那一下窗口正在形变，列表不要再做逐个入场的动作
  const intro = useIntro();

  // 右键菜单实测尺寸变化时，同步窗口最小尺寸（宽度 ≥ 菜单宽 × 1.5，高度 ≥ 菜单高）
  useEffect(() => subscribeContextMenuSize(() => void syncQuickbarMinSize()), []);

  // 收成细线时窗口要透出桌面（只留一条实心线）。Windows 上 DWM 窗口阴影会强制
  // 窗口不透明（tauri#8308），所以 bar 阶段必须关掉阴影，其余阶段再开回来。
  // retract 阶段底色已经在淡成透明，必须同步关掉阴影，否则过渡那一瞬间会是一块实心黑。
  useEffect(() => {
    void win.setShadow(!(docked && (phase === "bar" || phase === "retract"))).catch(() => {});
  }, [win, docked, phase]);

  const families = useMemo(() => {
    const enabled = [...familiesFor(fonts, tags).values()].filter(
      (f) => f.active || f.partial || sessionActivated.includes(f.name),
    );
    const q = query.trim().toLowerCase();
    const hit = q ? enabled.filter((f) => f.name.toLowerCase().includes(q)) : enabled;
    return sortFamilies(hit, sort);
  }, [fonts, tags, sessionActivated, query, sort]);

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

  // 窗口形变期间钉住内容尺寸；收起/展开动画期间钉住内容高度
  const frameStyle: CSSProperties | undefined = morph
    ? { width: `${morph.width}px`, height: `${morph.height}px` }
    : contentHeight != null
      ? { height: `${contentHeight}px` }
      : bar != null
        // 收成细线时窗口是一小段居中的短线，不再占满整个速览宽度
        ? { width: `${bar.width}px`, height: `${bar.height}px` }
        : undefined;

  return (
    <motion.div
      // 进入速览（窗口收成顶部一条）时不能让内容立刻淡入：窗口还在收拢中段，
      // 内容提前亮出来会被"啪地出现又突然收走"。用 qb-birth 延迟到收拢完成后淡入。
      className={morph ? "qb-frame qb-birth" : "qb-frame"}
      data-docked={docked ? "true" : undefined}
      data-dock-phase={docked ? phase : undefined}
      style={frameStyle}
      initial={intro ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      transition={intro ? easeTop : INTRO_OFF}
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
        <div className="qb-dockbar" onPointerDown={dragWindow} title={dockHint}>
          <span className="qb-dock-dot" aria-hidden="true" />
          <span className="qb-dock-label">
            {t("quickbar.collapsedHint", { hotkey: TOP_BAR_HOTKEY })}
          </span>
        </div>
      ) : (
        <div className="qb-content">
          <header className="qb-head" onPointerDown={dragWindow}>
            <span className="qb-title">
              {t("quickbar.title")}
              <span className="qb-count tabular">{families.length}</span>
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
            <SortMenu />
          </div>

          <div className="qb-body">
            {families.length === 0 ? (
              <p className="qb-empty">{t("quickbar.empty")}</p>
            ) : (
              <div className="qb-list">
                {families.map((family, i) => (
                  <QuickItem key={family.name} family={family} index={i} />
                ))}
              </div>
            )}
          </div>
          <WarmFooter compact />
        </div>
      )}
    </motion.div>
  );
}
