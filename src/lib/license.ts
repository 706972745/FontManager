export type LicenseClass = "open" | "personal" | "restrictive" | "unknown";

/**
 * 口径与旧版一致：personal use only / non-commercial / 不可商用这类许可都算 restrictive（→ 收费）。
 * 「个人免费」只认备注里明确写了「个人免费」的情况（或者用户手动在详情面板里选）。
 */
const PERSONAL_EXACT = ["个人免费", "免费供个人", "个人版免费"];

const OPEN_MARKERS = [
  "sil open font license",
  "open font license",
  "ofl",
  "apache license",
  "mit license",
  "gnu general public license",
  "gpl",
  "public domain",
  "cc0",
  "free for commercial",
  "freely available",
  "ubuntu font licence",
];

const RESTRICTIVE_MARKERS = [
  "may not be modified",
  "may not be redistributed",
  "not be sold",
  "non-commercial",
  "noncommercial",
  "personal use only",
  "evaluation only",
  "evaluation purposes",
  "trial version",
  "demo version",
  "all rights reserved. this font",
  "purchase a license",
  "requires a license",
];

export function classifyLicense(text: string | null): LicenseClass {
  if (!text) return "unknown";
  if (PERSONAL_EXACT.some((m) => text.includes(m))) return "personal";
  const t = text.toLowerCase();
  if (RESTRICTIVE_MARKERS.some((m) => t.includes(m))) return "restrictive";
  if (OPEN_MARKERS.some((m) => t.includes(m))) return "open";
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
