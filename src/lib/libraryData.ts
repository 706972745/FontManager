/**
 * 「整理成果」导出 / 合并的纯逻辑（不碰 IPC、不碰 store，方便单测）。
 *
 * 口径（2026-11-03 用户报障后定）：设置里的导出必须涵盖**用户亲手产出的全部整理数据** ——
 * 标签、分组（字族级 + 字重级）、收藏、备注、手动版权状态、版权到期日期。
 * 原来的 payload 只有前四项，用户换了台机器发现「版权标注全没了」。
 *
 * **快照不在这里**：快照有自己的 `kind: "snapshots"` 文件格式与导入导出入口
 * （侧栏每个快照可导出、设置里「快照」一行可批量导出/导入），两套数据不混在一个文件里，
 * 免得导入标签时顺手把快照冲掉。
 *
 * 合并规则（都写在这里，不许在 store 里另写一套）：
 * - 标签 / 分组 / 字重级分组 / 收藏：**只增不减**。这些是「另一台机器的成果」，
 *   本地已有的不能因为导入一份旧文件被抹掉。
 * - 备注 / 手动版权 / 到期日期：同一条目**本地优先**，导入只补空缺。
 *   备注本来就是这个口径；版权同理 —— 导入一份旧备份不该把本机刚改过的判定冲掉。
 */

// 显式 .ts：这个模块被 node --test 直接加载（不经打包器），Node 不会自动补扩展名。
import { normalizeRatings } from "./rating.ts";
import { detectJsonKind, fileDescription, isOurSuffix } from "./fileKinds.ts";

export interface TagMetaEntry {
  /** 语义色键（gray/red/…），不是色值 */
  color?: string;
  /** 所属标签分组 */
  group?: string;
}

export interface TagGroupEntry {
  name: string;
  color?: string;
}

export interface CurationData {
  /** 字族 → 标签 */
  tags: Record<string, string[]>;
  /** 分组名 → 字族名 */
  collections: Record<string, string[]>;
  /** 分组名 → 字重级成员键（faceKey），分组按单个字重收进去时用这个 */
  collectionFaces: Record<string, string[]>;
  /** 收藏的字族名 */
  favorites: string[];
  /** 字族 → 备注（含版权判定自动写的那几条） */
  notes: Record<string, string>;
  /** 字族 → 手动版权状态："free_commercial" | "free_personal" | "paid" | "timelimited" */
  copyrightStatus: Record<string, string>;
  /** 字族 → 时间限制版权的到期日 "YYYY-MM-DD" */
  copyrightExpiry: Record<string, string>;
  /** 1.2.4 收藏评分：字族 → 1~5 星（0 / 缺项 = 未评分，不写进文件） */
  ratings: Record<string, number>;
  /**
   * 标签自身的属性（颜色 / 分组），键是**标签名**。
   * 2.3.0 新增：不加进导出的话，换台机器恢复出来的标签全变回默认灰、全部散在「未分组」。
   */
  tagMeta: Record<string, TagMetaEntry>;
  /** 标签分组（有序数组，下标即侧栏顺序）。与 `collections`（字体分组）是两件事 */
  tagGroups: TagGroupEntry[];
  /** 标签到期日：标签名 → "YYYY-MM-DD"（标签按名字共用，所以键是标签名不是族名） */
  tagExpiry: Record<string, string>;
}

export const CURATION_APP = "FontManager";
export const CURATION_KIND = "curation";
/** 1 = 只有标签/分组/收藏/备注；2 = 加字重级分组 + 手动版权 + 到期日期；
 *  3 = 加收藏评分（1~5 星）；4 = 文件内写入自描述头（用途 / 导入方式 / 推荐后缀）；
 *  5 = 加标签颜色与标签分组（tagMeta / tagGroups）+ 标签到期日（tagExpiry）。
 *  数据 schema 只增不减，导入端 1~5 全认，缺项按空处理。 */
export const CURATION_VERSION = 5;

export const emptyCuration = (): CurationData => ({
  tags: {},
  collections: {},
  collectionFaces: {},
  favorites: [],
  notes: {},
  copyrightStatus: {},
  copyrightExpiry: {},
  ratings: {},
  tagMeta: {},
  tagGroups: [],
  tagExpiry: {},
});

/** Record<string, string[]>：数组且元素是字符串，顺带去重；形状不对的整条丢掉 */
function stringListMap(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, list] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const clean = [...new Set(list.filter((x): x is string => typeof x === "string" && x !== ""))];
    if (clean.length > 0) out[key] = clean;
  }
  return out;
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && v !== "") out[key] = v;
  }
  return out;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((x): x is string => typeof x === "string" && x !== ""))];
}

/** 标签元数据：`{ "客户稿": { color: "blue", group: "客户" } }`，两个字段都可缺省 */
function tagMetaMap(value: unknown): Record<string, TagMetaEntry> {
  const out: Record<string, TagMetaEntry> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [name, v] of Object.entries(value as Record<string, unknown>)) {
    if (!name || !v || typeof v !== "object" || Array.isArray(v)) continue;
    const rec = v as Record<string, unknown>;
    const color = typeof rec.color === "string" && rec.color ? rec.color : undefined;
    const group = typeof rec.group === "string" && rec.group ? rec.group : undefined;
    if (color || group) out[name] = { ...(color ? { color } : {}), ...(group ? { group } : {}) };
  }
  return out;
}

/** 标签分组：按名字去重（重名保留第一个），空名丢掉 */
function tagGroupList(value: unknown): TagGroupEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: TagGroupEntry[] = [];
  for (const v of value) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const rec = v as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const color = typeof rec.color === "string" && rec.color ? rec.color : undefined;
    out.push(color ? { name, color } : { name });
  }
  return out;
}

export type CurationParse =
  | { ok: true; data: CurationData }
  | { ok: false; reason: "notAnExport" | "isSnapshot" };

/**
 * 后缀辅助判定（大小写都认）。**只给文件对话框 / UI 用，导入判定一律走内容嗅探**：
 * 用户把 `.P-FontManager` 改成 `.dat` 或 `.S-FontManager` 都不该影响导入结果。
 */
export const isPackPath = (path: string) => isOurSuffix(path);

/**
 * 整理数据的文件内容（「仅导出整理数据」和「整包」共用同一份 schema，
 * 这样整包里的 json 和单独导出的 json 可以互相顶替，导入端只有一条解析路径）。
 */
export function curationFile(data: CurationData, exportedAt: string) {
  return {
    ...fileDescription("curation"),
    version: CURATION_VERSION,
    exportedAt,
    ...data,
  };
}

/**
 * 解析导入文件。**按内容认，不按 `app` 字段、更不按文件后缀**：
 * 老版本（version 1）没有 `kind`、改名前的备份 `app` 是别的字符串、用户把后缀改了，
 * 这些情况都不能变成「不认识的格式」。快照文件仍要拦下来并指引到「快照」那一行。
 */
export function parseCuration(raw: unknown): CurationParse {
  const kind = detectJsonKind(raw);
  if (kind === "snapshots") return { ok: false, reason: "isSnapshot" };
  if (kind !== "curation") return { ok: false, reason: "notAnExport" };
  const d = raw as Record<string, unknown>;
  return {
    ok: true,
    data: {
      tags: stringListMap(d.tags),
      collections: stringListMap(d.collections),
      collectionFaces: stringListMap(d.collectionFaces),
      favorites: stringList(d.favorites),
      notes: stringMap(d.notes),
      copyrightStatus: stringMap(d.copyrightStatus),
      copyrightExpiry: stringMap(d.copyrightExpiry),
      ratings: normalizeRatings(d.ratings),
      tagMeta: tagMetaMap(d.tagMeta),
      tagGroups: tagGroupList(d.tagGroups),
      tagExpiry: stringMap(d.tagExpiry),
    },
  };
}

/**
 * 导出作用域：**当前字体库**里真实存在的字族与字面。
 *
 * 为什么要它：`state.json` 里的标签/备注/分组是全机器共用的一份，但「导出库数据」导的是
 * **这一个字体库**。用户的机器上可能有多个库地址（`libraryDirs` 最多 3 个），
 * 全量导出会把别的库、以及只在监视文件夹里的字体数据一起塞进包里 ——
 * 换台机器导入后就会长出一批本库根本没有的族名，看着像幽灵标签。
 */
export interface CurationScope {
  families: ReadonlySet<string>;
  faceKeys: ReadonlySet<string>;
}

/** 按作用域裁剪一份整理数据（不做深拷贝，返回新对象；没命中的条目直接丢掉） */
export function scopeCuration(data: CurationData, scope: CurationScope): CurationData {
  const byFamily = <T>(map: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(map)) if (scope.families.has(k)) out[k] = v;
    return out;
  };

  const tags = byFamily(data.tags);

  const collections: Record<string, string[]> = {};
  for (const [name, members] of Object.entries(data.collections)) {
    const kept = members.filter((m) => scope.families.has(m));
    if (kept.length > 0) collections[name] = kept;
  }
  const collectionFaces: Record<string, string[]> = {};
  for (const [name, keys] of Object.entries(data.collectionFaces)) {
    const kept = keys.filter((k) => scope.faceKeys.has(k));
    if (kept.length > 0) collectionFaces[name] = kept;
  }

  // 标签的颜色 / 分组 / 到期日都按**标签名**挂，所以只保留裁完之后还在用的那些标签
  const liveTags = new Set(Object.values(tags).flat());
  const tagMeta: Record<string, TagMetaEntry> = {};
  for (const [name, meta] of Object.entries(data.tagMeta)) {
    if (liveTags.has(name)) tagMeta[name] = meta;
  }
  const tagExpiry: Record<string, string> = {};
  for (const [name, date] of Object.entries(data.tagExpiry)) {
    if (liveTags.has(name)) tagExpiry[name] = date;
  }
  // 分组只保留「还有标签在里面」的组；本条库里一个标签都没用到的组不导出
  const usedGroups = new Set(Object.values(tagMeta).map((m) => m.group ?? "").filter(Boolean));
  const tagGroups = data.tagGroups.filter((g) => usedGroups.has(g.name));

  return {
    tags,
    collections,
    collectionFaces,
    favorites: data.favorites.filter((f) => scope.families.has(f)),
    notes: byFamily(data.notes),
    copyrightStatus: byFamily(data.copyrightStatus),
    copyrightExpiry: byFamily(data.copyrightExpiry),
    ratings: byFamily(data.ratings),
    tagMeta,
    tagGroups,
    tagExpiry,
  };
}

/**
 * 导出进包里 / 文件里的**条目统计**（给用户看「到底导了些什么」）。
 * 只统计非空项，全为 0 的维度不列出。
 */
export function curationSummary(data: CurationData): { key: string; count: number }[] {
  const fams = (m: Record<string, unknown>) => Object.keys(m).length;
  const rows = [
    { key: "tags", count: Object.values(data.tags).reduce((n, l) => n + l.length, 0) },
    { key: "tagMeta", count: fams(data.tagMeta) },
    { key: "tagGroups", count: data.tagGroups.length },
    { key: "tagExpiry", count: fams(data.tagExpiry) },
    { key: "collections", count: fams(data.collections) + fams(data.collectionFaces) },
    { key: "favorites", count: data.favorites.length },
    { key: "ratings", count: fams(data.ratings) },
    { key: "notes", count: fams(data.notes) },
    { key: "copyright", count: fams(data.copyrightStatus) + fams(data.copyrightExpiry) },
  ];
  return rows.filter((r) => r.count > 0);
}

export interface CurationMergeResult extends CurationData {
  /** 本次真正补进去的条目数（toast 里的「合并 N 项」，按族/组算） */
  touched: number;
  /** 需要逐族落盘的新增标签 */
  addedTags: Record<string, string[]>;
  /** 需要逐族落盘的新增收藏 */
  addedFavorites: string[];
  /** 需要逐族落盘的新备注 */
  addedNotes: Record<string, string>;
  /** 成员有变化、需要写回后端的组（字族级） */
  changedCollections: Record<string, string[]>;
  /** 成员有变化、需要写回 prefs 的组（字重级；不能和字族级混着写，后端只认字族名） */
  changedCollectionFaces: Record<string, string[]>;
  /** 手写版权状态被采用（补空缺）的族 */
  adoptedCopyright: string[];
  /** 到期日期被采用（补空缺）的族 */
  adoptedExpiry: string[];
  /** 评分被采用（补空缺）的族（写回 prefs 用） */
  adoptedRatings: string[];
  /** 标签到期日被采用（补空缺）的标签名 */
  adoptedTagExpiry: string[];
  /** 标签颜色 / 分组被采用（补空缺）的标签名 */
  adoptedTagMeta: string[];
  /** 新建出来的标签分组名 */
  addedTagGroups: string[];
}

/** 并集：本地已有的不删，只把导入里多出来的补上 */
function unionLists(
  local: Record<string, string[]>,
  incoming: Record<string, string[]>,
): { next: Record<string, string[]>; added: Record<string, string[]> } {
  const next: Record<string, string[]> = { ...local };
  const added: Record<string, string[]> = {};
  for (const [key, list] of Object.entries(incoming)) {
    const current = next[key] ?? [];
    const fresh = list.filter((x) => !current.includes(x));
    if (fresh.length === 0) continue;
    next[key] = [...current, ...fresh];
    added[key] = fresh;
  }
  return { next, added };
}

/** 补空缺：本地没有这条才采用导入值 */
function fillGaps(
  local: Record<string, string>,
  incoming: Record<string, string>,
): { next: Record<string, string>; adopted: string[] } {
  const next = { ...local };
  const adopted: string[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (next[key] !== undefined) continue;
    next[key] = value;
    adopted.push(key);
  }
  return { next, adopted };
}

/**
 * 标签元数据补空缺（**按字段**，不是按条目）：
 * 本地已有 `color` 而只缺 `group` 时，导入应该只补 group ——
 * 按条目整条跳过会让「换台机器后颜色对了但分组全丢」。
 */
function fillMetaGaps(
  local: Record<string, TagMetaEntry>,
  incoming: Record<string, TagMetaEntry>,
): { next: Record<string, TagMetaEntry>; adopted: string[] } {
  const next: Record<string, TagMetaEntry> = { ...local };
  const adopted: string[] = [];
  for (const [name, meta] of Object.entries(incoming)) {
    const cur = next[name] ?? {};
    const merged: TagMetaEntry = { ...cur };
    let touched = false;
    if (merged.color === undefined && meta.color !== undefined) {
      merged.color = meta.color;
      touched = true;
    }
    if (merged.group === undefined && meta.group !== undefined) {
      merged.group = meta.group;
      touched = true;
    }
    if (!touched) continue;
    next[name] = merged;
    adopted.push(name);
  }
  return { next, adopted };
}

/** 分组：本地顺序优先，导入里多出来的追加在后面；同名组只补颜色 */
function mergeGroups(
  local: TagGroupEntry[],
  incoming: TagGroupEntry[],
): { next: TagGroupEntry[]; added: string[] } {
  const next = local.map((g) => ({ ...g }));
  const byName = new Map(next.map((g) => [g.name, g] as const));
  const added: string[] = [];
  for (const g of incoming) {
    const cur = byName.get(g.name);
    if (!cur) {
      const fresh = { ...g };
      next.push(fresh);
      byName.set(fresh.name, fresh);
      added.push(fresh.name);
    } else if (cur.color === undefined && g.color !== undefined) {
      cur.color = g.color;
    }
  }
  return { next, added };
}

export function mergeCuration(local: CurationData, incoming: CurationData): CurationMergeResult {
  const tags = unionLists(local.tags, incoming.tags);
  const collections = unionLists(local.collections, incoming.collections);
  const collectionFaces = unionLists(local.collectionFaces, incoming.collectionFaces);
  const notes = fillGaps(local.notes, incoming.notes);
  const status = fillGaps(local.copyrightStatus, incoming.copyrightStatus);
  const expiry = fillGaps(local.copyrightExpiry, incoming.copyrightExpiry);
  const tagExpiry = fillGaps(local.tagExpiry, incoming.tagExpiry);
  const tagMeta = fillMetaGaps(local.tagMeta, incoming.tagMeta);
  const tagGroups = mergeGroups(local.tagGroups, incoming.tagGroups);
  // 评分和版权一个口径：本机改过的星级不该被一份旧备份冲掉，导入只补空缺。
  const ratingsIn: Record<string, string> = {};
  for (const [k, v] of Object.entries(incoming.ratings)) ratingsIn[k] = String(v);
  const ratingsLocal: Record<string, string> = {};
  for (const [k, v] of Object.entries(local.ratings)) ratingsLocal[k] = String(v);
  const ratings = fillGaps(ratingsLocal, ratingsIn);

  const addedFavorites = incoming.favorites.filter((f) => !local.favorites.includes(f));

  const touched =
    Object.keys(tags.added).length +
    Object.keys(collections.added).length +
    Object.keys(collectionFaces.added).length +
    addedFavorites.length +
    notes.adopted.length +
    status.adopted.length +
    expiry.adopted.length +
    ratings.adopted.length +
    tagExpiry.adopted.length +
    tagMeta.adopted.length +
    tagGroups.added.length;

  return {
    tags: tags.next,
    collections: collections.next,
    collectionFaces: collectionFaces.next,
    favorites: [...local.favorites, ...addedFavorites],
    notes: notes.next,
    copyrightStatus: status.next,
    copyrightExpiry: expiry.next,
    ratings: Object.fromEntries(
      Object.entries(ratings.next).map(([k, v]) => [k, Number(v)]),
    ),
    tagMeta: tagMeta.next,
    tagGroups: tagGroups.next,
    tagExpiry: tagExpiry.next,
    touched,
    addedTags: tags.added,
    addedFavorites,
    addedNotes: Object.fromEntries(notes.adopted.map((k) => [k, notes.next[k]])),
    changedCollections: collections.added,
    changedCollectionFaces: collectionFaces.added,
    adoptedCopyright: status.adopted,
    adoptedExpiry: expiry.adopted,
    adoptedRatings: ratings.adopted,
    adoptedTagExpiry: tagExpiry.adopted,
    adoptedTagMeta: tagMeta.adopted,
    addedTagGroups: tagGroups.added,
  };
}
