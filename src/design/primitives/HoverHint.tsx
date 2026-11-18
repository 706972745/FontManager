import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { overlayOpen } from "../../lib/overlayRegistry";
import { t, type TKey } from "../../lib/i18n";
import { useFontStore } from "../../state/fontStore";
import { isContextMenuOpen } from "./ContextMenu";
import { hintDelay } from "../../lib/hintTiming";

/**
 * 按钮悬停 1 秒后出现的用途说明。
 *
 * 全项目有一百多个按钮，逐个包一层 Tooltip 组件既啰嗦又会破坏 motion 的布局动画，
 * 所以这里走**事件委托**：只要元素带 `data-hint="i18n.key"`，悬停就由这个 Host 统一
 * 接管。要给按钮加说明只需一行属性，不改结构、不动样式。
 *
 * 为什么不用原生 `title`：延迟由系统决定（约 0.5~1.5 秒不等）、样式不可控、且
 * 会和已有的 48 处 `title` 叠成两个气泡。
 *
 * 为什么不用 `aria-label` 自动生成：有些 aria 极短（「设置」「关闭」），拿来做
 * 「这个按钮有什么用」不合格；显式 `data-hint` 才能为两种用途分别措辞。
 */

/**
 * 等待时长见 `lib/hintTiming.ts`：首次 1 秒（确认「不是路过」），
 * 刚看完一条之后的 2 秒内只等 120ms（skip delay，业界的默认做法）。
 * 原来只有一个恒定的 1 秒，在工具栏上挨个认按钮要十几秒。
 */

/** 与按钮的间距（逻辑像素） */
const GAP = 8;
/** 距屏幕/窗口边缘的最小留白 */
const EDGE = 8;

interface Shown {
  text: string;
  /** 锚点按钮的位置快照：延迟 1 秒后按钮可能已经动了，用触发那一刻的矩形更稳 */
  rect: { left: number; top: number; width: number; height: number };
}

/**
 * 这些「临时浮层」开着时不该再弹说明：气泡会被浮层盖住，而且悬停通常意味着
 * 用户正在用那层界面。
 *
 * 注意**不要把设置 / 对比 / 在线详情算进来** —— 那几层里也有大量按钮，
 * 用户正是靠悬停来认识它们。
 */
/**
 * 焦点是不是在「正在打字」的控件里。
 *
 * 输入框也挂了 data-hint（搜什么、预览文字、字号），但用户正在框里打字时再弹气泡
 * 会直接压住输入内容 —— 所以焦点在里面时不弹。滑条 / 勾选框不算「打字」，
 * 它们获得焦点后照样该能看到说明。
 */
const HINT_SELECTOR = "[data-hint],[data-hint-text]";

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  if (el instanceof HTMLInputElement) {
    return el.type !== "range" && el.type !== "checkbox" && el.type !== "radio";
  }
  return false;
}

function suppressed(): boolean {
  const s = useFontStore.getState();
  return (
    s.paletteOpen ||
    s.tourStep != null ||
    s.bulkTagFor != null ||
    s.duplicateReport != null ||
    isContextMenuOpen() ||
    overlayOpen()
  );
}

function HintBubble({ shown }: { shown: Shown }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const { rect } = shown;
    // 优先放按钮上方，但要求上方还剩得下「气泡 + 一点呼吸」；顶部工具栏的按钮
    // 上方就是标题栏，贴着放会压住标题栏，那种情况一律翻到下方。
    const above = rect.top - GAP - h;
    const top =
      above >= EDGE + 24
        ? above
        : Math.min(rect.top + rect.height + GAP, window.innerHeight - h - EDGE);
    const left = Math.min(
      Math.max(EDGE, rect.left + rect.width / 2 - w / 2),
      Math.max(EDGE, window.innerWidth - w - EDGE),
    );
    setPos({ left, top });
  }, [shown]);

  return (
    <motion.div
      ref={ref}
      className="hover-hint glass-e3"
      // 量到尺寸之前先放到屏幕外，避免第一帧闪在左上角
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      initial={{ opacity: 0 }}
      animate={{ opacity: pos ? 1 : 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.14 }}
      role="tooltip"
    >
      {shown.text}
    </motion.div>
  );
}

export function HoverHintHost() {
  const [shown, setShown] = useState<Shown | null>(null);
  // 用 ref 同步一份：事件回调里要立刻判断「已经显示了没」，state 读到的会是旧值
  const shownRef = useRef<Shown | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    let pending: HTMLElement | null = null;
    let shownEl: HTMLElement | null = null;
    /**
     * 上一条气泡是「指针移走」关掉的时刻。
     * 只有这种关法才算「用户正在挨个看按钮」；滚动 / 按键 / 失焦关掉的不算
     * —— 那时候用户已经不在看提示了，下一次该老老实实等满 1 秒。
     */
    let lastClosedAt: number | null = null;

    const cancelTimer = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      pending = null;
    };

    /** warm=true：这条是「指针移走」关的，可以给下一条走快速通道 */
    const close = (warm: boolean) => {
      cancelTimer();
      if (!shownRef.current) return; // 没显示就不 setState，避免划过时狂重渲染
      shownEl = null;
      shownRef.current = null;
      setShown(null);
      if (warm) lastClosedAt = Date.now();
    };
    /** 无参版：直接给 pointerdown / keydown / scroll / blur 当监听器用
     *  （带布尔的版本会被事件对象当成 true，一滚动就误判成「在挨个看」） */
    const hide = () => close(false);

    const fire = () => {
      timer = undefined;
      const el = pending;
      pending = null;
      if (!el || !el.isConnected) return;
      if (suppressed()) return;
      // 悬停的正是用户正在输入的那个框：别弹，会挡住正在敲的字
      if (el === document.activeElement && isTypingTarget(el)) return;
      // data-hint 是 i18n 键；data-hint-text 是**已经拼好的动态文案**（例：胶囊里塞了哪几个字重）
      const key = el.getAttribute("data-hint");
      const literal = el.getAttribute("data-hint-text");
      if (!key && !literal) return;
      const r = el.getBoundingClientRect();
      const next: Shown = {
        text: literal ?? t(key as TKey),
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      };
      shownEl = el;
      shownRef.current = next;
      setShown(next);
    };

    const onOver = (e: PointerEvent) => {
      // 触屏 / 触控笔没有"悬停"概念，弹出来反而挡视线
      if (e.pointerType && e.pointerType !== "mouse") return;
      const el = (e.target as Element | null)?.closest?.(HINT_SELECTOR) as HTMLElement | null;

      // 在同一个按钮内部（图标 → 文字）移动：不算离开，也不重新计时
      const from = e.relatedTarget as Element | null;
      if (el && from && el.contains(from)) return;

      if (!el) {
        hide();
        return;
      }
      if (el === shownEl || el === pending) return;
      cancelTimer();
      if (shownRef.current) {
        // 从「正在显示的那个按钮」直接挪到另一个按钮：这就是最典型的挨个看，
        // 记下时刻，让下一个走快速通道（否则又要等满 1 秒）
        shownEl = null;
        shownRef.current = null;
        setShown(null);
        lastClosedAt = Date.now();
      }
      pending = el;
      timer = window.setTimeout(fire, hintDelay(lastClosedAt, Date.now()));
    };

    const onOut = (e: PointerEvent) => {
      const to = e.relatedTarget as Element | null;
      const keep =
        to &&
        ((pending && to.closest?.(HINT_SELECTOR) === pending) ||
          (shownEl && to.closest?.(HINT_SELECTOR) === shownEl));
      if (keep) return;
      // 指针移走关掉的：算「刚看完一条」，下一条可以快
      close(true);
    };

    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerout", onOut, true);
    // 以下任意一种情况都说明"用户已经不是在看这个按钮了"
    window.addEventListener("pointerdown", hide, true); // 点击 / 开始拖动
    window.addEventListener("keydown", hide, true); // 键盘操作（含 Tab）
    window.addEventListener("scroll", hide, true); // 列表滚动
    window.addEventListener("blur", hide); // 窗口失焦
    document.addEventListener("pointerleave", hide);

    return () => {
      cancelTimer();
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerout", onOut, true);
      window.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("keydown", hide, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
      document.removeEventListener("pointerleave", hide);
    };
  }, []);

  /**
   * `AnimatePresence` 必须有：`HintBubble` 里的 `exit` 靠它才会被执行。
   * 少了这一层，气泡是「啪」地消失（全项目唯一没有退出动画的浮层，审计 P0-4）。
   * 退出期间 AnimatePresence 会保留最后一次的 `shown` 快照，
   * 所以 `pos` 不会被重置成 -9999，气泡不会在消失途中闪到左上角。
   */
  return (
    <AnimatePresence>
      {shown && <HintBubble key="hover-hint" shown={shown} />}
    </AnimatePresence>
  );
}
