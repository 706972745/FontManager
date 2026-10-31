/**
 * 预取窗口的计算（纯逻辑，不碰 DOM / 不碰字体加载）。
 *
 * 单独抽出来的原因：这段逻辑全是边界条件（首屏、末屏、方向、窗口上限），
 * 埋在 `FontGrid` 的滚动回调里只能靠真机试，写不出来测试。
 *
 * 规则（见交接文档 §14.1）：
 * - **只预取滚动方向前方**，不预取反方向 —— 反方向是「刚滚过去」的，它们还在 LRU 里；
 * - 窗口宽度按**视口量**算，不是固定条数：卡片高度随字号变，固定条数在最小/最大字号下差 3 倍；
 * - 从近到远返回，让最近的先排进在途队列（预取有并发上限，顺序决定谁先完成）；
 * - 总条数设硬上限，防止 `span` 异常（首帧 last-first 可能很大）时一次性发起几百个。
 */

export type ScrollDir = -1 | 0 | 1;

export const MAX_PREFETCH_ITEMS = 40;

/**
 * 返回需要预取的行索引（`[first, last]` 是当前可见区间，闭区间）。
 *
 * @param count    列表总条数
 * @param first    可见区间起（含）
 * @param last     可见区间止（含）
 * @param dir      滚动方向：1 向下 / -1 向上 / 0 没有方向（按向下处理）
 * @param screens  视口外预留几屏
 */
export function prefetchIndices(
  count: number,
  first: number,
  last: number,
  dir: ScrollDir,
  screens = 1,
): number[] {
  if (count <= 0) return [];
  const lo = Math.max(0, Math.min(first, last));
  const hi = Math.min(count - 1, Math.max(first, last));
  const span = Math.max(1, hi - lo + 1);
  const width = Math.min(MAX_PREFETCH_ITEMS, Math.max(1, Math.round(span * screens)));

  const out: number[] = [];
  if (dir < 0) {
    // 向上滚：预取上侧（由近到远）
    for (let i = lo - 1; i >= Math.max(0, lo - width); i -= 1) out.push(i);
  } else {
    // 向下滚（或没有方向）：预取下侧（由近到远）
    for (let i = hi + 1; i <= Math.min(count - 1, hi + width); i += 1) out.push(i);
  }
  return out;
}
