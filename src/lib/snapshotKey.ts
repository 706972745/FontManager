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
 * 3. 字族匹配（字体改名/样式名本地化时的兜底）
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
  return index.byFamily.get(family) ?? [];
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
