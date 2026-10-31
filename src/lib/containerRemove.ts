/**
 * 「把字族移出分组 / 快照」的纯逻辑（0.9.9-1）。
 *
 * 单独拎出来是为了能单测：这两处判定很容易写错，而写错的后果很吓人 ——
 * 分组那侧如果误用 toggle 语义，会把字体「加回去」；快照那侧如果按 faceKey
 * 反查字体表，会漏掉已经不在本机的条目，留下永远删不掉的幽灵。
 */

/** 分组里真正会被移出的字族（不在分组里的忽略掉） */
export function pickRemovedFamilyNames(current: string[], families: string[]): string[] {
  const drop = new Set(families);
  return current.filter((f) => drop.has(f));
}

/**
 * 快照条目按 `family` 字段过滤，返回「留下的条目」。
 *
 * 用 entry.family 而不是 entry.key：快照是 face 级、可跨设备，
 * 字体可能已经不在本机字库里（卸载过 / 换了机器），按 key 反查会一条都删不掉。
 */
export function withoutFamilies<T extends { family: string }>(
  entries: T[],
  families: string[],
): T[] {
  const drop = new Set(families);
  return entries.filter((e) => !drop.has(e.family));
}
