/**
 * 自动标签（派生标签）引擎 —— 纯函数，无副作用、不写盘、不读文件。
 *
 * 定位：在**一级分类主链之外**加一层旁路，用「族名/本地化名 + PANOSE + sFamilyClass」
 * 三源弱证据推出**现有筛选器覆盖不到的维度**（中文书体、装饰工艺、形态、Vox 子类、轴能力），
 * 产出带来源与理由的标签，供筛选与搜索使用。
 *
 * 三条不可动摇的约束（改代码前先读）：
 *
 * 1. **不写用户数据**。这里只算「运行时有效标签」，写 `state.json` 的 `tags` 永远只有用户手工打的。
 *    标签到期、整包导入导出、font-sync 同步全都基于真实 tags —— 把推断写进去等于把猜测伪装成事实，
 *    而且规则一改就得写迁移脚本清历史脏标签。
 * 2. **手工优先，且用户否决永不复发**。`opts.manualTags` 里的标签一律不覆盖、不重复；
 *    `opts.denied` 里的标签一律不产。更强的一条在下面 `EXCLUSIVE_NAMESPACES`：
 *    用户给某族手工打了 `cn:kai`，该族就**不再**从词表推任何 `cn:*`。
 *    （用户 2026-11-14 明确要求：手动改过的标签不允许被软件自己那套再盖回去。）
 * 3. **宁可少给，不要给错**。置信度 < 0.65 直接丢弃（连建议都不出）。中文字体的
 *    PANOSE / sFamilyClass 是模板垃圾（实测 61.9% 填「拉丁文本」、41.7% 的 bProportion 填 9），
 *    所以凡是依赖这两个字节的规则，对中日韩族一律关闭或降级 —— 见每条规则的 `cjk` 注释。
 */

import { createBoundedMap } from "./boundedMap.ts";
import {
  CLASS_TAGS,
  CN_STYLES,
  DECOR_WORDS,
  EXCLUSIVE_NAMESPACES,
  USE_WORDS,
  VOX_BY_CLASS,
  WIDTH_WORDS,
  namespaceOf,
} from "./tagVocabulary.ts";

export type Classification = "serif" | "sans" | "mono" | "display" | "script" | "unknown";

/**
 * 规则能看到的全部事实。**全部来自扫描产物**，没有一项需要重新读字体文件。
 *
 * 注意 `name` 必须是**字体自报的族名**（`Family.name`），不能是字体库目录名 ——
 * 目录名带 `（未知版权）` 这类软件自己写的后缀，拿它判中文会让 100% 的族都变成「中文」
 * （同事的原型第一版就是这么翻车的）。
 */
export interface FamilyFacts {
  name: string;
  /** name 表里的本地化族名。中文字体的中文名常常只写在这里，族名本身是拼音 */
  localizedNames?: readonly string[];
  /** 该族所有字面的样式名（Regular / Bold / Condensed …），宽度判定比 PANOSE 可信 */
  styles?: readonly string[];
  classification: Classification;
  scripts: readonly string[];
  features: readonly string[];
  isVariable: boolean;
  axes: readonly string[];
  monospaced: boolean;
  weights: readonly number[];
  italic: boolean;
  /** OS/2 PANOSE 十字节；全 0 / 全 1 已被后端过滤成 null */
  panose?: readonly number[] | null;
  /** OS/2 sFamilyClass 原始 16 位值（高位 classId） */
  sFamilyClass?: number | null;
}

export interface DerivedTag {
  tag: string;
  confidence: number;
  /** 证据来源（字段名），UI 上回答「凭什么给我这个标签」 */
  source: string;
  reason: string;
  state: "applied" | "suggested";
}

export interface DeriveOptions {
  /** 该族**真实**（用户手工）标签。派生不得覆盖、不得重复，且互斥命名空间整段让位 */
  manualTags?: readonly string[];
  /** 用户已经否决过的派生标签（按族记录，见 prefs.autoTagDenied） */
  denied?: readonly string[];
  appliedThreshold?: number;
  suggestThreshold?: number;
}

const DEFAULT_APPLIED = 0.85;
const DEFAULT_SUGGESTED = 0.65;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** 命名空间小写化；用户手工标签可能是中文，比较时大小写不敏感但显示保持原样 */
export function normalizeTag(raw: string): string {
  const t = (raw ?? "").trim();
  if (!t) return "";
  const i = t.indexOf(":");
  if (i < 0) return t.toLowerCase();
  return `${t.slice(0, i).trim().toLowerCase()}:${t.slice(i + 1).trim().toLowerCase()}`;
}

// ─────────────────────────── 匹配工具 ───────────────────────────

const latinRegCache = new Map<string, RegExp>();

/** 拉丁词按词边界匹配：`mono` 不能命中 `monotype`、`song` 不能命中 `songbird` */
function latinWordReg(word: string): RegExp {
  let re = latinRegCache.get(word);
  if (!re) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`);
    latinRegCache.set(word, re);
  }
  return re;
}

const ASCII_RE = /^[\x20-\x7e]+$/;

/**
 * 把一段文本整理成可匹配的样子：CamelCase 拆开、转小写。
 *
 * 拆开是必需的 —— 字族名里大量出现 `StencilStd`、`NeonShadow`、`KaiTi` 这种紧凑写法，
 * 不拆的话词边界规则一个都命中不了（而中文按「包含」匹配，拆不拆都一样）。
 */
function foldText(raw: string): string {
  // 两步拆：先拆「缩写 + 词首」（FZSong → FZ Song），再拆「小写/数字 + 大写」（SongTi → Song Ti）。
  // 只做第二步的话 `FZSongTi` 会变成 `fzsong ti`，`song` 前面粘着字母，词边界规则命中不了 ——
  // 而这批国产字体（方正 FZ*、汉仪 HY*）恰恰是这种紧凑命名。
  return raw
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

interface Ctx {
  f: FamilyFacts;
  /** 族名 + 本地化名 + 样式名，已折叠 */
  hay: string;
  /** 只有本地化名 + 样式名（不含族名）。命中这里说明「原生中文名/样式名里就这么写的」 */
  localHay: string;
  isCjk: boolean;
  panose: readonly number[] | null;
  classId: number | null;
  subId: number | null;
}

function wordIn(hay: string, word: string): boolean {
  if (!hay || !word) return false;
  const w = word.toLowerCase();
  if (!ASCII_RE.test(w)) return hay.includes(w); // 中文/假名：没有词边界这回事
  return latinWordReg(w).test(hay);
}

const anyIn = (hay: string, words: readonly string[]): boolean => words.some((w) => wordIn(hay, w));

const hasFeature = (f: FamilyFacts, names: readonly string[]): boolean =>
  f.features.some((x) => names.includes(x.toLowerCase()));

const hasAxis = (f: FamilyFacts, axis: string): boolean =>
  f.axes.some((x) => x.toLowerCase() === axis);

function makeCtx(f: FamilyFacts): Ctx {
  const locals = f.localizedNames ?? [];
  const styles = f.styles ?? [];
  const hay = foldText([f.name, ...locals, ...styles].join(" \u0000 "));
  const localHay = foldText([...locals, ...styles].join(" \u0000 "));
  const scripts = f.scripts ?? [];
  const isCjk = scripts.some((s) => s === "han" || s === "kana" || s === "hangul");
  const panose = f.panose && f.panose.length >= 10 ? f.panose : null;
  // PANOSE 的闸门：全 0（Any）/ 全 1（No Fit）等于没填。后端已经滤过一次，这里再兜一层，
  // 因为事实也可能来自旧缓存或单测构造。
  const usable = panose !== null && panose.some((b) => b > 1);
  const sfc = f.sFamilyClass ?? 0;
  return {
    f,
    hay,
    localHay,
    isCjk,
    panose: usable ? panose : null,
    classId: sfc > 0 ? sfc >> 8 : null,
    subId: sfc > 0 ? sfc & 0xff : null,
  };
}

// ─────────────────────────── 规则 ───────────────────────────

type Rule = (ctx: Ctx) => { tag: string; confidence: number; source: string; reason: string } | null;

/**
 * 一级分类 → `class:*`。置信度给到 0.95：这不是猜的，是 `familyClassification()`
 * 把族内全部字面放在一起判出来的结论（用户以前在筛选菜单里看到的就是它）。
 * `unknown` 不产标签 —— 与其挂一个「未知」，不如什么都不挂。
 */
const classRule: Rule = (ctx) => {
  const tag = CLASS_TAGS[ctx.f.classification];
  if (!tag) return null;
  return {
    tag,
    confidence: 0.95,
    source: "classification",
    reason: "一级分类（族内全部字面联合判定）",
  };
};

/** 中文书体：互斥、按 CN_STYLES 顺序先命中者胜，只产一个 */
const cnRules: Rule = (ctx) => {
  if (!ctx.isCjk) return null;
  for (const entry of CN_STYLES) {
    const hitLocal = anyIn(ctx.localHay, entry.words);
    if (!hitLocal && !anyIn(ctx.hay, entry.words)) continue;
    // 原生中文名/中文样式名里写明的书体比拼音转写（Songti / Heiti）更可信
    const base = entry.value === "cn:meishu" ? 0.86 : 0.9;
    return {
      tag: entry.value,
      confidence: hitLocal ? base + 0.02 : base,
      source: hitLocal ? "localizedName" : "name",
      reason: hitLocal ? "族的中文名 / 样式名里写明了书体" : "族名的罗马字写法对应这种书体",
    };
  }
  return null;
};

const decorRules: Rule[] = DECOR_WORDS.map((entry) => (ctx) => {
  // 圆体在中西文里不是一回事：西文 Rounded 是「圆角无衬线」，中文圆体是独立书体
  // （中文那一路由 cn:yuan 负责，这里不再重复产出）
  if (entry.value === "decor:rounded" && ctx.isCjk) return null;
  if (!anyIn(ctx.hay, entry.words)) return null;
  return {
    tag: entry.value,
    confidence: entry.value === "decor:layered" ? 0.86 : 0.88,
    source: "name",
    reason: "族名 / 样式名里写明了这种装饰工艺",
  };
});

/** PANOSE 形态：只有通过闸门（≥10 字节、非全 0/1）才走到这里 */
const panoseRules: Rule[] = [
  // 中日韩的 familyKind 61.9% 被填成「拉丁文本」，直接拿来判会全线误标。
  // 早先这里还有「PANOSE 判为非衬线体时补 form:display / form:script」两条，
  // 2.1.7 起删掉：一级分类已经以 `class:display` / `class:script` 的形式变成可编辑标签，
  // 同一个判断再来一条英文别名只会让标签云多一堆同义词。
  (ctx) =>
    (ctx.panose?.[2] ?? 0) >= 9
      ? {
          tag: "form:heavy",
          confidence: 0.88,
          source: "panose.weight",
          reason: "PANOSE 字重偏向很重（≥9）",
        }
      : null,
  (ctx) =>
    (ctx.panose?.[4] ?? 0) >= 8
      ? {
          tag: "form:high-contrast",
          confidence: 0.87,
          source: "panose.contrast",
          reason: "PANOSE 笔画对比度很高",
        }
      : null,
  // 原来这里有一条 `tech:monospaced`（PANOSE bProportion = 9）。删掉的理由同上：
  // 等宽已经是 `class:mono`，而且中文 bProportion 41.7% 填 9 是天然等宽假象。
  // 下面三条是「模板默认值重灾区」：实测未降级时 form:condensed 一次给 835 族、
  // form:low-contrast 给 577 族 —— 这个量级本身就是假信号警报，所以只进建议档
  (ctx) =>
    !ctx.isCjk && [2, 3, 4].includes(ctx.panose?.[3] ?? 0)
      ? {
          tag: "form:condensed",
          confidence: 0.78,
          source: "panose.proportion",
          reason: "PANOSE 比例偏窄（模板默认值多，建议人工确认）",
        }
      : null,
  (ctx) =>
    !ctx.isCjk && [6, 7, 8].includes(ctx.panose?.[3] ?? 0)
      ? {
          tag: "form:extended",
          confidence: 0.78,
          source: "panose.proportion",
          reason: "PANOSE 比例偏宽（模板默认值多，建议人工确认）",
        }
      : null,
  (ctx) =>
    (ctx.panose?.[9] ?? 0) >= 5
      ? {
          tag: "form:large-xheight",
          confidence: 0.78,
          source: "panose.xHeight",
          reason: "PANOSE x-height 偏大（模板默认值多，建议人工确认）",
        }
      : null,
  (ctx) => {
    const c = ctx.panose?.[4];
    return c === 2 || c === 3
      ? {
          tag: "form:low-contrast",
          confidence: 0.78,
          source: "panose.contrast",
          reason: "PANOSE 对比度偏低（模板默认值多，建议人工确认）",
        }
      : null;
  },
];

/** 样式名判定宽度：比 PANOSE 的 bProportion 可信得多，所以能自动生效 */
const widthRules: Rule[] = [
  (ctx) =>
    anyIn(ctx.hay, WIDTH_WORDS.condensed)
      ? {
          tag: "form:condensed",
          confidence: 0.9,
          source: "styleName",
          reason: "样式名里写明 Condensed / Narrow",
        }
      : null,
  (ctx) =>
    anyIn(ctx.hay, WIDTH_WORDS.extended)
      ? {
          tag: "form:extended",
          confidence: 0.9,
          source: "styleName",
          reason: "样式名里写明 Extended / Expanded",
        }
      : null,
];

const techRules: Rule[] = [
  (ctx) =>
    ctx.f.isVariable && hasAxis(ctx.f, "wght")
      ? { tag: "tech:weight-axis", confidence: 0.97, source: "axes", reason: "fvar 含 wght 轴" }
      : null,
  (ctx) =>
    ctx.f.isVariable && hasAxis(ctx.f, "wdth")
      ? { tag: "tech:width-axis", confidence: 0.97, source: "axes", reason: "fvar 含 wdth 轴" }
      : null,
  (ctx) =>
    ctx.f.isVariable && hasAxis(ctx.f, "opsz")
      ? { tag: "tech:optical-size", confidence: 0.95, source: "axes", reason: "fvar 含 opsz 轴" }
      : null,
  (ctx) =>
    hasFeature(ctx.f, ["smcp", "c2sc"])
      ? { tag: "tech:small-caps", confidence: 0.93, source: "features", reason: "含 smcp / c2sc 小型大写" }
      : null,
  (ctx) =>
    hasFeature(ctx.f, ["tnum"])
      ? { tag: "tech:tabular-figures", confidence: 0.93, source: "features", reason: "含 tnum 等宽数字" }
      : null,
  (ctx) =>
    hasFeature(ctx.f, ["onum"])
      ? { tag: "tech:oldstyle-figures", confidence: 0.93, source: "features", reason: "含 onum 旧体数字" }
      : null,
  (ctx) =>
    hasFeature(ctx.f, ["swsh", "salt"])
      ? { tag: "tech:swash", confidence: 0.88, source: "features", reason: "含 swsh / salt 花饰" }
      : null,
  // 中文字体 is_monospaced() 恒为真（每个汉字字身一样宽），所以这条对中文彻底关掉
  (ctx) =>
    !ctx.isCjk && ctx.f.monospaced && ctx.f.classification !== "mono" && !wordIn(ctx.hay, "monotype")
      ? {
          tag: "tech:monospaced-candidate",
          confidence: 0.7,
          source: "monospaced",
          reason: "几何等宽但一级分类不是等宽（Monotype 是字厂名，已排除）",
        }
      : null,
];

const useRules: Rule[] = [
  (ctx) => {
    if (ctx.f.classification !== "mono" || !anyIn(ctx.hay, USE_WORDS.code)) return null;
    // 置信度是**证据的函数**，不是拍脑袋常量：编程连字 / 带斜杠零 / 可变字重都加码
    let c = 0.76;
    if (hasFeature(ctx.f, ["liga", "dlig", "calt", "zero"])) c += 0.07;
    if (hasAxis(ctx.f, "wght")) c += 0.07;
    return {
      tag: "use:code",
      confidence: c,
      source: "classification+name+features+axes",
      reason: "等宽且名称含编程类词" + (c > 0.83 ? "，另有编程连字 / 可变字重佐证" : ""),
    };
  },
  (ctx) =>
    ctx.f.classification === "display" && anyIn(ctx.hay, USE_WORDS.poster)
      ? {
          tag: "use:poster",
          confidence: 0.76,
          source: "classification+name",
          reason: "展示体且名称含海报 / 标题类词",
        }
      : null,
  (ctx) =>
    ctx.f.classification === "display" && anyIn(ctx.hay, USE_WORDS.banner)
      ? { tag: "use:banner", confidence: 0.72, source: "classification+name", reason: "展示体且名称含广告 / 宣传类词" }
      : null,
];

const factRules: Rule[] = [
  (ctx) =>
    ctx.f.italic
      ? { tag: "style:italic", confidence: 0.9, source: "italic", reason: "族内含斜体字面" }
      : null,
  (ctx) =>
    ctx.f.weights.some((w) => w >= 700)
      ? { tag: "weight:has-bold", confidence: 0.9, source: "weights", reason: "族内含 weight ≥ 700 的字面" }
      : null,
];

/** Vox 子类：源自 sFamilyClass，但**只作附加标签**，不参与任何分类决策 */
const voxRule: Rule = (ctx) => {
  if (ctx.isCjk || ctx.classId === null || ctx.subId === null) return null;
  const tag = VOX_BY_CLASS[`${ctx.classId}/${ctx.subId}`];
  if (!tag) return null;
  return {
    tag,
    confidence: 0.86,
    source: "sFamilyClass",
    reason: `OS/2 sFamilyClass = ${ctx.classId}/${ctx.subId}`,
  };
};

const RULES: readonly Rule[] = [
  classRule,
  cnRules,
  voxRule,
  ...decorRules,
  ...widthRules, // 宽度先于 PANOSE：样式名优先占位，PANOSE 那条自然被去重掉
  ...panoseRules,
  ...techRules,
  ...useRules,
  ...factRules,
];

// ─────────────────────────── 推导 ───────────────────────────

/** 只跑规则、不管手工标签与拒绝名单 —— 这部分只跟「字体事实」有关，可以按事实签名缓存 */
function rawDerive(ctx: Ctx): DerivedTag[] {
  const seen = new Set<string>();
  const out: DerivedTag[] = [];
  for (const rule of RULES) {
    let hit: ReturnType<Rule> = null;
    try {
      hit = rule(ctx);
    } catch {
      // 单条规则炸了不能让整个字库都没有标签
      hit = null;
    }
    if (!hit) continue;
    const tag = normalizeTag(hit.tag);
    if (!tag || seen.has(tag)) continue;
    const confidence = Math.round(clamp01(hit.confidence) * 100) / 100;
    if (confidence < DEFAULT_SUGGESTED) continue;
    seen.add(tag);
    out.push({
      tag,
      confidence,
      source: hit.source || "unknown",
      reason: hit.reason || "",
      state: confidence >= DEFAULT_APPLIED ? "applied" : "suggested",
    });
  }
  return out;
}

/**
 * 事实签名：只包含规则真正读到的字段。
 * 用它做缓存键，标签编辑（tags 变化）时不必重跑 4000 个族的正则。
 */
function factsKey(f: FamilyFacts): string {
  return [
    f.name,
    f.classification,
    (f.scripts ?? []).join(","),
    (f.features ?? []).join(","),
    (f.axes ?? []).join(","),
    f.isVariable ? 1 : 0,
    f.monospaced ? 1 : 0,
    f.italic ? 1 : 0,
    (f.weights ?? []).join(","),
    f.panose ? f.panose.join("") : "",
    f.sFamilyClass ?? "",
    (f.localizedNames ?? []).join(","),
    (f.styles ?? []).join(","),
  ].join("\u0001");
}

let rawCache = createBoundedMap<string, DerivedTag[]>(16000);

/**
 * 事实缓存的命中 / 未命中计数。
 *
 * 为什么要有（QA 的负控实验）：以前那条「4000 族全量推导」的性能用例断言的是
 * 「第二轮耗时 < 首轮的一半」，它测的其实是 JIT 预热 —— 把缓存整个清空、每轮全部
 * 未命中，比值照样能到 0.2；反过来并行跑 40 多个测试文件时，负载一抖动又会偶发红。
 * 现在用例改成直接断言**命中数**：只要有缓存，第二轮就必须 `hits === 4000 && misses === 0`，
 * 既不受机器负载影响，又真的能测出「缓存没生效」。
 *
 * 成本：生产路径上每次 `deriveTags()` 只多一次整数自增，没有分配、没有分支外的新逻辑。
 */
let cacheHits = 0;
let cacheMisses = 0;

/** 纯函数：一个族 → 若干带证据的标签（含 suggested 档） */
export function deriveTags(f: FamilyFacts, opts: DeriveOptions = {}): DerivedTag[] {
  if (!f || !f.name) return [];
  const ctx = makeCtx(f);
  const key = factsKey(f);
  let raw = rawCache.get(key);
  if (!raw) {
    cacheMisses += 1;
    raw = rawDerive(ctx);
    rawCache.set(key, raw);
  } else {
    cacheHits += 1;
  }
  const appliedAt = opts.appliedThreshold ?? DEFAULT_APPLIED;
  const suggestAt = opts.suggestThreshold ?? DEFAULT_SUGGESTED;
  const manual = new Set((opts.manualTags ?? []).map(normalizeTag).filter(Boolean));
  const denied = new Set((opts.denied ?? []).map(normalizeTag).filter(Boolean));

  // 用户手工打过某个互斥命名空间的标签 → 该命名空间的自动标签整段让位。
  // 这是「手动改了标签，软件不许再用自己那套盖回去」的核心闸门。
  const blockedNs = new Set<string>();
  for (const t of manual) {
    const ns = namespaceOf(t);
    if (ns && EXCLUSIVE_NAMESPACES.has(ns)) blockedNs.add(ns);
  }

  const out: DerivedTag[] = [];
  for (const d of raw) {
    if (manual.has(d.tag) || denied.has(d.tag)) continue;
    const ns = namespaceOf(d.tag);
    if (ns && blockedNs.has(ns)) continue;
    if (d.confidence < suggestAt) continue;
    out.push({ ...d, state: d.confidence >= appliedAt ? "applied" : "suggested" });
  }
  return out.sort((a, b) => b.confidence - a.confidence || a.tag.localeCompare(b.tag));
}

/**
 * 参与筛选 / 搜索的「有效标签」= 手工 ⌈ 自动生效的派生标签。
 *
 * 只影响展示与筛选用到的那份对象，**绝不回写 store 的 tags 状态**。
 */
export function effectiveTags(
  manual: readonly string[],
  derived: readonly DerivedTag[],
  denied: readonly string[] = [],
): string[] {
  const deny = new Set(denied.map(normalizeTag));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of manual) {
    const n = normalizeTag(t);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(t);
    }
  }
  for (const d of derived) {
    if (d.state !== "applied" || deny.has(d.tag) || seen.has(d.tag)) continue;
    seen.add(d.tag);
    out.push(d.tag);
  }
  return out;
}

/** 对齐 fontStore 里 `tagFilter.every(...)` 的 AND 语义（额外保留 OR 扩展） */
export function matchTagFilter(
  tags: readonly string[],
  filter: readonly string[],
  mode: "and" | "or" = "and",
): boolean {
  if (filter.length === 0) return true;
  const set = new Set(tags.map(normalizeTag));
  const wanted = filter.map(normalizeTag).filter(Boolean);
  return mode === "and" ? wanted.every((t) => set.has(t)) : wanted.some((t) => set.has(t));
}

/** 用户点「接受」→ 固化成真实标签（幂等） */
export function pinTag(manual: readonly string[], tag: string): string[] {
  const n = normalizeTag(tag);
  if (!n) return [...manual];
  const out = [...manual];
  if (!out.some((t) => normalizeTag(t) === n)) out.push(tag);
  return out;
}

/** 用户点「不再建议」→ 记入该族的否决名单（幂等） */
export function rejectTag(denied: readonly string[], tag: string): string[] {
  const n = normalizeTag(tag);
  if (!n) return [...denied];
  const out = [...denied];
  if (!out.some((t) => normalizeTag(t) === n)) out.push(n);
  return out;
}

/**
 * 标签移除后的「否决」判定：用户从某族删掉了哪些**自动标签**。
 *
 * 只在被删的标签确实是该族的自动标签时才记 —— 手工标签被删不需要记，
 * 因为派生规则本来也产不出它。返回值可直接并进 `prefs.autoTagDenied[族名]`。
 */
export function removedAutoTags(
  before: readonly string[],
  after: readonly string[],
  derived: readonly DerivedTag[],
): string[] {
  const keep = new Set(after.map(normalizeTag));
  const auto = new Set(derived.map((d) => d.tag));
  return before
    .map(normalizeTag)
    .filter((t) => t && !keep.has(t) && auto.has(t));
}

/** 仅用于单测与调试：清掉事实缓存（不动命中计数） */
export function _clearDeriveCache(): void {
  rawCache = createBoundedMap<string, DerivedTag[]>(16000);
}

/**
 * 仅用于单测与调试：读事实缓存的命中 / 未命中计数。
 *
 * 生产代码不要用它做任何判断 —— 它只是把上面两个私有计数器读出来，
 * 让「缓存到底有没有生效」这件事可以被断言，而不是靠耗时比值去猜。
 * 只读快照，不重置。
 */
export function _deriveCacheStats(): { hits: number; misses: number } {
  return { hits: cacheHits, misses: cacheMisses };
}

/**
 * 仅用于单测与调试：把命中 / 未命中计数清零。
 *
 * 与 `_clearDeriveCache()` 分开，是因为两者常常要单独用：
 * 「清缓存 + 清计数」测冷启动，只清计数则测「已有缓存下这一轮有没有命中」。
 */
export function _resetDeriveCacheStats(): void {
  cacheHits = 0;
  cacheMisses = 0;
}
