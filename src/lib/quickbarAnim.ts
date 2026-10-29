/**
 * 速览窗口动画里那两块「纯逻辑」。
 *
 * 抽出来的唯一目的是能被单元测试直接盯住：时间轴归一化的收尾、热键 toggle 的串行合并，
 * 这两个地方以前都是内联在 hook 里的 `if (...) return`，出了问题只能靠 60fps 抓帧回看
 * （而且结论并不唯一）。算法本身与 DOM / Tauri 无关。
 */

/**
 * 把「线性进度 t（0~1）」换算成「扣掉前导滞后 LEAD 之后的进度」。
 *
 * 为什么需要它：WebView2 的内容纹理比窗口晚 1~3 帧，所以内容高度要比窗口滞后一个
 * LEAD（45ms）变化。早期实现写成 `t - LEAD/duration`，t=1 时只到 1 - 45/200 = 0.775，
 * 收尾那一下会突然补到 100%，实测约 1.14% 的跳变。
 *
 * 正确做法是把剩下的时间重新拉满：`(t*d - L) / (d - L)`，
 * 它在 `t = L/d` 处正好为 0、在 `t = 1` 处正好为 1，中途保持同一条缓动曲线。
 */
export function leadNormalized(t: number, durationMs: number, leadMs: number): number {
  // 时长必须严格大于 LEAD，否则分母会变成 0（极短的动画时长只在「减少动效」里出现）
  const lead = Math.min(leadMs, Math.max(1, durationMs - 1));
  const span = Math.max(1, durationMs - lead);
  if (!Number.isFinite(t) || t <= 0) return 0;
  if (t >= 1) return 1;
  return Math.max(0, Math.min(1, (t * durationMs - lead) / span));
}

export interface SerialQueue {
  /**
   * 排一个任务。任务按提交顺序**一个一个**跑，永不并发。
   * 返回的 Promise 在这次任务真正跑完后 resolve。
   */
  run: (task: () => void | Promise<void>) => Promise<void>;
  /** 已经提交但还没跑完的任务数（含正在跑的那个） */
  readonly pending: number;
}

/**
 * 串行队列（热键 toggle 用）。
 *
 * 速览的收起 / 展开各自是几百毫秒的多段异步，快速连按热键时第二下会撞上
 * `animating / mutating` 被静默丢掉——用户看到「按了两下只反应一下」。
 * 排队之后：每一下都会被执行，而且**执行的那一刻**才去读当前状态，
 * 所以「收 → 展 → 收」三下连按的最后结果一定是收起。
 *
 * 注意：任务里的错误不会打断后面的任务（否则一次失败会把队列卡死）。
 */
export function createSerialQueue(onError?: (e: unknown) => void): SerialQueue {
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;

  const run = (task: () => void | Promise<void>): Promise<void> => {
    pending++;
    const next = chain
      .then(async () => {
        try {
          await task();
        } catch (e) {
          onError?.(e);
        }
      })
      .finally(() => {
        pending--;
      });
    chain = next;
    return next;
  };

  return {
    run,
    get pending() {
      return pending;
    },
  };
}
