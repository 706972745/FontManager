import type { FontFace, SnapshotEntry } from "./ipc";
// 带 .ts 后缀：这个模块要能被 `node --test` 直接跑（无扩展名的值导入在 Node 里会
// ERR_MODULE_NOT_FOUND）。tsconfig 开了 allowImportingTsExtensions，Vite 也认。
import { faceLabel, memberBadge, type MemberBadge } from "./memberBadges.ts";
// 分组顺序必须和侧栏共用同一个函数（faceContainers 里那段注释说的就是这个）：
// 各自写一份 localeCompare 迟早会因为细节走样，序号就对不上了。
import { sortContainers } from "./faceContainers.ts";

/**
 * 一次性算出「每个字族的快照 / 分组胶囊」。
 *
 * 为什么不是对每个字族调 `collectionBadgesFor`：那是「分组数 × 字族数」的双重循环，
 * 4211 族 × 若干分组还能凑合，字族上万时每次筛选、每个扫描批次都要跑几十万次 ——
 * 扫描期直接掉帧。这里改成先建两张索引（字族名 → 字族、字面 key → 字族名），
 * 之后只遍历「实际有成员的条目」，总量回到 O(家庭成员数 + 字面数)。
 *
 * 语义与 `collectionBadgesFor` 保持一致：整族在分组里就按全族算，不再叠加字重级成员
 * （否则同一个字重会被数两次、卡片上还会多出一枚重复胶囊）。
 */

export type FamilyMembership = { snaps: MemberBadge[]; colls: MemberBadge[] };

export interface MembershipFamily {
  name: string;
  faces: readonly FontFace[];
}

export function buildMembership(
  families: readonly MembershipFamily[],
  snapshots: readonly { name: string; entries: readonly SnapshotEntry[] }[],
  collections: Readonly<Record<string, readonly string[]>>,
  collectionFaces: Readonly<Record<string, readonly string[]>>,
  /** 字面 → 分组成员键（一般是 faceKey），传函数进来保持本模块不依赖其它 lib */
  keyOf: (face: FontFace) => string,
): Map<string, FamilyMembership> {
  const map = new Map<string, FamilyMembership>();
  const ensure = (family: string): FamilyMembership => {
    let rec = map.get(family);
    if (!rec) {
      rec = { snaps: [], colls: [] };
      map.set(family, rec);
    }
    return rec;
  };

  // 快照：条目自带字族名，直接按条目累加
  for (const sn of snapshots) {
    const byFamily = new Map<string, string[]>();
    for (const e of sn.entries) {
      const arr = byFamily.get(e.family) ?? [];
      arr.push(faceLabel(e.style, e.key));
      byFamily.set(e.family, arr);
    }
    for (const [family, styles] of byFamily) {
      ensure(family).snaps.push(memberBadge(sn.name, styles));
    }
  }

  const famByName = new Map<string, MembershipFamily>();
  const faceOwner = new Map<string, string>();
  for (const fam of families) {
    famByName.set(fam.name, fam);
    for (const f of fam.faces) faceOwner.set(keyOf(f), fam.name);
  }

  // 分组名取两边的并集：只放了字重、`collections[name]` 还没建键的分组也要算到
  const names = new Set([...Object.keys(collections), ...Object.keys(collectionFaces)]);
  for (const name of sortContainers([...names])) {
    const whole = new Set(collections[name] ?? []);
    const keys = collectionFaces[name] ?? [];
    if (whole.size === 0 && keys.length === 0) continue;

    // 整族成员：胶囊里的「具体字重」就是整族全部字面
    for (const family of whole) {
      const fam = famByName.get(family);
      if (!fam) continue;
      ensure(family).colls.push(
        memberBadge(name, fam.faces.map((f) => faceLabel(f.style, f.postscriptName))),
      );
    }

    // 字重级成员：同一个字族合并成一枚胶囊；整族已在组里的不再重复
    const byFamily = new Map<string, Set<string>>();
    for (const key of keys) {
      const family = faceOwner.get(key);
      if (!family || whole.has(family)) continue;
      const set = byFamily.get(family) ?? new Set<string>();
      set.add(key);
      byFamily.set(family, set);
    }
    for (const [family, keySet] of byFamily) {
      const fam = famByName.get(family);
      if (!fam) continue;
      // 按字族内字面顺序出行，胶囊里的字重清单顺序才稳定
      const styles = fam.faces
        .filter((f) => keySet.has(keyOf(f)))
        .map((f) => faceLabel(f.style, f.postscriptName));
      if (styles.length > 0) ensure(family).colls.push(memberBadge(name, styles));
    }
  }

  return map;
}
