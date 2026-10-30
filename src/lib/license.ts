export type LicenseClass = "open" | "personal" | "restrictive" | "unknown";

/**
 * 判定口径（与 src-tauri/src/copyright.rs 逐条对齐，别只改一边）：
 * **不能百分百确定就不下结论**。只有「许可证身份」或「明确写了商用／收费」才给结果，
 * 只写「免费」「freely available」「保留所有权利」的一律 unknown。
 *
 * 被删掉的旧规则（误判来源）：「免费」单字判 open、"ofl"/"gpl" 裸子串、只写 free 就算能商用。
 */

/** 许可证身份：这些许可证按条文本身允许商用 */
const OPEN_LICENSE_MARKERS = [
  "sil open font license",
  "open font license",
  "apache license",
  "mit license",
  "bsd license",
  "bsd 2-clause",
  "bsd 3-clause",
  "mozilla public license",
  "isc license",
  "zlib license",
  "wtfpl",
  "public domain",
  "cc0",
  "unlicense",
  "ubuntu font licence",
  "ubuntu font license",
  "gnu general public license",
  "arphic public license",
  "ipa font license",
];

/** 短标记需要词边界，避免 soflow / logo 误命中。[标记, 允许紧跟版本号数字] */
const OPEN_WORD_MARKERS: [string, boolean][] = [
  ["ofl", true],
  ["gpl", true],
  ["cc by", false],
];

/** 英文「明确允许商用」：`free for commercial or non-commercial use` 属于允许商用，
 *  必须先于 non-commercial 判定，否则会把「可以商用」判成「不许商用」。 */
const OPEN_EXPLICIT_EN = [
  "free for commercial",
  "commercial use is free",
  "commercial use: free",
  "free for any commercial",
];

/**
 * 中文「可商用」类声明（2026-10-30 起**严格整词**）：
 * 关键词必须完整连续出现，拆开一律不算（「免费商」不算、「免费」两个字也不算）。
 */
const OPEN_EXPLICIT_MARKERS = ["免费商用", "商用免费", "免费可商用", "可免费商用"];

/** 会被否定词吃掉的「可商用」类整词（「不可商用」不能算免费） */
const OPEN_EXPLICIT_GUARDED = ["可商用", "允许商用", "商用授权免费"];

/** 否定前缀：紧挨在关键词前面时这个词作废 */
const NEG_PREFIX = ["不", "非", "无", "免", "未", "勿", "禁"];

/** 「个人免费」整词（中文按原文匹配，不需要小写） */
const PERSONAL_EXACT = [
  "个人免费",
  "免费供个人",
  "个人版免费",
  "个人使用免费",
  "免费个人使用",
];

/**
 * 「个人使用免费、商用另购授权」的**英文**写法 → personal。
 * 中文的「不可商用 / 禁止商用 / 非商业使用」不在这里：2026-10-30 起归收费。
 */
const PERSONAL_ONLY_MARKERS = [
  "personal use only",
  "for personal use only",
  "personal use: free",
  "personal use is free",
  "non-commercial",
  "noncommercial",
  "not for commercial",
  "仅限个人",
  "仅供个人",
];

/** 收费关键词（严格整词，2026-10-30 用户给定） */
const PAID_EXACT = [
  "非免费字体",
  "非免费",
  "非商业字体",
  "非商业",
  "商用需授权",
  // 「企业授权」系（2026-10-30 用户口径）：出现即说明商用要另买授权
  "企业授权方案",
  "企业需授权",
  "企业授权",
  "商用需要授权",
  "商用需购买授权",
  "不可商用",
  "禁止商用",
  "收费",
  "付费",
];

/** 会被「无需 / 不需 / 免费」否定的收费词 */
const PAID_GUARDED = ["购买授权", "购买商业授权", "需授权", "商用授权"];

/** 英文的收费 / 试用表述 */
const PAID_MARKERS_EN = [
  "purchase a license",
  "purchase license",
  "requires a license",
  "buy the commercial license",
  "commercial license required",
  "evaluation only",
  "evaluation purposes",
  "trial version",
  "demo version",
  "shareware",
  "试用版",
  "演示版",
];

/** 与开源许可证身份直接冲突：同时出现说明这份文本也在讲收费 */
const HARD_CONFLICT = [
  "purchase a license",
  "requires a license",
  "购买授权",
  "需授权",
  "商用需授权",
  "不可商用",
  "禁止商用",
  "非免费",
  "非商业",
  "trial version",
  "demo version",
  "evaluation only",
  "收费",
  "付费",
];

/** 词边界匹配：前面不能是字母；后面按「是否允许版本号」判断（GPL2 / GPLv3 / OFL1.1） */
function containsWord(hay: string, word: string, allowDigit: boolean): boolean {
  let from = 0;
  for (;;) {
    const i = hay.indexOf(word, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : hay[i - 1];
    if (!/[a-z]/i.test(before) && boundaryOk(hay.slice(i + word.length), allowDigit)) {
      return true;
    }
    from = i + 1;
  }
}

function boundaryOk(rest: string, allowDigit: boolean): boolean {
  const c = rest[0];
  if (c === undefined) return true;
  if (/[0-9]/.test(c)) return allowDigit;
  if (/[a-z]/i.test(c)) {
    if (!allowDigit || (c !== "v" && c !== "V")) return false;
    const d = rest[1];
    return d === undefined || !/[a-z]/i.test(d);
  }
  return true; // 标点、空格、中文等一律视为边界
}

function hasAny(hay: string, markers: string[]): boolean {
  return markers.some((m) => hay.includes(m));
}

/**
 * 整词命中 + 否定前缀检查（与 Rust `copyright.rs::guarded_hit` 同义）：
 * 关键词必须完整连续出现，且正前方不能紧挨否定字。
 * 「不可商用」是收费词、「可商用」才是免费声明 —— 只靠 includes 会把前者误判成后者。
 */
function guardedHit(hay: string, keys: string[], deny: string[]): string | null {
  for (const k of keys) {
    let from = 0;
    for (;;) {
      const i = hay.indexOf(k, from);
      if (i < 0) break;
      const prev = i === 0 ? "" : hay[i - 1];
      if (!deny.includes(prev)) return k;
      from = i + 1;
    }
  }
  return null;
}

export function classifyLicense(text: string | null): LicenseClass {
  if (!text) return "unknown";
  const t = text.toLowerCase();

  // ① 许可证身份（同段落里又要收费 → 不猜）
  const identity =
    hasAny(t, OPEN_LICENSE_MARKERS) ||
    OPEN_WORD_MARKERS.some(([w, digit]) => containsWord(t, w, digit));
  if (identity) {
    return hasAny(t, HARD_CONFLICT) ? "unknown" : "open";
  }
  // ①b 英文明确允许商用
  if (hasAny(t, OPEN_EXPLICIT_EN)) return "open";
  // ② 免费商用（严格整词；「可商用」要被否定前缀检查拦住）——最干净的结论，先判
  if (hasAny(t, OPEN_EXPLICIT_MARKERS) || guardedHit(t, OPEN_EXPLICIT_GUARDED, NEG_PREFIX)) {
    return "open";
  }
  // ③ 明确标注「个人免费 / personal use」→ personal（即使同时说「商用需授权 / 不可商用」）
  //    2026-10-30 口径：能不能算个人免费，只看有没有明确标注；没标注的一律收费。
  //    所以这一步必须先于收费关键词。
  if (PERSONAL_EXACT.some((m) => text.includes(m))) return "personal";
  if (hasAny(t, PERSONAL_ONLY_MARKERS)) return "personal";
  // ④ 收费关键词（严格整词）
  if (
    hasAny(t, PAID_EXACT) ||
    guardedHit(t, PAID_GUARDED, NEG_PREFIX) !== null ||
    hasAny(t, PAID_MARKERS_EN)
  ) {
    return "restrictive";
  }
  return "unknown";
}

/**
 * 版权状态：
 *   free_commercial = 商用免费（OFL / 公有领域 / 明确写「可商用」）
 *   free_personal   = 个人免费（免费，但授权只覆盖个人 / 非商业用途）
 *   paid            = 收费
 *   timelimited     = 版权有时间限制
 *   unknown         = 未知
 *
 * 旧版本只有一个 "free"，读老数据时统一按「商用免费」处理（见 normalizeCopyright）。
 */
export type CopyrightClass =
  | "free_commercial"
  | "free_personal"
  | "paid"
  | "timelimited"
  | "unknown";

/** 把历史值（"free"）和别名归一成新的分类键；认不出来返回 null */
export function normalizeCopyright(value: string | null | undefined): CopyrightClass | null {
  switch ((value ?? "").trim()) {
    case "free":
    case "commercial":
    case "free_commercial":
    case "freeCommercial":
      return "free_commercial";
    case "personal":
    case "free_personal":
    case "freePersonal":
      return "free_personal";
    case "paid":
      return "paid";
    case "timelimited":
    case "timeLimited":
    case "time_limited":
      return "timelimited";
    case "unknown":
      return "unknown";
    default:
      return null;
  }
}

/**
 * 计算字族的实际版权分类，权重：
 *   1. 用户手动设置（含显式的"未知"）
 *   2. 字体自带的版权信息（name 表里的 license）
 *   3. 文件夹备注 / 版权信息文件判定的版权（dirClass，由后端扫描时带出来）
 * 手动设为"自动识别"时按 2 → 3 的顺序判定。
 */
export function effectiveCopyrightClass(
  license: string | null,
  override?: string,
  dirClass?: string | null,
): CopyrightClass {
  const fromOverride = normalizeCopyright(override);
  if (fromOverride) return fromOverride;
  const cls = classifyLicense(license);
  if (cls === "open") return "free_commercial";
  if (cls === "personal") return "free_personal";
  if (cls === "restrictive") return "paid";
  return normalizeCopyright(dirClass) ?? "unknown";
}

/**
 * 判断时间限制版权是否已到期。
 * expiry 为 "YYYY-MM-DD"；到期日当天 23:59:59 前仍视为有效。
 */
export function copyrightExpired(expiry: string | null | undefined): boolean {
  if (!expiry) return false;
  const d = new Date(`${expiry}T23:59:59.999`);
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
}
