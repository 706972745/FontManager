import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import {
  ChevronRight,
  Minimize2,
  Pin,
  PinOff,
  Search,
  Type,
  X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { openContextMenu } from "../design/primitives/ContextMenu";
import { toast } from "../design/primitives/Toast";
import { useMarquee } from "../design/primitives/useMarquee";
import { easeTop, spring, springSnappy, springSoft, staggerDelay } from "../design/springs";
import { MemberChip } from "./MemberChip";
import { useListFontCss } from "../lib/fontLoader";
import { listChars } from "../lib/listChars";
import { hasScriptNote, useScriptStatus } from "../lib/scriptCoverage";
import { styleScope } from "../lib/styleScope";
import { ScriptChip } from "./ScriptChip";
import { FaceLine, faceLineFontSize } from "./FaceLine";
import { useT, type TKey } from "../lib/i18n";
import { dockKeysFor, splitDockHint } from "../lib/dockHint";
import { useDisplayName } from "../lib/displayName";
import { copyrightExpired } from "../lib/license";
import { familyCopyrightClass } from "../lib/license";
import { isEnabledNow } from "../lib/familyState";
import { familyMatches, searchTokens } from "../lib/familySearch";
import { useFamilyMembership } from "../lib/membership";
import { buildFamilyMenu, copyText } from "../lib/menus";
import { subscribeContextMenuSize } from "../lib/menuMetrics";
import { expandQuickbarPanel, minimizeQuickbar, useQuickbarDock } from "../lib/useQuickbarDock";
import { useInView } from "../lib/useInView";
import { experiment } from "../lib/experiment";
import { useWindowDrag } from "../lib/useWindowDrag";
import { INTRO_OFF, useIntro } from "../lib/useIntro";
import { WarmFooter } from "./WarmFooter";
import { LoadProgress } from "./LoadProgress";
import { ApplyProgress } from "./ApplyProgress";
import {
  applyFamilyFilters,
  familiesFor,
  searchLabelMaps,
  searchableFamily,
  sortFamilies,
  SIZES,
  syncQuickbarMinSize,
  useFontStore,
  type Family,
} from "../state/fontStore";

/**
 * 速览的实验开关（§11.2）。默认值 = 现状。
 *
 * 速览有**两层**门控，实验时要分开动，否则分不清是「挂载多了」还是「提前加载了」：
 * - `overscan` 决定虚拟列表多挂几条 DOM（挂载不等于加载）；
 * - `rootMargin` 决定这些 DOM 里哪些真的去 `useFontCss` 加载字体。
 * 现在只有 `index < ANIMATED_ITEMS || inView` 的项才传非空 face，所以两层是串联的。
 */
const QB_OVERSCAN = experiment.quickbarOverscan();
const QB_ROOT_MARGIN = experiment.quickbarRootMargin();
import { ipc, type AimResult, type FontFace } from "../lib/ipc";
import { buildFaceIndexCached, entryFaceIds, faceKey } from "../lib/snapshotKey";
import { FilterMenu } from "./TopBar";
import { SearchSuggest, type Suggestion } from "./SearchSuggest";
import { openPluginSettings } from "../lib/pluginMenu";
import { usePluginStore } from "../lib/pluginStore";
import { StarRating } from "./StarRating";

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

function QuickItem({
  family,
  index,
  onAim,
}: {
  family: Family;
  index: number;
  /**
   * 双击示例文字：进入「点一下要应用到的窗口」待命（1.9.10）。
   * 由 QuickBar 统一持有待命状态 —— 待命只有一个，行自己记不住「现在等的是谁」。
   */
  onAim: (family: Family, faceId: string) => void;
}) {
  const t = useT();
  // 速览里同样按界面语言显示字体名（与完整界面一个口径）
  const displayName = useDisplayName();
  const sampleText = useFontStore((s) => s.sampleText);
  const sizeIndex = useFontStore((s) => s.sizeIndex);
  // 版权状态：手动设置优先，否则按版权信息自动识别（与完整界面卡片一致）
  const copyrightOverride = useFontStore((s) => s.copyrightStatus[family.name]);
  const copyrightExpiry = useFontStore((s) => s.copyrightExpiry[family.name]);
  const { snapshotBadges, collectionBadges } = useFamilyMembership(family.name, family.faces);
  const size = SIZES[sizeIndex];
  /** 悬停跑马灯：示例文本被截断时缓慢左移展示结尾、移开快速回滚（用户 2026-11-05） */
  const previewMarquee = useMarquee(size);
  const lead = family.faces.find((f) => f.style === "Regular") ?? family.faces[0];
  /**
   * 速览里只列**已启用**的字重（用户 2026-10-31：「可单独显示已经启用的字重，没启用的字重不会显示出来」）。
   * 一个族里可能只启用了几个字重，列出没启用的会让人以为它们也能用。
   * 整族一个都没启用时不至于出现在速览里，兜底仍用全量，免得列表空掉。
   */
  const enabledFaces = family.faces.filter((f) => f.active);
  const visibleFaces = enabledFaces.length > 0 ? enabledFaces : family.faces;
  /** 与完整界面同一口径：只列出部分字重时，旁边的数字写成「1/4」而不是光一个「1」 */
  const scope = styleScope(visibleFaces, family.faces);
  // 首屏这几张立刻加载字体；其余等滚动到附近再说，避免上千个 FontFace 一起加载
  const [itemRef, inView] = useInView<HTMLDivElement>(QB_ROOT_MARGIN);
  /** 鼠标正悬停的字重行：卡片预览临时用它渲染，移开恢复 Regular（与完整界面一致） */
  const [hoverFaceId, setHoverFaceId] = useState<string | null>(null);
  const previewFace = family.faces.find((f) => f.id === hoverFaceId) ?? lead;
  /**
   * 速览条目同样只渲染示例文字 + `Aa`，走列表子集通道（§12）。
   * `index < ANIMATED_ITEMS || inView` 这个门控保持原样 —— 它是「首屏几张立刻加载、
   * 其余等滚到附近」的策略，与「加载哪份文件」无关。
   */
  const listCharSet = listChars(family, sampleText, t("preview.defaultSample"));
  const { fontFamily } = useListFontCss(
    index < ANIMATED_ITEMS || inView ? previewFace : null,
    listCharSet,
  );
  const fontStyle = previewFace.italic ? "italic" : "normal";
  const previewWeight = previewFace === lead ? undefined : previewFace.weight;
  // 与完整界面主列表一致：优先用户输入的示例文本，否则用族名
  const text = sampleText.trim() || family.name;
  // 缺语言文字的判定只看用户真正输入的示例文字（没输入就不标）
  const probeText = sampleText.trim();
  const scriptStatus = useScriptStatus(lead, probeText);

  // 权重：手动设置 > 字体自带版权信息 > 文件夹备注 / 版权信息文件判定的版权
  // 与筛选同一口径（`familyCopyrightClass`），否则「勾了商用免费却筛出标着未知的卡」
  const licCls = familyCopyrightClass(family.faces, copyrightOverride);
  const licExpired = licCls === "timelimited" && copyrightExpired(copyrightExpiry);
  const licTitle = licExpired
    ? `${t("copyright.expiryDate")}: ${copyrightExpiry} — ${t("copyright.expired")}`
    : licCls === "timelimited" && copyrightExpiry
      ? `${t("copyright.expiryDate")}: ${copyrightExpiry}`
      : t("detail.copyright");
  // 版权原文：优先字形版权声明，退回到许可文本（与详情面板「版权信息」一致）
  const copyright = family.copyright || family.license || lead.copyright || lead.license || "";
  const hasChips =
    family.tags.length > 0 || snapshotBadges.length > 0 || collectionBadges.length > 0;

  // 窗口形变期间一律不动：此时只有窗口自己在变大变小，内容再逐个入场会显得抖
  const intro = useIntro();
  const animated = intro && index < ANIMATED_ITEMS;
  /**
   * 展开字重用的是 `height: 0 → auto` 动画，而 `MotionConfig reducedMotion`
   * 管不到 height —— 所以这里显式接管开关（与完整界面 FamilyCard.tsx:78-80 同口径）：
   * 系统开了减弱动效、或用户在软件里开了，就直接给终态，不做逐帧过渡。
   */
  const motionPref = useFontStore((s) => s.motionPref);
  const systemReduce = useReducedMotion();
  const noMotion = systemReduce || motionPref === "reduced";
  /** 展开这一族的字重列表（默认只显示字族，和完整界面一个思路） */
  const [expanded, setExpanded] = useState(false);
  /** 点名字复制后就地给一个「已复制」，1.5s 消退（设计 R2 状态 4） */
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const copyName = () => {
    copyText(family.name, t("copy.familyName"));
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };
  // 展开字重后里面还有按钮，<button> 不能嵌套 <button>，所以根节点用 div + role
  const Item = animated ? motion.div : "div";
  /**
   * 只有「首屏几张」走进场淡入，其余不动。
   * R2 起不再做 y 位移 / 悬停上浮 / 按下缩放：这一版靠发丝线与锚点表达状态，
   * 整行飘动会让 112px 的固定网格看起来在抖。
   */
  const plainProps = animated
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        transition: { ...spring, delay: staggerDelay(index) },
      }
    : {};

  return (
    <Item
      ref={itemRef}
      role="button"
      tabIndex={0}
      className="qb-item"
      data-copied={copied ? "true" : undefined}
      data-hint-text={t("quickbar.copyHint", { name: family.name })}
      onMouseEnter={previewMarquee.enter}
      onMouseLeave={previewMarquee.leave}
      onClick={copyName}
      onKeyDown={(e) => {
        // div[role=button] 不会自己响应键盘：Enter / Space 得手动接（§5 第 31 条）。
        // 焦点在子控件（展开字重、字重行）上时那个控件负责，这里不抢。
        if (e.key !== "Enter" && e.key !== " ") return;
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        // Space 同时是主界面的「启用 / 停用」：卡片自己消费掉，别再冒泡
        e.stopPropagation();
        copyName();
      }}
      onContextMenu={(e) => openContextMenu(e, buildFamilyMenu(family))}
      {...plainProps}
    >
      {/* 行首定位锚点：静止是 6px 点，悬停长成灰线，点中 / 键盘焦点长成蓝线（三态共用起点） */}
      <span className="qb-anchor-dot" aria-hidden="true" />
      <span className="qb-anchor" aria-hidden="true" />
      <span
        className="qb-item-glyph"
        style={fontFamily ? { fontFamily, fontStyle, fontWeight: previewWeight } : undefined}
        aria-hidden="true"
      >
        Aa
      </span>

      <span className="qb-item-info">
        {/* 族名用界面字体，不跟随字体本身（与完整界面 .card-name 口径一致） */}
        <span className="qb-item-name">
          {displayName(family)}
          <span className={`qb-copied ${copied ? "is-shown" : ""}`} aria-hidden={!copied}>
            {t("copy.done")}
          </span>
        </span>
        {/* 画不出示例文字的语言时，这一行直接换成「无中文」这类标注（与完整界面一致） */}
        {hasScriptNote(scriptStatus) ? (
          <span className="qb-item-noscript">
            <ScriptChip status={scriptStatus} />
          </span>
        ) : (
          <motion.span
            ref={previewMarquee.measureRef}
            className={`qb-item-sample ${previewMarquee.open ? "marquee-open" : ""}`}
            style={
              fontFamily
                ? { fontFamily, fontStyle, fontWeight: previewWeight, fontSize: size }
                : { fontSize: size }
            }
            /**
             * 双击示例文字 = 「复制族名 + 套用到我接下来点的窗口」（1.9.10）。
             * 只挂在示例文字上而不是整行：整行双击和单击复制本来就容易误触，
             * 而且示例文字是「字体本身」，双击它再点目标窗口，语义最直白。
             * 双击前的两次 click 已经各自走过 copyName（父节点的 onClick），
             * 这里再调一次只是把「已复制」的显示时间重置，toast 会被合并成一条。
             */
            onDoubleClick={(e) => {
              e.stopPropagation();
              copyName();
              onAim(family, previewFace.id);
            }}
            initial={animated ? { opacity: 0, y: 5 } : false}
            animate={animated ? { opacity: 1, y: 0 } : undefined}
            transition={animated ? spring : undefined}
          >
            <span
              className={`marquee-roll ${previewMarquee.open ? "marquee-roll-on" : ""}`}
              style={previewMarquee.moverStyle}
            >
              {text}
            </span>
          </motion.span>
        )}
        {(hasChips || copyright) && (
          <span className="qb-item-foot">
            {hasChips && (
              <span className="qb-item-chips">
                {family.tags.map((tag) => (
                  <span key={`tag-${tag}`} className="member-chip qb-chip">
                    {tag}
                  </span>
                ))}
                {snapshotBadges.map((b) => (
                  <MemberChip key={`snap-${b.name}`} badge={b} kind="snap" className="qb-chip" />
                ))}
                {collectionBadges.map((b) => (
                  <MemberChip key={`coll-${b.name}`} badge={b} kind="coll" className="qb-chip" />
                ))}
              </span>
            )}
            {copyright && <span className="qb-item-copy">{copyright}</span>}
          </span>
        )}
      </span>

      {/* 状态列：许可 → ★ → › N，右对齐成一列，方便竖着比（其余信息一律不进这一列） */}
      <span
        className={`qb-lic ${licExpired ? "is-expired" : ""}`}
        data-hint-text={licTitle}
      >
        {t(`copyright.${licCls}` as TKey)}
      </span>

      {/* 速览里也能一键收藏 / 打一星（与卡片同一套交互，别让人非得回主界面） */}
      <StarRating
        family={family.name}
        iconSize={12}
        labels={{
          add: t("card.favorite", { name: family.name }),
          remove: t("card.unfavorite", { name: family.name }),
        }}
      />

      {scope.total > 1 && (
        <button
          data-hint="hint.qbExpand"
          type="button"
          className="qb-item-expand tabular"
          aria-expanded={expanded}
          aria-label={expanded ? t("card.collapseStyles") : t("card.expandStyles")}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          <motion.span
            className="chevron"
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={springSnappy}
          >
            <ChevronRight size={11} strokeWidth={2} />
          </motion.span>
          {scope.narrowed ? `${scope.shown}/${scope.total}` : scope.shown}
        </button>
      )}

      {/* 展开字重：与完整界面卡片同一套动作（AnimatePresence + height 0↔auto +
          opacity，springSoft；减少动效下直接给终态）。以前这里是挂载/卸载硬跳，
          同一个操作在完整界面有 0.3s 展开、在速览里却是「啪」地出现（审计 P0-1）。
          注意 `.qb-faces` 必须 overflow:hidden，否则 height 动画期间字重行会溢出行外；
          `.qb-list` 另加了 overflow-anchor:none —— 这一行是虚拟列表实测行高，
          高度动画每帧都会改 row 尺寸，不做锚定才不会把滚动位置拽走。 */}
      <AnimatePresence initial={false}>
        {expanded && visibleFaces.length > 0 && (
          <motion.div
            className="qb-faces"
            /* 字重名的大小跟着上面的示例字号走（速览面板只有卡片一半宽，取 1/8） */
            style={{ "--face-line-size": faceLineFontSize(size, 8) } as CSSProperties}
            onClick={(e) => e.stopPropagation()}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0, transition: { ...springSnappy } }}
            transition={noMotion ? { duration: 0 } : springSoft}
          >
            {visibleFaces.map((face) => (
              <QuickFaceRow
                key={face.id}
                family={family}
                face={face}
                probeText={probeText}
                onHover={setHoverFaceId}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </Item>
  );
}

export function QuickBar() {
  const t = useT();
  const win = getCurrentWindow();
  // 速览是独立窗口（独立 JS 上下文），插件清单要自己拉一份：搜插件才有东西可搜
  const loadPlugins = usePluginStore((s) => s.load);
  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);
  const fonts = useFontStore((s) => s.fonts);
  const tags = useFontStore((s) => s.tags);
  const sessionActivated = useFontStore((s) => s.sessionActivated);
  // 备注也参与搜索（与完整界面同口径），所以速览也要订阅它
  const notes = useFontStore((s) => s.notes);
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
  const ratings = useFontStore((s) => s.ratings);
  const ratingFilter = useFontStore((s) => s.ratingFilter);
  const activatedAt = useFontStore((s) => s.activatedAt);
  // 速览专属作用域筛选：收藏 / 分组 / 快照（完整界面走侧栏导航，不用这三个）
  const favoriteOnly = useFontStore((s) => s.favoriteOnly);
  const collectionFilter = useFontStore((s) => s.collectionFilter);
  const snapshotFilter = useFontStore((s) => s.snapshotFilter);
  const favorites = useFontStore((s) => s.favorites);
  const collections = useFontStore((s) => s.collections);
  const collectionFaces = useFontStore((s) => s.collectionFaces);
  const snapshots = useFontStore((s) => s.snapshots);
  const sampleText = useFontStore((s) => s.sampleText);
  const setSampleText = useFontStore((s) => s.setSampleText);
  const sizeIndex = useFontStore((s) => s.sizeIndex);
  const setSizeIndex = useFontStore((s) => s.setSizeIndex);
  // 速览 ↔ 完整界面切换期间把内容钉在目标尺寸上，窗口形变时内容不重排
  const morph = useFontStore((s) => s.morph);
  const [query, setQuery] = useState("");
  /** 搜索框是否聚焦：决定下拉建议要不要显示 */
  const [queryFocus, setQueryFocus] = useState(false);
  /**
   * 当前点中 / 聚焦的那一行（只影响视觉：行首锚点从 6px 灰点长成 96px 蓝线）。
   * 不参与任何筛选与数据，换搜索词或换列表时清掉，避免蓝线停在无关的行上。
   */

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
  /** 折叠提示条：文案拆成「状态 / 操作」两端，热键拆成键帽（见 splitDockHint） */
  const dockText = splitDockHint(t("quickbar.collapsedHint"));
  /** 键帽 ≤2 枚才画，超过就退回纯文本（清单 B2） */
  const dockHotkey = dockKeysFor(hotkeyLabel);
  // 自实现拖动：绕开系统标题栏拖动带来的「拖到顶部就最大化」
  const dragWindow = useWindowDrag();
  // 进入速览的那一下窗口正在形变，列表不要再做逐个入场的动作
  const intro = useIntro();

  /**
   * 「点一下要应用到的窗口」待命状态（1.9.10）。
   *
   * 数据流：双击示例文字 → 复制族名 + `ipc.aimArm(id)`（后端起一个 80ms 轮询线程，
   * 盯着前台窗口）→ 用户点下一个窗口 → 后端解析出 exe → 发 `aim-target` 事件 →
   * 这里按 id 核对是不是当前这一轮 → 是 PS/AI/CDR 就交给 `applyFaceInApp` 复用现有套用引擎。
   *
   * 为什么 id 放在 ref 里而不是 state：事件回调是闭包，state 会读到旧值；
   * 而 id 只在「发起」和「核对」两处用，不参与渲染。
   */
  const aimRef = useRef<{ id: string; family: Family; faceId: string } | null>(null);
  /** 待命中的族名（null = 没在待命）。只用于提示文案的无障碍标签 */
  const [aiming, setAiming] = useState<string | null>(null);

  /** 取消待命：清前端状态 + 告诉后端别等了。message 有值就顺手给一条提示 */
  const cancelAim = useCallback((message?: string) => {
    const wasArmed = aimRef.current !== null;
    aimRef.current = null;
    setAiming(null);
    void ipc.aimCancel().catch(() => {});
    if (wasArmed && message) toast.info(message);
  }, []);

  const startAim = useCallback((family: Family, faceId: string) => {
    // id 只需要「同一毫秒内点两次也不会撞」，不用 UUID
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    aimRef.current = { id, family, faceId };
    setAiming(family.name);
    // 命令失败（后端没起来 / 版本不匹配）时别让界面卡在「待命」里出不来
    void ipc.aimArm(id).catch(() => {
      aimRef.current = null;
      setAiming(null);
    });
  }, []);

  /**
   * 接收后端的一次性结果。`id` 对不上就丢弃 —— 用户连点两次双击时，
   * 上一轮的线程可能刚好还在飞（它下一拍才会发现自己被顶掉了）。
   */
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<AimResult>("aim-target", (e) => {
      const cur = aimRef.current;
      const payload = e.payload;
      if (!cur || !payload || payload.id !== cur.id) return;
      aimRef.current = null;
      setAiming(null);
      if (payload.app) {
        // 复用现有套用引擎：启用检查、CJK 提醒、9 种 outcome 的中文提示都在里面
        void useFontStore.getState().applyFaceInApp(cur.family.name, cur.faceId, payload.app);
        return;
      }
      if (payload.reason === "timeout") toast.info(t("aim.timeout"));
      else toast.info(t("aim.notTarget"), payload.exe || undefined);
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [t]);

  // 待命中按 Esc = 取消套用。必须挂在**捕获阶段**：下面那个「Esc 退出速览」的监听
  // 也在 window 上，捕获阶段先跑完再 stopPropagation，事件就走不到冒泡阶段，
  // 用户按 Esc 想取消套用却把整个速览关掉这种事不会发生。
  useEffect(() => {
    if (!aiming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      cancelAim(t("aim.cancelled"));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [aiming, cancelAim, t]);

  // 离开速览（切回完整界面 / 关窗口）时把待命收掉：否则后端会白等 15 秒
  useEffect(() => () => void ipc.aimCancel().catch(() => {}), []);

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
      [...familiesFor(fonts, tags).values()].filter((f) =>
        isEnabledNow(f, sessionActivated),
      ).length,
    [fonts, tags, sessionActivated],
  );

  const families = useMemo(() => {
    // 判定与 SearchSuggest 的 onlyActive 共用一个口径（lib/familyState.ts::isEnabledNow），
    // 否则「建议里搜得到、列表里没有」的老问题会在两处各写一遍后再次分叉。
    const enabled = [...familiesFor(fonts, tags).values()].filter((f) =>
      isEnabledNow(f, sessionActivated),
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
      ratingFilter,
      ratings,
    });
    // 收藏 / 分组 / 快照：口径与侧栏导航**完全一致**（分组取「字族级 ∪ 字重级」并集，
    // 快照用可移植标识解析成当前机器的字面 id，不能按路径比 —— TTC 一个文件多个族）。
    let scoped = filtered;
    if (favoriteOnly) {
      const fav = new Set(favorites);
      scoped = scoped.filter((f) => fav.has(f.name));
    }
    if (collectionFilter.length > 0) {
      const memberNames = new Set<string>();
      const memberFaces = new Set<string>();
      for (const g of collectionFilter) {
        for (const n of collections[g] ?? []) memberNames.add(n);
        for (const k of collectionFaces[g] ?? []) memberFaces.add(k);
      }
      scoped = scoped.filter(
        (f) =>
          memberNames.has(f.name) ||
          (memberFaces.size > 0 && f.faces.some((fc) => memberFaces.has(faceKey(fc)))),
      );
    }
    if (snapshotFilter.length > 0) {
      const index = buildFaceIndexCached(fonts);
      const ids = new Set<string>();
      for (const snap of snapshots) {
        if (!snapshotFilter.includes(snap.name)) continue;
        for (const id of entryFaceIds(snap.entries, index)) ids.add(id);
      }
      scoped = scoped.filter((f) => f.faces.some((fc) => ids.has(fc.id)));
    }
    /**
     * 搜索与完整界面走**同一条匹配链**（`lib/familySearch.ts`）：族名、标签、格式、
     * 厂商、备注、授权，以及每个字面的样式 / PostScript / 文件名 / **所有语言的本地化名**。
     * 以前这里只比 `f.name`，于是「名称列写着微软雅黑，搜微软雅黑却一条都不出」
     * （用户 2026-11-11：中文 / 拉丁 / 其他语言的名字都应该能搜到）。
     */
    const tokens = searchTokens(query);
    const labels = tokens.length > 0 ? searchLabelMaps() : null;
    const hit =
      labels === null
        ? scoped
        : scoped.filter((f) =>
            familyMatches(searchableFamily(f, notes[f.name] ?? null), tokens, labels),
          );
    return sortFamilies(hit, sort, activatedAt);
  }, [
    fonts, tags, sessionActivated, notes, query, sort,
    classFilter, scriptFilter, formatFilter, featureFilter, sourceFilter,
    charFilter, charMatches, variableOnly, toggleableOnly, licenseFilter, copyrightStatus,
    ratings, ratingFilter, activatedAt,
    favoriteOnly, collectionFilter, snapshotFilter, favorites, collections, collectionFaces, snapshots,
  ]);

  /**
   * 速览列表虚拟化。
   *
   * 以前这里是 `families.map(...)` —— 字体库 4211 个族就是 **4211 个 QuickItem 全部挂载**：
   * 每个组件有 6 个 store 订阅、十几个 DOM 节点，只靠 CSS `content-visibility` 跳过绘制。
   * 现在只渲染视口 + 上下各 4 条，DOM、React 组件、字体加载都跟着视口走。
   * 行高基准 112px（设计 R2 的固定网格）；展开字重、带胶囊的行更高，
   * 仍用 measureElement 实测，滚动条不会跳。
   */
  const bodyRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: families.length,
    getScrollElement: () => bodyRef.current,
    /**
     * 估高要跟着字号档走（清单 C3）。
     * 行的视觉重心是那串预览大字（`line-height:1.15`），其余部件高度基本固定：
     * 32px 档实测整行 112；96px 档预览块把行撑到约 120。所以估高取
     * `max(112, 预览字高 × 1.15 + 8)` —— 32/48/64 档都落在 112，96 档给到 ≈118。
     * 这只是估高：滚动位置的最终值由 measureElement 实测覆盖，估偏只影响滑块长度。
     */
    estimateSize: () => Math.max(112, Math.round(SIZES[sizeIndex] * 1.15) + 8),
    overscan: QB_OVERSCAN,
    getItemKey: (i) => families[i].name,
  });

  // 右键菜单「打字即搜」选中已启用字体后（ContextMenu 派发）：速览不跳界面，
  // 列表滚动到该族（用户 2026-11-05 口径）。未启用字体不走这里——菜单直接退回完整界面。
  useEffect(() => {
    const onPick = (e: Event) => {
      const family = (e as CustomEvent<{ family: string }>).detail.family;
      const idx = families.findIndex((f) => f.name === family);
      if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "center" });
    };
    window.addEventListener("zfm-quickbar-search", onPick);
    return () => window.removeEventListener("zfm-quickbar-search", onPick);
  }, [families, virtualizer]);

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
      // 空搜索框也要能退出：以前这里是 `if (inField) return;`，而 Alt+` 唤出速览后
      // 焦点默认就落在搜索框里（且此时搜索框是空的）—— 结果是按 Esc 什么都发生不了，
      // 用户被关在速览里出不来（0.9.9-1 实测确认）。
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
      /**
       * 待命中在面板里点任何东西 = 放弃这次套用（用户点的是我们自己的界面，
       * 不是「要应用到的窗口」）。用捕获阶段是为了先收状态、再让被点的那个控件
       * 照常干活 —— 用户点的是「关闭」「筛选」这类按钮，不该因为取消套用而失效。
       * 双击本身不会误触发：两次 pointerdown 都发生在 `aiming` 置位之前。
       */
      onPointerDownCapture={
        aiming ? () => cancelAim(t("aim.cancelled")) : undefined
      }
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
        data-hint-text={docked ? dockHint : undefined}
      >
        <span className="qb-grip-bar" />
      </div>

      {docked ? (
        <div
          className="qb-dockbar"
          role="button"
          tabIndex={0}
          onPointerDown={dragWindow}
          data-hint-text={dockHint}
          /* 视觉上把「·」换成了留白，但读屏不能跟着丢标点（清单 B1）：
             这里给它整句原文，屏幕阅读器读到的是完整的一句话。 */
          aria-label={t("quickbar.collapsedHint", { hotkey: hotkeyLabel })}
          onKeyDown={(e) => {
            // 收起态这条也是「入口」：键盘用户必须能把它叫出来（§5 第 31 条）
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            e.stopPropagation();
            void expandQuickbarPanel();
          }}
        >
          <span className="qb-dock-label">
            <span className="qb-dock-state">{dockText.state}</span>
            {/* 操作引导只在有内容时才建节点：万一某个语言包没写分隔符，
                也不该多出一个空的右侧列把布局撑歪 */}
            {(dockText.lead || dockText.tail) && (
              <span className="qb-dock-action">
                {dockText.lead && <span className="qb-dock-lead">{dockText.lead}</span>}
                {/* 键帽 ≤2 枚才画；Ctrl+Shift+F1 这种长组合退回纯文本（清单 B2） */}
                {dockHotkey.plain ? (
                  <span className="qb-dock-hotkey">{dockHotkey.plain}</span>
                ) : (
                  dockHotkey.keys.map((k, i) => (
                    <Fragment key={`${k}-${i}`}>
                      {i > 0 && <span className="qb-kbd-plus">+</span>}
                      <kbd className="qb-kbd">{k}</kbd>
                    </Fragment>
                  ))
                )}
                {dockText.tail && <span className="qb-dock-tail">{dockText.tail}</span>}
              </span>
            )}
          </span>
        </div>
      ) : (
        <div className="qb-content">
          {/**
           * 顶栏三段（设计 R2 §4.5）：0–56 范围/搜索/窗口动作 · 56–96 预览文字与字号 ·
           * 96–120 元信息。所有横向坐标由 .qb-pad（24）与固定列宽算出，窗口变宽时
           * 只有搜索框与预览文字的中间段伸缩，右侧状态列不动。
           */}
          <header className="qb-head" onPointerDown={dragWindow}>
            <div className="qb-bar qb-bar-1">
              <span className="qb-title">{t("quickbar.title")}</span>
              <span className="qb-count tabular">{enabledCount}</span>

              <div className="qb-search">
                <Search size={13} strokeWidth={1.5} className="field-icon" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onFocus={() => setQueryFocus(true)}
                  /* 与完整界面同一套（2026-11-12）：到点先看焦点在不在建议下拉里 ——
                     Tab 到建议项时不能关，否则键盘用户按不到 Enter */
                  onBlur={() =>
                    window.setTimeout(() => {
                      const active = document.activeElement;
                      if (active?.closest?.(".suggest-list")) return;
                      setQueryFocus(false);
                    }, 120)
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setQueryFocus(false);
                  }}
                  placeholder={t("quickbar.search")}
                  aria-label={t("quickbar.search")}
                  spellCheck={false}
                />
                {/* 搜索建议（用户 2026-11-10）：与完整界面同一套，每类带自己的图标。
                    外层 AnimatePresence 是给它 0.13s 的出场动画兜底的（审计 P1-9）——
                    组件自身是条件挂载的，自己包一层收不到卸载。 */}
                <AnimatePresence>
                  {queryFocus && query.trim().length > 0 && (
                    <SearchSuggest
                      key="suggest"
                      query={query}
                      onlyActive
                      /* 焦点从下拉里 Tab 走时收尾（输入框那侧为「焦点进下拉」放过了一次） */
                      onDismiss={() => setQueryFocus(false)}
                      onPick={(sg: Suggestion) => {
                        // 插件（1.8.1）：直接把它的设置面板弹出来，速览这边收起建议即可
                        if (sg.kind === "plugin") {
                          if (sg.plugin) void openPluginSettings(sg.plugin);
                          setQuery("");
                          setQueryFocus(false);
                          return;
                        }
                        // 速览里就是把关键词填成选中的名字：标签名本身也在搜索口径里，
                        // 填进去等于「只看这个标签 / 分组 / 快照」
                        setQuery(sg.label);
                        setQueryFocus(false);
                      }}
                    />
                  )}
                </AnimatePresence>
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
                  data-hint="hint.qbAutoHide"
                  className={`qb-btn ${autoHide ? "qb-btn-on" : ""}`}
                  aria-pressed={autoHide}
                  aria-label={t("quickbar.autoHide")}
                  onClick={() => setAutoHide(!autoHide)}
                >
                  {autoHide ? <Pin size={13} strokeWidth={1.5} /> : <PinOff size={13} strokeWidth={1.5} />}
                </button>
                <button
                  data-hint="hint.backFull"
                  className="qb-btn qb-btn-text"
                  aria-label={t("quickbar.back")}
                  onClick={() => void setQuickbar(false)}
                >
                  {t("quickbar.backShort")}
                </button>
                <button
                  data-hint="hint.minimize"
                  className="qb-btn"
                  aria-label={t("titlebar.minimize")}
                  onClick={() => {
                    // 贴在屏幕顶边时由 dock 接管：内容先卷走、再真最小化，且不播系统飞行动画
                    void minimizeQuickbar()
                      .then((handled) => {
                        if (!handled) void win.minimize();
                      })
                      // 接管失败（几何读不到 / 锁被别人拿着）就退回普通最小化，
                      // 不能留一个 unhandled rejection 让按钮看起来「点了没反应」（§5 第 16 条）
                      .catch(() => {
                        void win.minimize();
                      });
                  }}
                >
                  <Minimize2 size={12} strokeWidth={1.6} />
                </button>
                <button
                  data-hint="hint.close"
                  className="qb-btn qb-btn-close"
                  aria-label={t("titlebar.close")}
                  onClick={() => void win.close()}
                >
                  <X size={13} strokeWidth={1.6} />
                </button>
              </div>
            </div>

            <div className="qb-bar qb-bar-2">
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
              <span className="qb-a qb-a-sm" aria-hidden="true">
                A
              </span>
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
              </div>
              <span className="qb-a qb-a-lg" aria-hidden="true">
                A
              </span>
              <span className="qb-size-value tabular">{SIZES[sizeIndex]}px</span>
              <FilterMenu membership />
            </div>

            {/* 元信息行。待命时整行换成一条提示 —— 不新增布局行，窗口高度不变，
                速览窗口是用户拖好位置常驻的，多一行会把它顶歪。 */}
            <div className="qb-meta" data-aim={aiming ? "true" : undefined}>
              {aiming ? (
                <span
                  className="qb-aim"
                  role="status"
                  aria-live="polite"
                  aria-label={`${aiming} — ${t("aim.hint")}`}
                >
                  <span className="qb-aim-dot" aria-hidden="true" />
                  {t("aim.hint")}
                </span>
              ) : (
                <>
                  <span className="qb-meta-l tabular">
                    {families.length} / {enabledCount}
                    <span className="qb-meta-sep" aria-hidden="true">
                      ·
                    </span>
                    {t(`sort.${sort}` as TKey)}
                  </span>
                  <span className="qb-meta-r tabular">
                    {SIZES[0]}–{SIZES[SIZES.length - 1]} PX
                  </span>
                </>
              )}
            </div>
          </header>

          {/* 滚动容器是 .qb-body（overflow-y:auto）；.qb-list 只是 flex 列，
              事件挂在它身上收不到 scroll —— 0.9.9-23 第一次接就踩了这个坑 */}
          <div className="qb-body" ref={bodyRef}>
            {families.length === 0 ? (
              <p className="qb-empty">
                <span>{enabledCount > 0 ? t("empty.search.title") : t("quickbar.empty")}</span>
                {enabledCount > 0 && query.trim() && (
                  <button className="qb-empty-clear" onClick={() => setQuery("")}>
                    {t("top.searchClear")}
                  </button>
                )}
              </p>
            ) : (
              <div
                className="qb-list"
                style={{ height: virtualizer.getTotalSize() }}
              >
                {virtualizer.getVirtualItems().map((row) => {
                  const family = families[row.index];
                  if (!family) return null;
                  return (
                    <div
                      key={row.key}
                      data-index={row.index}
                      ref={virtualizer.measureElement}
                      className="qb-row"
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${row.start}px)`,
                      }}
                    >
                      <QuickItem family={family} index={row.index} onAim={startAim} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <LoadProgress compact />
          <ApplyProgress compact />
          <WarmFooter compact />
        </div>
      )}
      </div>
    </motion.div>
  );
}
