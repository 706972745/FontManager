import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { spring, springSoft } from "../design/springs";
import { useFontStore } from "../state/fontStore";
import { t as translate, useT, type TKey } from "../lib/i18n";
import { useModalLayer } from "../lib/modalLayer";

interface TourStep {
  target?: string;
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
    /* 1.9.0 新增：速览界面。目标是标题栏左上的速览按钮；不真的切过去 ——
       导览是模态层，窗口 morph 期间聚光靶会跟着丢，讲清楚入口和玩法就够了 */
    target: '[data-tour="quickbar"]',
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

export function Onboarding() {
  const t = useT();
  const phase = useFontStore((s) => s.phase);
  const onboarded = useFontStore((s) => s.onboarded);
  const tourStep = useFontStore((s) => s.tourStep);
  const startTour = useFontStore((s) => s.startTour);
  const setTourStep = useFontStore((s) => s.setTourStep);
  const endTour = useFontStore((s) => s.endTour);
  const fontsReady = useFontStore((s) => s.fonts.length > 0);

  const step = tourStep !== null ? STEPS[tourStep] : null;
  const { rect, missing } = useTargetRect(step?.target, tourStep ?? -1);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(180);
  // 导览是模态层：登记进弹层栈，上面压着别的弹层时把按键让出去（§5 第 8 / 29 条）
  const isTopLayer = useModalLayer(tourStep !== null);

  useLayoutEffect(() => {
    if (cardRef.current) setCardH(cardRef.current.offsetHeight);
  }, [tourStep, rect]);

  useEffect(() => {
    if (tourStep !== null) STEPS[tourStep]?.onEnter?.();
  }, [tourStep]);

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
      // （stopPropagation 只挡住往上层传播，App 的全局快捷键照样会被触发 —— §5 第 29 条）
      e.stopImmediatePropagation();
      if (e.key === "Tab") {
        // Tab 必须关在导览卡片里：卡片自己是 tabIndex=-1，不拦的话下一步就跑到背后被遮住的界面上
        const card = cardRef.current;
        if (!card) return;
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
   */
  useEffect(() => {
    if (tourStep === null) return;
    const el = cardRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
  }, [tourStep]);

  const showWelcomePrompt = phase === "ready" && fontsReady && !onboarded && tourStep === null;
  const last = tourStep === STEPS.length - 1;

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
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.97 }}
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
        {step && (
          <motion.div
            className="tour-layer"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >

            <motion.div
              className="tour-spotlight"
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
                      opacity: 1,
                    }
              }
              transition={spring}
            />
            <motion.div
              key={tourStep}
              ref={cardRef}
              className="tour-card glass-e3"
              style={cardPosition(rect, cardH)}
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
                      whileTap={{ scale: 0.95 }}
                    >
                      <ArrowLeft size={14} strokeWidth={1.5} />
                    </motion.button>
                  )}
                  <motion.button
                    className="tour-btn tour-next"
                    onClick={() => (last ? endTour() : setTourStep(tourStep! + 1))}
                    whileHover={{ y: -1 }}
                    whileTap={{ scale: 0.97 }}
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
