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

/** 中文「可商用」声明（放在 restrictive 之后：「不可商用」里含「可商用」） */
const OPEN_EXPLICIT_MARKERS = [
  "免费商用",
  "商用免费",
  "免费可商用",
  "可商用",
  "允许商用",
  "商用授权免费",
];

/**
 * 口径与旧版一致：personal use only / non-commercial / 不可商用这类许可都算 restrictive（→ 收费）。
 * 「个人免费」只认备注里明确写了「个人免费」的情况（或者用户手动在详情面板里选）。
 */
const PERSONAL_EXACT = [
  "个人免费",
  "免费供个人",
  "个人版免费",
  "个人使用免费",
  "免费个人使用",
];

/**
 * 「个人免费、商用要另买授权」→ 一样算 personal（2026-10-29 用户拍板）。
 * 字体本身免费可用，标成 restrictive 会把免费字体说成要花钱。
 */
const PERSONAL_ONLY_MARKERS = [
  "personal use only",
  "for personal use only",
  "personal use: free",
  "personal use is free",
  "non-commercial",
  "noncommercial",
  "not for commercial",
  "不可商用",
  "禁止商用",
  "非商业使用",
  "仅限个人",
  "仅供个人",
];

/** 确凿的要付钱 / 试用（只讲个人能不能用的条款在 PERSONAL_ONLY_MARKERS 里） */
const RESTRICTIVE_MARKERS = [
  "purchase a license",
  "purchase license",
  "requires a license",
  "buy the commercial license",
  "commercial license required",
  "购买商业授权",
  "购买授权",
  "需授权",
  "商用需授权",
  "evaluation only",
  "evaluation purposes",
  "trial version",
  "demo version",
  "shareware",
  "试用版",
  "演示版",
  "收费",
  "付费",
];

/** 与开源许可证身份直接冲突：同时出现说明这份文本也在讲收费 */
const HARD_CONFLICT = [
  "purchase a license",
  "requires a license",
  "购买授权",
  "需授权",
  "商用需授权",
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
  // ② 个人免费（用原文匹配，中文不需要小写）
  if (PERSONAL_EXACT.some((m) => text.includes(m))) return "personal";
  // ②b 个人免费、商用另购授权 → 同样算 personal
  if (hasAny(t, PERSONAL_ONLY_MARKERS)) return "personal";
  // ③ 收费／受限（必须先于④：「不可商用」里含「可商用」）
  if (hasAny(t, RESTRICTIVE_MARKERS)) return "restrictive";
  // ④ 明确可商用
  if (hasAny(t, OPEN_EXPLICIT_MARKERS)) return "open";
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
