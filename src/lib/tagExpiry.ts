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
