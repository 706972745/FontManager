import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

/**
 * 悬停跑马灯（2026-11-05，用户要求）：预览文本比容器宽时，悬停卡片让文字
 * 缓慢向左滑出被截断的结尾；移开快速回滚（向右）到原位。
 *
 * 用法：
 *   const mq = useMarquee(size);
 *   <div onMouseEnter={mq.enter} onMouseLeave={mq.leave}>          ← 卡片根
 *     <p ref={mq.measureRef} className={mq.open ? "marquee-open" : ""}>
 *       <span className="marquee-roll ..." style={mq.moverStyle}>  ← 位移在这层
 *         {text}
 *       </span>
 *     </p>
 *
 * - measureRef 放在「负责裁剪的外层」上：量 scrollWidth - clientWidth。
 *   左对齐文本这个差值就是完整溢出量；居中文本（scrollWidth 只算右侧溢出）
 *   正好等于右侧被截的宽度 —— 两种排版都能一次滑到结尾完整露出；
 * - 位移放在内层 .marquee-roll 上，不碰外层的 framer-motion 动画
 *   （motion.p 的 y 动画由 framer 管 transform，外层再写 style.transform 会互抢）；
 * - 展开期间外层加 .marquee-open（text-overflow: clip），省略号不会压在滑出来的文字上；
 * - 速度随字号调制（用户 2026-11-05：「字体越大，速度越慢」）：以 32px 为基准
 *   56ms/px（用户认可的速度），按 size/32 线性放大/缩小；总时长上限 15s、
 *   下限 1.2s——大字号的长文本滑得非常从容，小字号不至于一闪而过；
 * - 回滚固定 180ms 不随字号变 —— 进入慢、离开快。
 * - 悬停中拖动字号滑条：文本重排后旧位移距离作废，直接回滚到起点。
 */
export function useMarquee(size: number) {
  const measureRef = useRef<any>(null);
  const [shift, setShift] = useState(0);
  const enter = useCallback(() => {
    const el = measureRef.current;
    if (!el) return;
    const over = el.scrollWidth - el.clientWidth;
    setShift(over > 2 ? -over : 0);
  }, []);
  const leave = useCallback(() => setShift(0), []);
  // 字号变了：溢出量已经不准，正在展开的直接归位，下次悬停按新字号重新量
  useEffect(() => {
    setShift(0);
  }, [size]);
  return {
    measureRef,
    shift,
    enter,
    leave,
    open: shift !== 0,
    moverStyle: {
      transform: `translateX(${shift}px)`,
      "--marquee-dur": `${Math.min(
        15000,
        Math.max(1200, Math.abs(shift) * 56 * Math.max(0.25, size / 32)),
      )}ms`,
    } as CSSProperties,
  };
}
