import type { FontFace, SnapshotEntry } from "./ipc";

/**
 * 快照的跨设备可移植标识。
 *
 * 快照只记录字体自身的元数据（postScriptName / 字族 / 样式 / 字重），
 * 不记录任何目录信息 —— 因为每台电脑的字体库路径不同，绝对路径换机器后必然失效。
 */

const norm = (s: string) => s.trim().toLowerCase();

/** 字体的可移植标识：postScriptName 全局唯一，缺失时回退到 字族+样式+字重+面索引 */
export function faceKey(f: FontFace): string {
  const ps = f.postscriptName?.trim();
  if (ps) return `ps:${norm(ps)}`;
  return `fam:${norm(f.family)}|${norm(f.style)}|${f.weight}|${f.italic ? 1 : 0}|${f.faceIndex}`;
}

/** 文件名（小写、去掉目录），仅用于旧数据迁移时做无歧义兜底匹配 */
function baseName(path: string): string {
  return norm(path.split(/[\\/]/).pop() ?? "");
}

export function entryFromFace(f: FontFace): SnapshotEntry {
  return {
    key: faceKey(f),
    family: f.family,
    style: f.style,
    system: f.source === "system",
  };
}

export interface FaceIndex {
  /** 标识 → 字体（同一字体可能同时存在于系统目录与字体库） */
  byKey: Map<string, FontFace[]>;
  /** 字族|样式 → 字体 */
  byFamilyStyle: Map<string, FontFace[]>;
  /** 字族 → 字体 */
  byFamily: Map<string, FontFace[]>;
  /** 绝对路径 → 字体（仅本机迁移旧数据用） */
  byPath: Map<string, FontFace>;
  /** 文件名 → 字体 */
  byFileName: Map<string, FontFace[]>;
}

/**
 * 带缓存的索引（按 fonts 数组引用缓存）。
 * 快照视图里这个索引会被 App（过滤字族）和 SnapshotBar（算缺失 / 系统字体数）各建一次，
 * 而且每次 store 变化都会重渲染 —— 6000 个字面 × 5 张 Map，2000 条快照时这一项就很可观。
 * 数组引用没变就复用同一份索引。
 */
const indexCache = new WeakMap<FontFace[], FaceIndex>();

export function buildFaceIndexCached(fonts: FontFace[]): FaceIndex {
  const hit = indexCache.get(fonts);
  if (hit) return hit;
  const built = buildFaceIndex(fonts);
  indexCache.set(fonts, built);
  return built;
}

function push(map: Map<string, FontFace[]>, key: string, face: FontFace) {
  const arr = map.get(key);
  if (arr) arr.push(face);
  else map.set(key, [face]);
}

export function buildFaceIndex(fonts: FontFace[]): FaceIndex {
  const index: FaceIndex = {
    byKey: new Map(),
    byFamilyStyle: new Map(),
    byFamily: new Map(),
    byPath: new Map(),
    byFileName: new Map(),
  };
  for (const f of fonts) {
    push(index.byKey, faceKey(f), f);
    push(index.byFamilyStyle, `${norm(f.family)}|${norm(f.style)}`, f);
    push(index.byFamily, norm(f.family), f);
    index.byPath.set(f.path, f);
    push(index.byFileName, baseName(f.path), f);
  }
  return index;
}

/**
 * 把快照条目解析为本机上的字体：
 * 1. key 精确匹配（正常情况）
 * 2. 字族 + 样式匹配（不同版本字体 PS 名变化时）
 * 3. 字族匹配（字体改名/样式名本地化时的兜底）—— **仅当该字族只有 1 个字体时才用**，
 *    否则会把整族所有字重都算进来（320 条快照解析出上千个文件，切换慢 2~3 倍）。
 *    多字重时宁可标为「缺失」，让用户手动处理，也不要误启用整族。
 */
export function resolveEntry(entry: SnapshotEntry, index: FaceIndex): FontFace[] {
  if (entry.key) {
    const hit = index.byKey.get(entry.key);
    if (hit && hit.length > 0) return hit;
  }
  const family = norm(entry.family ?? "");
  if (!family) return [];
  if (entry.style) {
    const hit = index.byFamilyStyle.get(`${family}|${norm(entry.style)}`);
    if (hit && hit.length > 0) return hit;
  }
  // 字族兜底只在无歧义时使用（字族只有 1 个字体），避免「存了 3 个字重、切回来却启用整族 8 个」
  const familyHit = index.byFamily.get(family) ?? [];
  return familyHit.length === 1 ? familyHit : [];
}

/** 旧快照条目（只有绝对路径）→ 可移植条目；解析不出来时保留 key 为空 */
export function migrateEntry(entry: SnapshotEntry, index: FaceIndex): SnapshotEntry {
  const path = entry.path;
  if (!entry.key && path) {
    const exact = index.byPath.get(path);
    if (exact) {
      const migrated = entryFromFace(exact);
      return { ...migrated, system: entry.system || migrated.system };
    }
    // 路径已失效（换机器/换库路径）：文件名唯一时勉强对上
    const candidates = index.byFileName.get(baseName(path)) ?? [];
    if (candidates.length === 1) {
      const migrated = entryFromFace(candidates[0]);
      return { ...migrated, system: entry.system || migrated.system };
    }
  }
  return {
    key: entry.key ?? "",
    family: entry.family ?? "",
    style: entry.style ?? "",
    system: !!entry.system,
  };
}

/** 快照中在本机找不到的条目（用于“清理失效项”与提示） */
export function missingEntries(entries: SnapshotEntry[], index: FaceIndex): SnapshotEntry[] {
  return entries.filter((e) => resolveEntry(e, index).length === 0);
}

/**
 * 快照里「有系统安装那一份」的条目 —— 应用快照时这些不会被停用（系统字体动不了）。
 *
 * 口径改过一次，两次都不理想，记在这里免得来回折腾：
 *
 * 1. 最初是「解析结果**全是** system 才算」（函数名 `systemOnlyEntries` 就是那时候留下的）。
 *    本意是避开「326 条条目 / 320 个系统字体」这种看着吓人的数字 —— 用户库里往往有同名副本，
 *    那些条目其实能正常启停、并不依赖系统安装。
 * 2. 但这个口径在真实数据上会走到另一个极端：一个**全部由系统字体抓来**的快照
 *    （名字就叫「回归-系统166」、320 条全是系统字面），因为库里同时存在 304 个同名副本，
 *    徽标只显示出「1 个系统字体」，和快照名直接自相矛盾，比原来更让人困惑（用户 2026-10-31 报）。
 *
 * 现在取「**有**系统字面就算」：它准确回答了徽标真正要回答的问题 ——
 * 「应用这个快照时，有多少条不受我控制（因为它们是系统装的）」。
 */
export function systemBackedEntries(entries: SnapshotEntry[], index: FaceIndex): SnapshotEntry[] {
  return entries.filter((e) => {
    const hit = resolveEntry(e, index);
    return hit.some((f) => f.source === "system");
  });
}

/** 快照条目解析出的本机字体路径集合（去重） */
export function entryPaths(entries: SnapshotEntry[], index: FaceIndex): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    for (const f of resolveEntry(e, index)) {
      if (!seen.has(f.path)) {
        seen.add(f.path);
        out.push(f.path);
      }
    }
  }
  return out;
}

/**
 * 快照条目解析出的**字面 id** 集合（去重）。
 *
 * 为什么不能拿 `entryPaths` 当「这个快照包含哪些字面」用：路径是**文件**级别的，
 * 而 TTC 一个文件里可以装好几个互不相干的 family —— 最典型的是 Windows 的 `msjh.ttc`，
 * 里面既有 `Microsoft JhengHei`（中文名片假「微軟正黑體」）又有 `Microsoft JhengHei UI`。
 * 只要快照收了前者，按路径匹配就会把后者一并算进来，表现为「我只加了一个字体，快照里
 * 却冒出两个」（用户 2026-10-31 报）。按 `FontFace.id`（`路径#序号`）匹配才不会串味。
 *
 * 注意：**启停字体仍然要用 `entryPaths`** —— 那边是按文件注册/注销的，路径才是对的。
 */
export function entryFaceIds(entries: SnapshotEntry[], index: FaceIndex): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    for (const f of resolveEntry(e, index)) {
      if (!seen.has(f.id)) {
        seen.add(f.id);
        out.push(f.id);
      }
    }
  }
  return out;
}
