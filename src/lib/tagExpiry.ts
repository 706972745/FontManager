/**
 * 标签到期的三个纯函数（fontStore 的存取与 UI 的展示共用）。
 *
 * 口径（用户 2026-11-13）：每个标签可设到期日期，到日期后**不经确认直接删除**
 * 该标签（从所有字体上移除）；到期日当天仍有效，次日起算过期 —— 与
 * `license.ts::copyrightExpired` 的「当天 23:59:59」口径一致。
 */

/** `YYYY-MM-DD` */
export type TagExpiryDate = string;

/** 跨年显示 `YYYY-MM-DD`，今年内显示 `MM-DD`（侧栏 / 标签胶囊上的红色小字） */
export function formatTagExpiry(date: string, now = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return m[1] === String(now.getFullYear()) ? `${m[2]}-${m[3]}` : date;
}

/** 到期日**当天仍有效**，次日起算过期；格式坏值一律视为未到期（宁可少删不可误删） */
export function isTagExpired(date: string, now = new Date()): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return false;
  const endOfDay = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    23,
    59,
    59,
    999,
  ).getTime();
  return now.getTime() > endOfDay;
}

/** prefs.json / 存储里恢复时的校验：不是 `YYYY-MM-DD` 整条丢掉 */
export function parseTagExpiry(raw: unknown): string | null {
  return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

/**
 * sweep 的单步收尾（纯函数，便于单测）：
 * `removeTagEverywhere` 内部会吞掉逐族失败并回滚、**不抛出** —— 只能靠
 * 「标签是否还挂在任何字族上」判断成败。部分失败时**保留到期键**（下一轮
 * sweep 自然重试），只有真删干净才允许删键 + 发「已自动移除」toast。
 *
 * 返回新的 tagExpiry；返回 null = 失败，键保留、跳过 toast。
 */
export function sweepTagResult(
  tagExpiry: Record<string, string>,
  tags: Record<string, string[]>,
  tag: string,
): Record<string, string> | null {
  const gone = !Object.values(tags).some(
    (list) => Array.isArray(list) && list.includes(tag),
  );
  if (!gone) return null;
  const next = { ...tagExpiry };
  delete next[tag];
  return next;
}
