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
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { openContextMenu } from "../design/primitives/ContextMenu";
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
import { familyCopyrightClass, normalizeCopyright } from "../lib/license";
import { isEnabledNow } from "../lib/familyState";
import { familyMatches, searchTokens } from "../lib/familySearch";
import { useFamilyMembership } from "../lib/membership";
import { buildFamilyMenu, copyText } from "../lib/menus";
import { subscribeContextMenuSize } from "../lib/menuMetrics";
import { expandQuickbarPanel, minimizeQuickbar, useQuickbarDock } from "../lib/useQuickbarDock";
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
 * 速览的虚拟化参数（§11.2）。`qbOverscan` 仍是实验开关（0–20），默认 4。
 *
 * **2026-11-28 起只剩一层门控。** 以前是两层串联：`overscan` 决定多挂几条 DOM，
 * `rootMargin`（IntersectionObserver）决定这些 DOM 里哪些真去加载字体，
 * 目的是「首屏几张立刻加载、其余等滚到附近再说」。
 *
 * 虚拟化接管之后，第二层成了纯开销：能挂载的行本来就只在视口 ± overscan（4×112 =
 * 448px）内，迟早要进视野；而 IO 会在每次新行挂载时回调一次 `setInView(true)`，
 * 也就是**一次额外的 React 提交** —— 滚动时一次区间变化本来已有 measure 提交，
 * 这是第三次。去掉后「挂载即加载」，加载范围不变（仍是 448px 内），少一次提交。
 *
 * 注意这**不是**「滚动中不加载」：那种为了省 IPC 让预览格空着的做法在 0.9.9-24
 * 回归过一次（`fontLoader.ts` 顶部有记录）。这里只是把「什么时候加载」的判定
 * 完全交给虚拟列表的挂载决策，加载行为本身没有变保守。
 */
const QB_OVERSCAN = experiment.quickbarOverscan();
/**
 * 滚动停止多久算「静止」（毫秒）。滚动期间 `.qb-body` 带 `data-scrolling="true"`，
 * CSS 靠它压掉 `.qb-item` 的 180ms hover 背景过渡；尾部静默到这个时长才摘属性，
 * 让「滚动刚停就要 hover」的那一下仍然有过渡（= 与改前手感一致）。
 * 取 140：比一次滚动惯性尾部间隔（~16–50ms）长一个数量级，又短到不会让静止后的
 * 首次 hover 明显迟到（`--t-quick` 本身就是 180ms）。
 */
const QB_SCROLL_IDLE_MS = 140;
import type { FontFace } from "../lib/ipc";
import { applyToActiveApp } from "../lib/applyActive";
import { buildFaceIndexCached, entryFaceIds, faceKey } from "../lib/snapshotKey";
import { FilterMenu } from "./TopBar";
import { SearchSuggest, type Suggestion } from "./SearchSuggest";
import { BlinkCaretInput } from "../design/primitives/BlinkCaretInput";
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
  onApply,
}: {
  family: Family;
  face: FontFace;
  /** 用户输入的示例文字（空串 = 不标注） */
  probeText: string;
  onHover: (faceId: string | null) => void;
  /** 双击这一行套用这个字重（1.9.13：只有速览界面传，见 FaceLine 的同名 prop） */
  onApply?: (faceId: string) => void;
}) {
  // 和完整界面展开后的字重行是同一个组件（0.9.3-5 起两处完全一致）
  return (
    <FaceLine
      family={family}
      face={face}
      probeText={probeText}
      onHover={onHover}
      onApply={onApply}
    />
  );
}

/**
 * 一行速览条目。
 *
 * **为什么要 `memo`**（2026-11-28，滚动卡顿第二轮）：虚拟化在滚动时只换 1–2 行，
 * 但虚拟列表的区间一变，`QuickBar` 整个重渲染，`<QuickItem>` 每次都在新的 map 里
 * 重新求值 —— 13 行 × 14 个 store 订阅 + 派生计算全部白跑。`families` 是 `useMemo`
 * 的产物，纯滚动时数组身份不变、`family` 对象身份也不变，所以 `memo` 的浅比较在
 * 滚动路径上**必然命中**，只剩新挂载的 1–2 行需要跑。
 *
 * 注意：`memo` 只挡「父级重渲染」。组件内部的 store 订阅（`useFontStore`、`useIntro`、
 * `useT` 等）仍然各自生效，启停字体、改示例文字、切字号档都会照常刷新 —— 这不是
 * 「冻结渲染」，是跳过没必要的重复求值。
 */
const QuickItem = memo(function QuickItem({
  family,
  index,
}: {
  family: Family;
  index: number;
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
  /** 鼠标正悬停的字重行：卡片预览临时用它渲染，移开恢复 Regular（与完整界面一致） */
  const [hoverFaceId, setHoverFaceId] = useState<string | null>(null);
  const previewFace = family.faces.find((f) => f.id === hoverFaceId) ?? lead;
  /**
   * 速览条目同样只渲染示例文字 + `Aa`，走列表子集通道（§12）。
   *
   * **挂载即加载**（2026-11-28）：这里以前是
   * `index < ANIMATED_ITEMS || inView ? previewFace : null`，第二段靠 IntersectionObserver
   * 判定。虚拟化之后，能挂载的行本来就落在视口 ± overscan（448px）内，迟早要进视野；
   * 而 IO 的首次回调是一次 `setInView(true)` → 一次额外提交。滚动时一次区间变化本来
   * 已有 measure 提交，这一次是多余的。加载范围没变，只是判定交给虚拟列表。
   */
  const listCharSet = listChars(family, sampleText, t("preview.defaultSample"));
  const { fontFamily } = useListFontCss(previewFace, listCharSet);
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
  // 徽标带日期 + 手动覆盖优先（用户 2026-11-13），与 FamilyCard / SpecimenView 同口径
  const manualCls = normalizeCopyright(copyrightOverride ?? null);
  const purchasedText = copyrightExpiry
    ? t("copyright.purchasedWithDate", { date: copyrightExpiry })
    : t("copyright.purchasedBadge");
  const licText =
    manualCls === "paid"
      ? t("copyright.paidBadge")
      : manualCls === "timelimited"
        ? purchasedText
        : t(`copyright.${licCls}` as TKey);
  const licTitle = licExpired
    ? `${t("copyright.expiryDate")}: ${copyrightExpiry} — ${t("copyright.expired")}`
    : manualCls === "paid"
      ? t("copyright.paidBadge")
      : manualCls === "timelimited"
        ? purchasedText
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
      role="button"
      tabIndex={0}
      className="qb-item"
      data-copied={copied ? "true" : undefined}
      data-hint-text={t("quickbar.copyHint", { name: family.name })}
      onMouseEnter={previewMarquee.enter}
      onMouseLeave={previewMarquee.leave}
      onClick={copyName}
      /**
       * 双击整行 = 复制族名 + 套用到「最近在用的设计软件」（1.9.12）。
       * 双击前那两次 click 已经各自走过 copyName，这里再调一次只是把「已复制」的
       * 显示时间重置，toast 会被合并成一条 —— 用户的心智是「点一下复制、点两下连套用」。
       * 套用的字面取当前悬停字重（`previewFace`），没悬停就是 Regular。
       */
      onDoubleClick={(e) => {
        e.stopPropagation();
        copyName();
        applyToActiveApp(family.name, previewFace.id);
      }}
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
            className={`qb-item-sample ${previewMarquee.open ? "marquee-open" : ""} ${fontFamily ? "" : "is-font-pending"}`}
            style={
              fontFamily
                ? { fontFamily, fontStyle, fontWeight: previewWeight, fontSize: size }
                : { fontSize: size }
            }
            /**
             * 双击已上移到整行（1.9.12）：示例文字是行里最大的一块，但用户双击族名、
             * 双击状态列时心智是一样的，挂在整行才一致。
             */
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
        {licText}
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
                /* 速览展开的字重行同样支持双击套用（1.9.13）——
                   与整行双击同一条链路，只是把字重换成这一行的 */
                onApply={(id) => applyToActiveApp(family.name, id)}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </Item>
  );
});

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
  /**
   * 速览**不订阅**完整界面的排序（`s.sort`，1.9.12）。
   * 速览是「最近启用的在最上面」的固定口径：用户启用一款字体，多半就是马上要用它，
   * 回到速览却要按完整界面那套排序翻半天，等于白启用。订阅了反而会让「换个排序
   * 控件，速览也跟着变」，两处口径纠缠不清 —— 所以这里连 state 都不读。
   */
  // 顶栏「筛选」的条件与完整界面共用同一份状态、同一套口径
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
  //
  // **不再解构 `bar`**（2026-11-28 晚）：收起态的窗口尺寸现在只由 CSS 决定
  // （`.qb-frame[data-dock-phase="hint"|"bar"]` 的 `height:100%` / `margin:0`，
  // 见下面 `frameStyle` 的注释）。留着这个变量既不读也不用，`tsc` 的
  // `noUnusedLocals` 会直接报 TS6133 把 `pnpm build` 打断。
  // hook 的返回值本身没变，仍是 `{ docked, contentHeight, phase, bar }`。
  const { docked, contentHeight, phase } = useQuickbarDock(autoHide);

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
   * 插件要的**常驻**提示（1.9.14，`plugin:hint` 事件）。
   *
   * 为什么需要它：插件有时要让用户「现在做一件事」，比如 pick 模式的
   * 「点一下要应用到的窗口」。toast 一两秒就没了，用户低头找窗口的工夫提示已经消失，
   * 只剩一个不知道该干什么的面板。这条提示一直挂在元信息行上，到点才自己清。
   *
   * 主程序**只负责渲染**：文案、时长都由插件给，不判断是哪个插件、也不猜它想干什么。
   * `text` 为空串 = 立刻清除（插件收尾时发一条空的就行，不用再发个「取消」消息）。
   */
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<{ plugin: string; text: string; seconds: number }>("plugin:hint", (e) => {
      const payload = e.payload;
      if (!payload || typeof payload.text !== "string") return;
      window.clearTimeout(hintTimer.current);
      hintTimer.current = undefined;
      const text = payload.text.trim();
      if (!text) {
        // 空文本 = 插件收尾，立刻收起
        setHint(null);
        return;
      }
      setHint(text);
      // 新的 hint 覆盖旧的：重开计时器，不叠加
      const seconds = Number(payload.seconds) > 0 ? Number(payload.seconds) : 15;
      hintTimer.current = window.setTimeout(() => setHint(null), seconds * 1000);
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
      window.clearTimeout(hintTimer.current);
    };
  }, []);

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
    // 固定按「启用时间」排（最近启用的在最上）。口径见上面 `sort` 被删掉的注释：
    // 速览与完整界面解耦，`activatedAt` 由 `markActivated()` 在用户主动启用时写入。
    return sortFamilies(hit, "activated", activatedAt);
  }, [
    fonts, tags, sessionActivated, notes, query,
    scriptFilter, formatFilter, featureFilter, sourceFilter,
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

  /**
   * `useVirtualizer` 的 options 身份必须**稳定**，否则滚动时测量缓存逐帧失效。
   *
   * 实证：`@tanstack/virtual-core/dist/cjs/index.cjs:560-582` 的 `getMeasurementOptions`
   * 用 `[count, paddingStart, scrollMargin, getItemKey, enabled, lanes, laneAssignmentMode]`
   * 做浅比较 memo，回调体里还会 `this.pendingMin = null`。以前这里写的是内联
   * `getItemKey: (i) => families[i].name` —— 每次渲染都是新函数，于是缓存逐帧失效、
   * `pendingMin` 逐帧清空，滚动时测量值每帧从头重算。
   *
   * **收益量级要说实话**：QA 用真 virtual-core（4211 项、10 次重渲染）实测，
   * 稳定 key 命中 10/10、内联 key 重建 10/10，单次全量重建 **0.0759ms** vs memo 命中
   * **0.0030ms** —— 净收益 ≈ **0.073ms/渲染**，是 16.7ms 帧的 0.4%，**噪声级**。
   * 所以这处是「不该有的重复计算被去掉」，不是卡顿的主因，别把它当性能修复的证据。
   *
   * **哪些是真的起作用**：必需的是 `getRowKey` 的 `useCallback`（memo 依赖里只有它）。
   * `estimateSize` 与 `gap` **不在** `getMeasurementOptions` 的依赖里，所以
   * 「字号档变 → estimateSize 变 → 测量缓存失效」这个因果**不成立**：换字号档是靠
   * `measureElement` 实测（`resizeItem → itemSizeCacheVersion++`）纠正的。`estimateSize`
   * 之所以也 `useCallback`，是为了让下面的 options 对象真的稳定（本身开销可忽略）。
   * 同理 `virtualizerOptions` 的 `useMemo` 严格来说**不是必需的** ——
   * `useVirtualizerBase` 每次渲染都会 `instance.setOptions(resolvedOptions)`，options 永远是最新的；
   * 保留它只是把「这个对象不该逐帧变」写成代码，代价为零。
   */
  const estimateRowSize = useCallback(
    /**
     * 估高要跟着字号档走（清单 C3）。
     * 行的视觉重心是那串预览大字（`line-height:1.15`），其余部件高度基本固定：
     * 32px 档实测整行 112；96px 档预览块把行撑到约 120。所以估高取
     * `max(112, 预览字高 × 1.15 + 8)` —— 32/48/64 档都落在 112，96 档给到 ≈118。
     * 这只是估高：滚动位置的最终值由 measureElement 实测覆盖，估偏只影响滑块长度。
     */
    () => Math.max(112, Math.round(SIZES[sizeIndex] * 1.15) + 8),
    [sizeIndex],
  );
  /**
   * 行 key 用族名（`measureElement` 的实测缓存按它索引）。
   *
   * 越界兜底 `?? \`#${i}\`` 是**防御性加固**，不是在修一个既有崩溃 —— 说清楚可达路径，
   * 免得下次 review 要求补复现步骤：`indexFromElement`（`virtual-core:cjs:773-783`，`return -1`
   * 在 `:780`）在节点缺 `data-index` 时返回 **-1** 并 `console.warn`；随后
   * `instance.measureElement`（`virtual-core:cjs:804-827`，无守卫的调用点在 **`:814-815`**；
   * 无 `entry` 时的另一处是 **`:144-146`**）会调 `getItemKey(-1)`，旧写法
   * `families[-1].name` 在这一步 `TypeError`。本组件恒渲染 `data-index={row.index}`，
   * 而 **ResizeObserver 那条路是安全的，理由不是「被 resizeItem 守卫挡住」**：RO 回调
   * （`:206-226`）在**求值之后**才把结果交给 `resizeItem`，而带 `entry` 时 `measureElement`
   * 直接走 `borderBoxSize` 分支（`:135-143`），**根本不会调用 `getItemKey`**。
   * 所以现实里走不到 —— 兜底的目的是「万一走到，不要整屏白」。
   * 返回值恒为 `string`，不会让 virtual-core 拿到 `undefined`。
   */
  const getRowKey = useCallback(
    (i: number): string => families[i]?.name ?? `#${i}`,
    [families],
  );
  /** 只读 ref，函数身份恒稳定 */
  const getScrollElement = useCallback(() => bodyRef.current, []);

  const virtualizerOptions = useMemo(
    () => ({
      count: families.length,
      getScrollElement,
      estimateSize: estimateRowSize,
      overscan: QB_OVERSCAN,
      getItemKey: getRowKey,
      /**
       * **关闭同步提交**（本轮卡 P0-①）。默认值 `true` 见
       * `@tanstack/react-virtual/dist/cjs/index.cjs:25`：区间一变就走
       * `ReactDOM.flushSync(rerender)`（`:91-95`），把「13 行 QuickItem 重渲染 +
       * `measureElement` 读 offsetHeight（强制同步布局）」全挤进同一帧，滚动时
       * 每帧一次**输入任务内的同步工作块**。注意：关掉它**不减少任何工作量**，
       * 只是把这批工作交回调度器（可被打断、可合并）—— 别读成「卡顿根因已消除」。
       * 改成 `false` 后重渲染回到 React 的正常调度（可被更高优先级的输入打断）。
       *
       * **代价与余量（算式用的是本仓常量，不是拍脑袋）**：
       * - `MAX_RENDER_SPEED = 1600`（`momentumScroll.ts:92`）；
       * - `followSpeedLimit = max(1600, |v|×3)`（`:162-163`），`|v|` 被 `measureVelocity`
       *   夹在 `GLIDE_MAX_VELOCITY = 6000`（`:64` / `:204`）→ 上限 **18000px/s**；
       * - `dt = clamp(Δ/1000, 0.001, 0.05)`（`:332`）、`cap = speedLimit × dt`（`:178-180`）；
       * - ⇒ **60fps 单帧上限 ≈300px**；**单帧耗时 50ms 时上限 900px**（正是要优化的那种帧）。
       * 下面 `overscan: 4` × 基准行高 112px = **448px** ⇒ 能盖 **1.49 个 16.7ms 帧**、
       * 只盖 **0.50 个 50ms 帧**。结论按条件分开写，别简化成「一定不会露白」：
       * - **常态 60fps（单帧 ≤300px）：有富余**，不会露白；
       * - **「≥3 格/帧」的连甩 + 50ms 卡帧复合出现：可能露一帧白**。
       * 取舍：长帧本身已意味着整帧崩了，而 6 行 = 672px、8 行 = 896px 也都追不上 900px；
       * 抬高默认值是让**每次提交**都多挂几行 DOM，与「不增加滚动开销」相抵，故**保持 4**。
       * ⇒「最大滚速 + 卡帧时不得露白」列为**阻塞型**手动验收项（任务卡 §6）；真机看到白边时
       * 用 `experiment.quickbarOverscan()` 的 `qbOverscan` 开关（0–20）临时调 6 复测，
       * **改默认值要另开卡**（`src/lib/experiment.ts:89` + `tests/experiment.test.ts:41` 的断言）。
       */
      useFlushSync: false,
    }),
    [families.length, getScrollElement, estimateRowSize, getRowKey],
  );
  const virtualizer = useVirtualizer(virtualizerOptions);

  /**
   * 滚动期间压掉行的 hover 背景过渡（本轮卡 P0-③）。
   *
   * 为什么需要：`.qb-item` 带 `transition: background-color var(--t-quick)`（180ms）。
   * 滚动时行从光标下连续穿过，几乎每帧都有一行「刚被悬停」→ 连续启动 180ms 背景过渡，
   * 而 `background-color` 是 paint 属性（不上合成器），等于每帧重绘一整行。
   * 过渡只在**静止**时才有观感意义，滚动中几乎看不出来，所以滚动期间直接压掉。
   *
   * 实现刻意**不走 setState**：那等于每帧一次 React 重渲染，会把 ① 的收益还回去。
   * 这里只写一个 DOM 属性（`.qb-body[data-scrolling="true"] .qb-item` 在 CSS 里压过渡），
   * 属性值没变时不重复写；尾部静默 `QB_SCROLL_IDLE_MS` 后摘掉，恢复静止态的 180ms 淡入。
   * 监听随 `docked` 重挂：收起态 `.qb-body` 不挂载，`[]` 依赖会拿到 null 并永远不再挂上。
   *
   * **为什么「绕开 React 写 DOM」在这里是安全的**：`data-scrolling` **从未出现在 JSX 里**，
   * React 只知道它自己渲染过的属性，re-render 时不会去动一个它没写过的属性 —— 所以本组件
   * 因任何原因重渲染都不会把属性摘掉。反过来，一旦把它写成 JSX 属性（哪怕是 `undefined`），
   * 每次 re-render 都会把它清掉，那时就**必须**配 state，等于每帧重渲染。
   *
   * 只压 `.qb-item` 自己那条 `background-color` 过渡。`.qb-anchor` 的 transition 列表里
   * 也有 `background-color`，但它的 hover 态与静止态**同色**（都是 `--qb-anchor-hover`，
   * 见 app.css `:7212` / `:7230`），滚动穿过时只有 transform / opacity 变化（走合成器、
   * 不重绘），所以不需要压 —— 这是「按实际会变的属性判断」，不是「它只有两条过渡」。
   */
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    let idle = 0;
    const onScroll = () => {
      if (el.dataset.scrolling !== "true") el.dataset.scrolling = "true";
      if (idle !== 0) window.clearTimeout(idle);
      idle = window.setTimeout(() => {
        idle = 0;
        delete el.dataset.scrolling;
      }, QB_SCROLL_IDLE_MS);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (idle !== 0) window.clearTimeout(idle);
      delete el.dataset.scrolling;
    };
  }, [docked]);

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

  /*
   * 窗口形变期间把 qb-frame 钉在目标尺寸；**收起态（bar）不再由 React 写 width/height**。
   *
   * 为什么删掉 bar 分支（2026-11-28 晚，用户报「展开时闪一下：全部展开 → 收起 → 再展开」）：
   * 只要 React 曾经把 `height` 写进过 style，下一次 `frameStyle` 变成 undefined 时，
   * React 的 style diff 就会把它**清成 `''`**（不是「保持不动」）。而 expand() 里
   * `setBar(null)` 触发的这次提交，落在动画已经开始之后（挂载面板 + 虚拟列表要 30~50ms，
   * 165Hz 下那已经是第 5~8 帧）：行内高度被清掉的那一瞬间，外壳回落到本文件的 CSS 兜底
   * `height: calc(100% - inset*2)`，也就是**已经撑到满高的窗口** —— 整整一帧画出完整的
   * 面板，下一帧又被 animateHeight 写回小高度。观感就是「闪一下全展开、又收起、再展开」。
   *
   * 删掉之后两个值其实一模一样：收起态窗口宽度就是 bar 宽度，高度由 CSS 的 bar 规则
   * 直接写死（见下），不是靠 `--qb-inset` 兜底算出来的；但属性不再由 React 持有，
   * 也就没人会去清它。
   * `morph` 分支必须保留：形变期间窗口 ≠ 内容，只能由 React 钉住。
   *
   * 等价性的**依据**（不是「估计差不多」，两条都在 `src/app.css`）：
   * - 收起态（`data-dock-phase` 为 `hint` / `bar`）有一条专用规则 `:6461-6477`
   *   显式写死 `margin: 0; height: 100%; max-width: none; max-height: none`
   *   —— 外壳高度就是窗口客户区高度，压根不经过 `--qb-inset` 的算式。
   *   收起落点 `to = Math.round(DOCK_HEIGHT_BAR * scale)`（`useQuickbarDock.ts:790`）
   *   物理像素，除以 scale 后 ≈ `DOCK_HEIGHT_BAR`（12）：scale = 1.25 / 1.5 时精确相等，
   *   1.3 这类会让 `12×scale` 落在 .5 上的 DPR 则会差几分之一像素 —— 而 bar 阶段整块
   *   背景是 transparent（`app.css:6439-6440`），那点差值落在透明区里，肉眼无差。
   * - 展开态基础规则 `:6290-6293` 的兜底量 `--frame-inset` 本身就是 **0px**
   *   （`:44`），所以 `calc(100% - 0px*2) === 100%`：`--qb-inset` 有没有、是不是 0
   *   都不影响结果。
   * - 宽度更是全程没人写过（只有 `max-width`），块级 flex 容器天然等于窗口宽。
   *   以前行内那个 `Math.round(widthPhys / scale)` **并不是**在每个 DPR 下都偏 ——
   *   `QUICKBAR_WIDTH = 472`（`fontStore.ts:827`）在 1.5 下是 708 → 708/1.5 = 472，
   *   精确。只有两种情形会有 ≤0.5px 的偏差：①`targetWidth` 被 `availWidth`
   *   夹住（`fontStore.ts:1001-1005`，本机 `2560/1.5 = 1706.67` 本身非整数）；
   *   ②用户手动拖过窗口宽、`restoreSize.width` 是奇数物理像素。偏差方向随机
   *   （宽了右侧被窗口裁掉、窄了右侧透一条 1px 桌面细线），新写法两种都消除。
   */
  const frameStyle: CSSProperties | undefined = morph
    ? { width: `${morph.width}px`, height: `${morph.height}px` }
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
                <BlinkCaretInput
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
                <BlinkCaretInput
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

            {/* 元信息行。插件有待命提示时整行换成那一句 —— 不新增布局行，
                窗口高度不变（速览窗口是用户拖好位置常驻的，多一行会把它顶歪）。 */}
            <div className="qb-meta" data-hint={hint ? "true" : undefined}>
              {hint ? (
                <span className="qb-aim" role="status" aria-live="polite">
                  <span className="qb-aim-dot" aria-hidden="true" />
                  {hint}
                </span>
              ) : (
                <>
                  <span className="qb-meta-l tabular">
                    {families.length} / {enabledCount}
                    <span className="qb-meta-sep" aria-hidden="true">
                      ·
                    </span>
                    {t("sort.activated")}
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
                      <QuickItem family={family} index={row.index} />
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
