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
}

export const CURATION_APP = "FontManager";
export const CURATION_KIND = "curation";
/** 1 = 只有标签/分组/收藏/备注；2 = 加字重级分组 + 手动版权 + 到期日期；
 *  3 = 加收藏评分（1~5 星）；4 = 文件内写入自描述头（用途 / 导入方式 / 推荐后缀）。
 *  数据 schema 没变，导入端 1~4 全认，缺项按空处理。 */
export const CURATION_VERSION = 4;

export const emptyCuration = (): CurationData => ({
  tags: {},
  collections: {},
  collectionFaces: {},
  favorites: [],
  notes: {},
  copyrightStatus: {},
  copyrightExpiry: {},
  ratings: {},
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
    },
  };
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

export function mergeCuration(local: CurationData, incoming: CurationData): CurationMergeResult {
  const tags = unionLists(local.tags, incoming.tags);
  const collections = unionLists(local.collections, incoming.collections);
  const collectionFaces = unionLists(local.collectionFaces, incoming.collectionFaces);
  const notes = fillGaps(local.notes, incoming.notes);
  const status = fillGaps(local.copyrightStatus, incoming.copyrightStatus);
  const expiry = fillGaps(local.copyrightExpiry, incoming.copyrightExpiry);
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
    ratings.adopted.length;

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
    touched,
    addedTags: tags.added,
    addedFavorites,
    addedNotes: Object.fromEntries(notes.adopted.map((k) => [k, notes.next[k]])),
    changedCollections: collections.added,
    changedCollectionFaces: collectionFaces.added,
    adoptedCopyright: status.adopted,
    adoptedExpiry: expiry.adopted,
    adoptedRatings: ratings.adopted,
  };
}
