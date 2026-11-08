/**
 * Ctrl + 滚轮调预览字号的**纯逻辑**（不碰 DOM / store，方便 node --test 直接跑）。
 *
 * 为什么不是「收到 wheel 就换一档」：鼠标滚轮一格在不同环境下 deltaY 有 100 / 120 / 125
 * （DPI 缩放）几种，触控板则是每帧 1~5 的一串小增量。按固定阈值直接换档的话，
 * 一格滚轮有时跳两档、触控板又完全不动。这里做成「累计 + 每满一格走一档」：
 * 传统滚轮一格一次，触控板攒够一格的距离也走一次，两头都跟手。
 */

/** 走一档需要的累计滚动量（px）。 */
export const WHEEL_UNIT = 100;

/** 单次事件最多走几档：按住 Ctrl 猛甩滚轮时不至于从 8px 直接窜到 96px。 */
export const MAX_STEPS_PER_EVENT = 2;

export interface WheelStep {
  /** 传给下一次调用的残余累计量 */
  acc: number;
  /** 本次应当移动的档位数：正数 = 放大（档位下标 +1），负数 = 缩小 */
  steps: number;
}

/**
 * 把一次 wheel 事件换算成档位步进。
 *
 * @param acc      上一次剩下的累计量
 * @param deltaY   事件里的 deltaY（往下滚为正）
 * @param deltaMode 0 = 像素，1 = 行，2 = 页
 */
export function wheelStep(acc: number, deltaY: number, deltaMode = 0): WheelStep {
  // 行 / 页两种单位的设备很少见，但换算错了就是「滚一格跳八档」，还是兜一下
  const norm = deltaMode === 1 ? deltaY * 40 : deltaMode === 2 ? deltaY * 600 : deltaY;
  let rest = acc + norm;
  const whole = Math.trunc(rest / WHEEL_UNIT);
  if (whole === 0) {
    // 触控板的小增量先攒着，别丢 —— 否则慢速滑动永远不触发
    return { acc: rest, steps: 0 };
  }
  const capped = Math.max(-MAX_STEPS_PER_EVENT, Math.min(MAX_STEPS_PER_EVENT, whole));
  if (capped !== whole) {
    // 猛甩滚轮被截断了：多出来的量**直接丢弃**。
    // 留着的话用户滚过头再往回滚一格会先「还债」，手感上就是「往回滚没反应」。
    return { acc: 0, steps: -capped };
  }
  rest -= capped * WHEEL_UNIT;
  // 物理上往下滚（deltaY > 0）= 想看小的
  return { acc: rest, steps: -capped };
}

/** 把步进夹到 [min, max] 里。 */
export function clampIndex(current: number, steps: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, current + steps));
}
