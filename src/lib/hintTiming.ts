/**
 * 提示气泡的等待时长（细节优化 2.4.1）。
 *
 * 抽成纯函数是为了能被单测钉住：这段逻辑以前是写死在 HoverHint 的 effect 里的
 * 一个 `DELAY = 1000`，谁也验证不了「第二条是不是真的更快了」。
 *
 * 业界把这个模式叫 skip delay，已经是设计系统的默认参数：
 *   Radix     700ms 首次 + 关掉后 300ms 内立即
 *   Base UI   500ms 首次 + 300ms 内立即
 *   UserTesting DS  1s 首次 + 2s 内立即
 * 我们保留现有的 1 秒首次（用户视角已经习惯），只补后半段。
 */

/** 首次悬停：等满 1 秒，确认「不是路过」 */
export const HINT_DELAY = 1000;

/**
 * 第 2 条起：120ms。
 * 不用 0 —— 留一点淡入，否则气泡「啪」地闪出来，比等一秒更吵。
 */
export const HINT_SKIP_DELAY = 120;

/** 「还在挨个看」的判定窗口：上一条关掉后 2 秒内算同一次浏览 */
export const HINT_SKIP_WINDOW = 2000;

/**
 * 这一次悬停该等多久。
 *
 * @param lastClosedAt 上一条气泡是「指针移走」关掉的时刻（ms）。滚动 / 按键 /
 *                     失焦关掉的**不该**传进来 —— 那说明用户已经不在看提示了。
 * @param now          当前时刻（ms）。显式传入，便于测试。
 */
export function hintDelay(lastClosedAt: number | null, now: number): number {
  if (lastClosedAt == null) return HINT_DELAY;
  const gap = now - lastClosedAt;
  // gap < 0 说明时钟被外部改过（休眠唤醒 / 手工对时）：当成「第一次」，宁可慢也别乱快
  if (gap < 0) return HINT_DELAY;
  return gap < HINT_SKIP_WINDOW ? HINT_SKIP_DELAY : HINT_DELAY;
}
