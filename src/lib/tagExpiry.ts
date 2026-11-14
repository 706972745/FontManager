/**
 * 标签到期的三个纯函数（fontStore 的存取与 UI 的展示共用）。
 *
 * 口径（用户 2026-11-13）：每个标签可设到期日期，到日期后**不经确认直接删除**
 * 该标签（从所有字体上移除）；到期日当天仍有效，次日起算过期 —— 与
 * `license.ts::copyrightExpired` 的「当天 23:59:59」口径一致。
 *
 * 2.1.7 追加（用户 2026-11-14）：**自动标签不能设到期日**（`canSetExpiry`），
 * 且到期日会连带删掉其它字体上的同名标签，波及 2 个及以上字体时先问一句
 * （没定过日期的每次点日历都问）。
 */

import { isAutoTagId } from "./tagVocabulary.ts";

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
 * 到期日会波及多少个字族时才先问用户（用户 2026-11-14，21:12 二次明确）。
 *
 * 标签是**按名字**存在 `state.json` 里的，一个名字常常被几十上百个字体共用：
 * 给「无衬线体」设个到期日，删掉的是**所有**带这个名字的字体上的它，不是当前这一个。
 * 阈值 = **2 个及以上**（含 2）就先问一句 —— 哪怕只共用一对字体，用户也该知道
 * 「这一刀会砍到别家」。
 */
export const EXPIRY_WARN_FAMILIES = 2;

export function expiryNeedsConfirm(familyCount: number): boolean {
  return familyCount >= EXPIRY_WARN_FAMILIES;
}

/**
 * 自动标签**不允许**设到期日（用户 2026-11-14）。
 *
 * 理由不只是「设了也没用」：自动标签是按规则现算出来的，到期把它从所有字体上删掉之后，
 * 下一次推导又会把它加回来（除非进了否决名单）—— 用户会看到「删了又回来」。
 * 所以判据统一放在这里：按**名字**判（同 B73 的图标口径），而不是看它存在手工还是自动。
 */
export function canSetExpiry(tag: string): boolean {
  return !isAutoTagId(tag);
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
