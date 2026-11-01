/**
 * 字体族搜索的匹配规则（纯函数，便于单测）。
 *
 * 为什么单独抽出来：以前只在 store 里堆了一个 `||` 表达式，能搜什么全靠读那一段代码，
 * 改一处也没法回归。用户 2026-11-01 反馈「有些都搜索不到」——典型漏项是
 * **字重/样式名**（`Semibold`、`Italic`）、**PostScript 名**、**文件名**，
 * 以及**语言/分类/特性的中文名**（「中文」「衬线」「连字」）。
 *
 * 语义：
 *   - 查询按空白拆词，**每个词都要命中**（AND）。单关键词时与旧行为一致；
 *     `Neue Helvetica` 这种反序玩法也能出结果，`bold 中文` 会同时约束两件事。
 *   - 每个词可以命中任意字段：族名、样式、PostScript 名、文件名、本地化名、
 *     标签、格式、厂商、备注、授权/版权正文，以及语言/分类/特性的编码与本地化名。
 */
export interface SearchFace {
  style?: string | null;
  postscriptName?: string | null;
  path: string;
  localizedNames?: { name: string }[] | null;
}

export interface SearchableFamily {
  name: string;
  tags?: string[];
  formats?: string[];
  foundry?: string | null;
  license?: string | null;
  copyright?: string | null;
  scripts?: string[];
  features?: string[];
  classification?: string | null;
  faces: SearchFace[];
  /** 备注（store 里按族名单独存） */
  note?: string | null;
}

/** 编码 → 本地化文案（`script.han` → 「中文」）。缺省时空对象，只按编码匹配。 */
export interface LabelMaps {
  script?: Record<string, string>;
  classification?: Record<string, string>;
  feature?: Record<string, string>;
}

export function searchTokens(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** 路径只取文件名部分：`C:\Windows\Fonts\msyh.ttc` → `msyh.ttc` */
export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

export function familyMatches(
  f: SearchableFamily,
  tokens: string[],
  labels: LabelMaps = {},
): boolean {
  if (tokens.length === 0) return true;
  return tokens.every((tok) => matchesToken(f, tok, labels));
}

function matchesToken(f: SearchableFamily, q: string, labels: LabelMaps): boolean {
  if (f.name.toLowerCase().includes(q)) return true;
  if (f.tags?.some((t) => t.toLowerCase().includes(q))) return true;
  if (f.formats?.some((x) => x.toLowerCase().includes(q))) return true;
  if (f.foundry?.toLowerCase().includes(q)) return true;
  if (f.note?.toLowerCase().includes(q)) return true;
  if (f.license?.toLowerCase().includes(q)) return true;
  if (f.copyright?.toLowerCase().includes(q)) return true;

  // 语言 / 分类 / 特性：既有编码（latin、serif、liga），也有本地化名（拉丁文、衬线、连字）
  if (f.scripts?.some((s) => s.includes(q) || (labels.script?.[s] ?? "").toLowerCase().includes(q)))
    return true;
  if (
    f.classification &&
    (f.classification.includes(q) ||
      (labels.classification?.[f.classification] ?? "").toLowerCase().includes(q))
  )
    return true;
  if (
    f.features?.some(
      (x) => x.includes(q) || (labels.feature?.[x] ?? "").toLowerCase().includes(q),
    )
  )
    return true;

  const file = q;
  return (f.faces ?? []).some(
    (fc) =>
      (fc.style ?? "").toLowerCase().includes(file) ||
      (fc.postscriptName ?? "").toLowerCase().includes(file) ||
      fileNameOf(fc.path).includes(file) ||
      (fc.localizedNames ?? []).some((ln) => ln.name.toLowerCase().includes(file)),
  );
}
