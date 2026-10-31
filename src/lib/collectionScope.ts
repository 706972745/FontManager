/**
 * 分组视图里「该显示整族，还是只显示部分字重」。
 *
 * 分组有两种成员：
 *   - 整族 —— `collections[分组]` 里放字族名；
 *   - 字重 —— `collectionFaces[分组]` 里放 `faceKey(face)`。
 *
 * 0.9.9-13 只看后者：先单独把「標準體」加进分组、再把整族 `.蘋方-繁` 加进同一分组时，
 * 视图仍然只显示「標準體」，「極細體」消失 —— 整族被错误收窄（用户 2026-10-31 真机复现）。
 * 整族既然是成员，就应该显示整族；只有「整族不在组里、只加了部分字重」才需要收窄。
 *
 * 抽成纯函数是为了能直接单测（FamilyCard 里那段 useMemo 没法单独喂数据）。
 */

export function collectionFaceScope<T extends { id: string }>(
  /** 当前卡片对应的字族名 */
  familyName: string,
  /** 该字族的全部字面 */
  faces: readonly T[],
  /** 字面 → 分组成员键（一般是 faceKey） */
  keyOf: (face: T) => string,
  /** `collectionFaces[分组]`：字重级成员键 */
  memberKeys: readonly string[],
  /** `collections[分组]`：整族成员名 */
  wholeFamilies: readonly string[],
): Set<string> | null {
  // 整族已经是成员 → 不收窄
  if (wholeFamilies.includes(familyName)) return null;
  // 没有字重级成员 → 不收窄
  if (memberKeys.length === 0) return null;

  const wanted = new Set(memberKeys);
  const hit = faces.filter((f) => wanted.has(keyOf(f)));
  // 命中的字面覆盖了整族（或一个都没命中）→ 没有收窄的必要
  if (hit.length === 0 || hit.length >= faces.length) return null;

  return new Set(hit.map((f) => f.id));
}
