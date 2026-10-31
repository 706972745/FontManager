import type { FontFace, SnapshotEntry } from "./ipc";

/**
 * 卡片 / 速览 / 列表行上那个小胶囊要显示的数据。
 *
 * 用户 2026-10-31：「加入了几个进去让人更清楚选择了几个字重在这个快照里面，
 * 当鼠标悬浮在这个图标上的时候，会显示出哪些字重加入了这个快照」。
 * 所以胶囊 = 容器名 + 数量，悬浮气泡 = 具体字重清单。
 */
export interface MemberBadge {
  name: string;
  /** 这个字族在容器里实际放进去几个字重 */
  count: number;
  /** 具体是哪些字重（样式名，去重；样式为空时退回 PostScript 名） */
  styles: string[];
}

const norm = (s?: string | null) => (s ?? "").trim().toLowerCase();

/** 字重的显示名：样式名优先，空的话退回 PostScript 名 */
export function faceLabel(style?: string | null, fallback?: string | null): string {
  const s = (style ?? "").trim();
  if (s) return s;
  const f = (fallback ?? "").trim();
  return f || "—";
}

/**
 * 把一堆字重名收成一个胶囊数据。
 * 去重是必须的：同一字面在系统 + 库里各一份时，快照可能存了两条同名字重条目。
 */
export function memberBadge(name: string, styles: readonly string[]): MemberBadge {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of styles) {
    const k = norm(raw);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(raw.trim());
  }
  return { name, count: out.length, styles: out };
}

/** 某个字族在各快照里放进去的字重（只算这个字族自己的条目） */
export function snapshotBadgesFor(
  family: string,
  snapshots: readonly { name: string; entries: readonly SnapshotEntry[] }[],
): MemberBadge[] {
  const out: MemberBadge[] = [];
  for (const sn of snapshots) {
    const mine = sn.entries.filter((e) => e.family === family);
    if (mine.length === 0) continue;
    out.push(memberBadge(sn.name, mine.map((e) => faceLabel(e.style, e.key))));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 某个字族在各分组里放进去的字重。
 *
 * 两种情况要合起来看（0.9.9-13 起分组支持字重级成员）：
 * - 整族在分组里（`collections[name]` 包含字族）→ 该族所有字重都算进去
 * - 只放了某几个字重（`collectionFaces[name]` 里的 faceKey）→ 只算这几个
 * 两者同时存在时按整族算，避免同一个字重被数两次。
 */
export function collectionBadgesFor(
  family: string,
  faces: readonly FontFace[],
  collections: Readonly<Record<string, readonly string[]>>,
  collectionFaces: Readonly<Record<string, readonly string[]>>,
  /** 字面 → 分组成员键（一般是 faceKey）。传函数进来是为了这个模块不依赖别的 lib，
   *  保持「能被 node --test 直接跑」——与 collectionScope 同一套做法 */
  keyOf: (face: FontFace) => string,
): MemberBadge[] {
  const out: MemberBadge[] = [];
  for (const name of Object.keys(collections).sort((a, b) => a.localeCompare(b))) {
    const whole = (collections[name] ?? []).includes(family);
    const keys = new Set(collectionFaces[name] ?? []);
    let styles: string[];
    if (whole) {
      styles = faces.map((f) => faceLabel(f.style, f.postscriptName));
    } else {
      styles = faces
        .filter((f) => keys.has(keyOf(f)))
        .map((f) => faceLabel(f.style, f.postscriptName));
    }
    // 整族在组里但字体还没加载出来时也要显示胶囊（count 会是 0）
    if (!whole && styles.length === 0) continue;
    out.push(memberBadge(name, styles));
  }
  return out;
}
