import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { scrimFade, spring, springSnappy, springSoft } from "../design/springs";
import { useFontStore } from "../state/fontStore";
import { t as translate, useT, type TKey } from "../lib/i18n";
import { useModalLayer } from "../lib/modalLayer";
import {
  clearTourFailure,
  enterTourQuickbar,
  leaveTourQuickbar,
  noticeQuickbarClosed,
  useTourStage,
} from "../lib/tourQuickbar";

interface TourStep {
  /** 完整界面里的聚光靶；速览步只在「进速览失败」时才会用到它 */
  target?: string;
  /**
   * 速览窗口里的聚光靶。**有它就算「速览步」**：这一步会把窗口真的切进速览，
   * 并在速览窗口里讲（1.9.3 用户要求「讲速览就要看到速览」）。
   */
  quickbarTarget?: string;
  title: TKey;
  body: TKey;

  onEnter?: () => void;
}

const STEPS: TourStep[] = [
  {
    title: "tour.welcome.title",
    body: "tour.welcome.body",
  },
  {
    target: ".topbar-sample",
    title: "tour.sample.title",
    body: "tour.sample.body",
  },
  {
    target: ".topbar-size",
    title: "tour.size.title",
    body: "tour.size.body",
  },
  {
    target: ".topbar-search",
    title: "tour.search.title",
    body: "tour.search.body",
  },
  {
    target: '[data-tour="filters"]',
    title: "tour.scripts.title",
    body: "tour.scripts.body",
  },
  {
    target: ".view-toggle",
    title: "tour.views.title",
    body: "tour.views.body",
    onEnter: () => useFontStore.setState({ viewMode: "grid" }),
  },
  {
    target: ".family-card",
    title: "tour.card.title",
    body: "tour.card.body",
    onEnter: () => useFontStore.setState({ viewMode: "grid" }),
  },
  {
    target: ".family-card",
    title: "tour.weights.title",
    body: "tour.weights.body",
    onEnter: () => useFontStore.setState({ viewMode: "grid" }),
  },
  {
    target: ".family-card",
    title: "tour.hints.title",
    body: "tour.hints.body",
    onEnter: () => useFontStore.setState({ viewMode: "grid" }),
  },
  {
    /* 1.9.0 新增：右击菜单。还停在卡片视图（上一步设过 grid），直接指一张卡片；
       讲的是全软件共用的那套 buildFamilyMenu，搜索结果 / 列表行 / 样张同一套 */
    target: ".family-card",
    title: "tour.contextmenu.title",
    body: "tour.contextmenu.body",
    onEnter: () => useFontStore.setState({ viewMode: "grid" }),
  },
  {
    target: ".detail",
    title: "tour.inspector.title",
    body: "tour.inspector.body",
    onEnter: () => {
      const st = useFontStore.getState();
      if (!st.selectedFamily && st.visibleOrder.length > 0) {
        st.select(st.visibleOrder[0]);
      }
    },
  },
  {
    target: ".detail",
    title: "tour.resize.title",
    body: "tour.resize.body",
    onEnter: () => {
      const st = useFontStore.getState();
      if (!st.selectedFamily && st.visibleOrder.length > 0) {
        st.select(st.visibleOrder[0]);
      }
    },
  },
  {
    target: ".sidebar-heading-row",
    title: "tour.collections.title",
    body: "tour.collections.body",
    onEnter: () => useFontStore.getState().select(null),
  },
  {
    target: ".sidebar-footer",
    title: "tour.trash.title",
    body: "tour.trash.body",
  },
  {
    /* 1.9.0 新增速览界面；1.9.3 改成**真的切过去**再讲（用户 2026-11-11：
       「在导览里介绍速览界面的时候，应该真的转到速览界面去介绍」）。
       两个靶子各管一个窗口：`quickbarTarget` 是速览里真实存在的列表容器（一直存在，
       空库时里面是空态文案，所以这一步不会因为库空而失效）；`target` 是完整界面里的
       入口按钮，只在「进速览失败」时兜底用它把玩法讲完。
       进出窗口不写在 onEnter 里 —— 同一步会被两个组件实例（完整界面 / 速览）先后挂载，
       onEnter 会各跑一次；收敛到 lib/tourQuickbar 的相位机才不会重入（见那里的注释）。 */
    target: '[data-tour="quickbar"]',
    quickbarTarget: ".qb-body",
    title: "tour.quickbar.title",
    body: "tour.quickbar.body",
  },
  {
    /* 1.9.0 新增：插件安装。设置面板是另一层模态，导览期间不打开它，
       指着设置齿轮讲「进去之后去哪儿装」即可 */
    target: '[data-tour="settings"]',
    title: "tour.plugins.title",
    body: "tour.plugins.body",
  },
  {
    target: '[data-tour="settings"]',
    title: "tour.settings.title",
    body: "tour.settings.body",
  },
  {
    title: "tour.last.title",
    body: "tour.last.body",
  },
];

function useTargetRect(selector: string | undefined, step: number) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  // 目标元素压根不存在（空字库 / 筛选后 / 该面板没打开）：调用方据此跳过这一步，
  // 而不是把卡片摆在屏幕中间对着一片空气讲（§5 第 29 条）。
  const [missing, setMissing] = useState(false);

  useLayoutEffect(() => {
    if (!selector) {
      setRect(null);
      setMissing(false);
      return;
    }
    setMissing(false);
    let tries = 0;
    let raf = 0;
    const find = () => {
      const el = document.querySelector(selector);
      if (el) {
        el.scrollIntoView({ block: "nearest" });
        setRect(el.getBoundingClientRect());
      } else if (tries++ < 40) {
        raf = requestAnimationFrame(find);
      } else {
        setRect(null);
        setMissing(true);
      }
    };
    find();
    const onResize = () => {
      const el = document.querySelector(selector);
      if (el) setRect(el.getBoundingClientRect());
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [selector, step]);

  return { rect, missing };
}

const PAD = 8;
const CARD_W = 340;
const MARGIN = 12;
/**
 * 卡片真实高度量到之前用的估高（审计 P1-14 改法 B）。
 * 此时卡片是 `visibility: hidden`，这个值只影响「不可见的那一帧」摆在哪，
 * 写出来只是让 `cardPosition()` 有个数可算。
 */
const CARD_H_EST = 180;

function cardPosition(rect: DOMRect | null, cardH: number): React.CSSProperties {
  if (!rect) {
    return { left: "50%", top: "50%", translate: "-50% -50%" };
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampX = (x: number) => Math.min(Math.max(MARGIN, x), vw - CARD_W - MARGIN);
  const clampY = (y: number) => Math.min(Math.max(MARGIN, y), vh - cardH - MARGIN);

  const centeredX = clampX(rect.left + rect.width / 2 - CARD_W / 2);
  const fitsBelow = rect.bottom + PAD + MARGIN + cardH <= vh;
  const fitsAbove = rect.top - PAD - MARGIN - cardH >= 0;

  if (fitsBelow) return { left: centeredX, top: rect.bottom + PAD + MARGIN };
  if (fitsAbove) return { left: centeredX, top: rect.top - PAD - MARGIN - cardH };

  const sideY = clampY(rect.top + rect.height / 2 - cardH / 2);
  if (rect.left - PAD - MARGIN - CARD_W >= 0) {
    return { left: rect.left - PAD - MARGIN - CARD_W, top: sideY };
  }
  if (rect.right + PAD + MARGIN + CARD_W <= vw) {
    return { left: rect.right + PAD + MARGIN, top: sideY };
  }

  return { left: centeredX, top: clampY(rect.bottom + PAD + MARGIN) };
}

/**
 * 速览窗口里的卡片位置（清单 B53）。
 *
 * 速览窗口只有约 472 宽 × 992 高（`QUICKBAR_WIDTH` / `QUICKBAR_HEIGHT`），
 * 卡片 340 放得下，但摆在哪儿都会压住内容：聚光靶是整块列表（`.qb-body`，
 * 几乎占满下半屏），按通用逻辑算出来的位置只会是「贴底」或「贴边」，
 * 中途还会因为 `cardH` 的量测来一次跳变。
 * 所以速览里不用通用算法：一条死规矩压到底部内侧，上面的字体列表整片留着当实物。
 */
function quickbarCardPosition(): React.CSSProperties {
  return { left: "50%", top: "auto", bottom: MARGIN, translate: "-50% 0" };
}

export function Onboarding() {
  const t = useT();
  const phase = useFontStore((s) => s.phase);
  const onboarded = useFontStore((s) => s.onboarded);
  const tourStep = useFontStore((s) => s.tourStep);
  const startTour = useFontStore((s) => s.startTour);
  const setTourStep = useFontStore((s) => s.setTourStep);
  const endTour = useFontStore((s) => s.endTour);
  const fontsReady = useFontStore((s) => s.fonts.length > 0);
  // 速览态下 App 换渲染树，这个组件会在速览窗口里再挂一次（App.tsx 的 quickbar 分支）
  const inQuickbar = useFontStore((s) => s.quickbar);
  const stage = useTourStage();
  /**
   * 「减少动效」的口径与项目其它三处一致（FamilyCard.tsx:78-80 / DetailPanel.tsx:678-680 /
   * QuickBar 这一批新加的）：系统偏好与软件开关任一开启即算。
   * 这里非用不可的原因：`MotionConfig reducedMotion` 只压得住 transform / opacity，
   * 聚光靶的 width / height 是布局属性，压不住（审计 P1-15）。
   */
  const motionPref = useFontStore((s) => s.motionPref);
  const systemReduce = useReducedMotion();
  const noMotion = systemReduce || motionPref === "reduced";

  const step = tourStep !== null ? STEPS[tourStep] : null;
  const quickbarStep = step?.quickbarTarget != null;
  /**
   * 卡片此刻能不能画（清单 B52）：
   * - 速览窗口只画「速览步」，别的步的靶子在这儿根本不存在；
   * - 完整界面里速览步**默认不画**：这一刻窗口正在滑出屏幕，卡片会先在速览按钮上
   *   闪一下再跳到速览里的新位置（用户看到的是「聚光靶乱跳」）。宁可空场。
   *   只有「进速览失败」时才退回指着入口按钮讲，不至于把这一步漏掉。
   */
  const showCard =
    step != null && (inQuickbar ? quickbarStep : !quickbarStep || stage.failedStep === tourStep);
  /**
   * 窗口形变期间（to-quickbar / to-main）导览层整块空场：两个窗口都还没有可信几何，
   * 画出来的卡片一定错位。空场也是「过渡态」，比闪一下再跳过去好。
   */
  const morphing = stage.phase === "to-quickbar" || stage.phase === "to-main";

  const selector = showCard
    ? inQuickbar
      ? step?.quickbarTarget
      : step?.target
    : undefined;
  const { rect, missing } = useTargetRect(selector, tourStep ?? -1);
  const cardRef = useRef<HTMLDivElement>(null);
  /**
   * 卡片真实高度：null = 还没量到（审计 P1-14 改法 B「先量后画」）。
   *
   * 原来是 `useState(180)` 估高：`cardPosition()` 用 `cardH` 算纵向位置，
   * 长文案的步骤第一帧按 180 摆、第二帧按真实高度重算 —— 用户看到「先出现、再跳一下」。
   * 现在量到之前整块不显形（visibility:hidden），跳变消失。
   *
   * 为什么带 `step`：`key={tourStep}` 让卡片每步重挂载，只存一个数字的话，
   * 换步那一帧会拿上一步的高度去定位。带上 step 就自动失效成 null。
   */
  const [cardSize, setCardSize] = useState<{ step: number; h: number } | null>(null);
  const cardH = cardSize && cardSize.step === tourStep ? cardSize.h : null;
  // 导览是模态层：登记进弹层栈，上面压着别的弹层时把按键让出去（§5 第 8 / 29 条）。
  // 形变期间也要占着栈顶，否则 Esc 会漏给速览自己的监听（QuickBar.tsx:592）。
  // `quickbarStep` 单独列一项是为了补一帧的缝：从「非速览步」切到「速览步」的那一次 commit 里
  // `showCard` 已是 false、`morphing` 还没翻（相位由 effect 在 paint 之后才 publish），
  // 不带上它这一帧 isTopLayer() 会返回 false，恰好按 Esc 就漏给全局 handler。
  // ⚠️ 刻意**不**把 `cardH !== null` 加进这个条件：量高发生在 layout effect 里（paint 之前），
  //    「还没量到」活不过一帧；把它加进来反而会在换步那一帧放开栈顶，正好是上面要补的那道缝。
  const isTopLayer = useModalLayer(tourStep !== null && (showCard || morphing || quickbarStep));

  useLayoutEffect(() => {
    if (!cardRef.current || tourStep === null) return;
    const h = cardRef.current.offsetHeight;
    setCardSize((prev) => (prev && prev.step === tourStep && prev.h === h ? prev : { step: tourStep, h }));
    // showCard 也要进依赖：卡片「先不画、后来才画」的那条路径（进速览失败后退回指入口按钮）
    // 可能不伴随 tourStep / rect 变化，漏了它就会永远停在「没量到高度」的隐藏态。
  }, [tourStep, rect, showCard]);

  useEffect(() => {
    if (tourStep !== null) STEPS[tourStep]?.onEnter?.();
  }, [tourStep]);

  /**
   * 「进 / 出速览」的唯一入口：由「当前步 × 相位」推出来。
   *
   * 这里是新增 onLeave 的等价机制（而不是给 step 挂 onLeave）：同一步会被两个实例
   * 先后挂载 —— 完整界面那个把窗口切走后卸载，速览那个随即挂载。挂 onLeave 会在
   * **正常切换时**被卸载清理顺带触发，刚进去就被退出来。写成「不变式」就不会：
   * 无论哪个实例在场、无论走的是前进 / 后退 / 跳过 / Esc / 结束，只要「速览步却不在
   * 速览相位」或「不是速览步却还在速览相位」，就地把窗口切回去。
   */
  useEffect(() => {
    if (stage.failedStep !== null && stage.failedStep !== tourStep) clearTourFailure();
    if (tourStep === null) {
      if (stage.phase !== "main") void leaveTourQuickbar();
      return;
    }
    const wantQuickbar = STEPS[tourStep]?.quickbarTarget != null;
    if (wantQuickbar && stage.phase === "main" && stage.failedStep !== tourStep) {
      void enterTourQuickbar(tourStep);
    } else if (!wantQuickbar && stage.phase !== "main") {
      void leaveTourQuickbar();
    }
  }, [tourStep, stage.phase, stage.failedStep]);

  /**
   * 用户自己按了速览右上角的「完整界面」（或 Alt + `）退出来的：窗口没走导览的退出流程。
   * 这一步该讲的他已经看到了，直接把导览往下挪一步，别让卡片挂在一个没有窗口承载的相位上。
   */
  useEffect(() => {
    if (inQuickbar || stage.phase !== "quickbar") return;
    noticeQuickbarClosed();
    if (tourStep === null) return;
    if (tourStep < STEPS.length - 1) setTourStep(tourStep + 1);
    else endTour();
  }, [inQuickbar, stage.phase, tourStep, setTourStep, endTour]);

  /**
   * 速览步「点穿」的补丁（清单 B61）：只放开列表，顶栏 / 抓手条一律不给点。
   * 条件与导览层的 `.tour-layer-qb` 完全一致（`inQuickbar && quickbarStep`），
   * 不要另立一套判断 —— 两处不一致就会出现「层放开了、顶栏没挡」这种洞。
   *
   * 为什么用 body 上的类而不是给 QuickBar 传 prop：`QuickBar` 是独立窗口里的另一棵树，
   * 导览不该去改它的组件结构；一条 body 类 + 一条 CSS 就能收口，且摘除天然跟着 cleanup 走。
   * 必须放进 cleanup：漏摘一次，用户退出导览后搜索框就永久点不动了。
   */
  useEffect(() => {
    if (!(inQuickbar && quickbarStep)) return;
    document.body.classList.add("tour-qb");
    return () => document.body.classList.remove("tour-qb");
  }, [inQuickbar, quickbarStep]);

  useEffect(() => {
    if (tourStep === null || !missing) return;
    // 这一步要高亮的元素不存在（空字库 / 筛选后 / 面板没开）：跳过它，别对着空气讲（§5 第 29 条）
    if (tourStep < STEPS.length - 1) setTourStep(tourStep + 1);
    else endTour();
  }, [missing, tourStep, setTourStep, endTour]);

  useEffect(() => {
    if (tourStep === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isTopLayer()) return;
      // 导览是模态的：用 stopImmediatePropagation 才压得住同一 target 上的其他 window 监听
      // （stopPropagation 只挡住往上层传播，App 的全局快捷键照样会被触发 —— §5 第 29 条）。
      // 速览窗口里尤其要紧：QuickBar 自己也监听 Esc（QuickBar.tsx:592），
      // 放过它的话「按 Esc 退导览」会变成「先退出速览」。
      e.stopImmediatePropagation();
      if (e.key === "Tab") {
        // Tab 必须关在导览卡片里：卡片自己是 tabIndex=-1，不拦的话下一步就跑到背后被遮住的界面上
        const card = cardRef.current;
        if (!card) {
          // 形变期间卡片没画（空场）：焦点无处可去，直接吃掉这一下
          e.preventDefault();
          return;
        }
        const items = [
          ...card.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ),
        ].filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
        if (items.length === 0) {
          e.preventDefault();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const cur = document.activeElement;
        if (!e.shiftKey && (cur === last || !card.contains(cur))) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && (cur === first || !card.contains(cur))) {
          e.preventDefault();
          last.focus();
        }
        return;
      }
      if (e.key === "Escape") endTour();
      if ((e.key === "ArrowRight" || e.key === "Enter") && tourStep < STEPS.length - 1) {
        setTourStep(tourStep + 1);
      } else if ((e.key === "ArrowRight" || e.key === "Enter") && tourStep === STEPS.length - 1) {
        endTour();
      }
      if (e.key === "ArrowLeft" && tourStep > 0) setTourStep(tourStep - 1);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [tourStep, setTourStep, endTour, isTopLayer]);

  /**
   * 每一步都把焦点收进导览卡片：键盘用户按 Tab 不会跑到背后被高亮遮住的界面上
   * （卡片容器 tabIndex=-1，焦点落在它身上，再 Tab 就在卡片内部的按钮之间走）。
   *
   * ⚠️ 必须等 `cardH !== null`（审计 P1-14 改法 B 的关键风险）：卡片在量到高度之前是
   * `visibility: hidden`，对隐藏元素调 `focus()` 会被浏览器拒绝 —— 焦点掉回 body，
   * 下面的 Tab 陷阱（keydown 里判 `.tour-card`）随之失效，键盘用户直接漏到背景界面。
   */
  useEffect(() => {
    if (tourStep === null || !showCard || cardH === null) return;
    const el = cardRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
  }, [tourStep, showCard, cardH]);

  // 速览窗口里没有「首次导览邀请」这回事：那张卡是完整界面的尺寸，塞进 472 宽的窗口会变形
  const showWelcomePrompt =
    phase === "ready" && fontsReady && !onboarded && tourStep === null && !inQuickbar;
  const last = tourStep === STEPS.length - 1;
  /**
   * 卡片定位 + 「还没量到高度就先不显形」。
   * 用 visibility 而不是 opacity: 0 —— 后者保留可点区域，用户可能误点一个看不见的
   * 「下一步」按钮（审计 P1-14 明确要求）。
   */
  const cardStyle: React.CSSProperties =
    inQuickbar && quickbarStep ? quickbarCardPosition() : cardPosition(rect, cardH ?? CARD_H_EST);
  if (cardH === null) {
    cardStyle.visibility = "hidden";
    cardStyle.pointerEvents = "none";
  }

  return (
    <>

      <AnimatePresence>
        {showWelcomePrompt && (
          <motion.div
            className="tour-invite glass-e3"
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={springSoft}
            role="dialog"
            aria-label={t("tour.inviteAria")}
          >
            <img className="tour-invite-icon" src="/icon.png" alt="" draggable={false} />
            <div className="tour-invite-text">
              <div className="tour-invite-title">{t("tour.inviteTitle")}</div>
              <div className="tour-invite-sub">{t("tour.inviteSub")}</div>
            </div>
            <motion.button
              className="tour-start"
              onClick={startTour}
              whileHover={{ y: -1, transition: spring }}
              whileTap={{ scale: 0.97, transition: springSnappy }}
            >
              {t("tour.take")}
            </motion.button>
            <button className="detail-close" aria-label={t("tour.skipAria")} onClick={endTour}>
              <X size={14} strokeWidth={1.5} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {step && showCard && (
          <motion.div
            /* 速览相位给整层加修饰类，让指针穿到下面的速览（清单 B60）：这一步的文案
               请用户真的去点族名，挡着就等于让人点不动。卡片自己把指针接回来。 */
            className={inQuickbar && quickbarStep ? "tour-layer tour-layer-qb" : "tour-layer"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            /* 遮罩淡入统一 0.18s（审计 P1-5）*/
            transition={scrimFade}
          >

            <motion.div
              className="tour-spotlight"
              /* 速览里不播「聚光从左上角飞过来」：窗口落位时聚光已经在列表上，
                 进来的一瞬间就是对的（完整界面照旧带入场动画） */
              initial={inQuickbar ? false : undefined}
              animate={
                rect
                  ? {
                      x: rect.left - PAD,
                      y: rect.top - PAD,
                      width: rect.width + PAD * 2,
                      height: rect.height + PAD * 2,
                      opacity: 1,
                    }
                  : {
                      x: window.innerWidth / 2,
                      y: window.innerHeight / 2,
                      width: 0,
                      height: 0,
                      // 速览里靶子还没量到时先不画聚光：窗口一露头就在正中缩出一个洞很难看，
                      // 目标是整块列表，等量到再一次画出来（只有一两帧）
                      opacity: inQuickbar ? 0 : 1,
                    }
              }
              /* 「减少动效」下聚光必须整块瞬移（审计 P1-15）：
                 `MotionConfig reducedMotion` 压得住 x / y（transform），压不住
                 width / height（布局属性）—— 只降一半的结果是「先瞬间跳到新位置、
                 再慢慢胀到新尺寸」，比完全不降级还怪。step 换靶时也一样，
                 这里直接给终态，不做逐帧。 */
              transition={noMotion ? { duration: 0 } : spring}
            />
            <motion.div
              key={tourStep}
              ref={cardRef}
              className={inQuickbar ? "tour-card tour-card-qb glass-e3" : "tour-card glass-e3"}
              style={cardStyle}
              tabIndex={-1}
              initial={{ opacity: 0, y: 10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={springSoft}
              role="dialog"
              aria-label={translate(step.title)}
            >
              <div className="tour-card-title">{t(step.title)}</div>
              <div className="tour-card-body">{t(step.body)}</div>
              <div className="tour-card-foot">
                <div className="tour-dots" aria-hidden="true">
                  {STEPS.map((_, i) => (
                    <span key={i} className={`tour-dot ${i === tourStep ? "tour-dot-on" : ""}`} />
                  ))}
                </div>
                <div className="tour-nav">
                  <button className="tour-skip" onClick={endTour}>
                    {t("tour.skip")}
                  </button>
                  {tourStep! > 0 && (
                    <motion.button
                      className="tour-btn"
                      aria-label={t("tour.back")}
                      onClick={() => setTourStep(tourStep! - 1)}
                      whileTap={{ scale: 0.94, transition: springSnappy }}
                    >
                      <ArrowLeft size={14} strokeWidth={1.5} />
                    </motion.button>
                  )}
                  <motion.button
                    className="tour-btn tour-next"
                    onClick={() => (last ? endTour() : setTourStep(tourStep! + 1))}
                    whileHover={{ y: -1, transition: spring }}
                    whileTap={{ scale: 0.97, transition: springSnappy }}
                  >
                    {t(last ? "tour.finish" : "tour.next")}
                    {!last && <ArrowRight size={14} strokeWidth={1.5} />}
                  </motion.button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
