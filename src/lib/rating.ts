/**
 * 1.2.4 收藏评分 / 「按启用时间排序」的纯逻辑（不碰 store、不碰 IPC，方便单测）。
 *
 * 评分口径：1~5 星，最低 1 星；0 / 缺项 = 未评分。筛选按「至少 N 星」，
 * 不是「恰好 N 星」—— 打了 5 星的字体理应也出现在「至少 3 星」里。
 */

export const MIN_RATING = 1;
export const MAX_RATING = 5;

export function isRating(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= MIN_RATING && v <= MAX_RATING;
}

/** 从 prefs / 导入文件里读评分表：形状不对的整条丢掉，不猜用户意图 */
export function normalizeRatings(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isRating(v)) out[name] = v;
  }
  return out;
}

/** 0 / 非法值 = 不限；未评分的族永远不满足「至少 1 星」 */
export function meetsRating(
  ratings: Record<string, number>,
  name: string,
  min: number,
): boolean {
  if (!Number.isInteger(min) || min < MIN_RATING) return true;
  return (ratings[name] ?? 0) >= min;
}

/** 最近启用在前；都没记录过就按名字排，不让「谁更旧」参与比较 */
export function compareActivated(
  a: string,
  b: string,
  activatedAt: Record<string, number>,
): number {
  return (activatedAt[b] ?? 0) - (activatedAt[a] ?? 0) || a.localeCompare(b);
}
