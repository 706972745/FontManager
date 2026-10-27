export type LicenseClass = "open" | "restrictive" | "unknown";

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
  const t = text.toLowerCase();
  if (RESTRICTIVE_MARKERS.some((m) => t.includes(m))) return "restrictive";
  if (OPEN_MARKERS.some((m) => t.includes(m))) return "open";
  return "unknown";
}

/** 版权状态：free = 免费；paid = 收费；timelimited = 版权有时间限制；unknown = 未知 */
export type CopyrightClass = "free" | "paid" | "timelimited" | "unknown";

/**
 * 计算字族的实际版权分类，权重：
 *   1. 用户手动设置（免费 / 收费 / 限时 / 未知，含显式的"未知"）
 *   2. 字体自带的版权信息（name 表里的 license）
 *   3. 文件夹备注 / 版权信息文件判定的版权（dirClass，由后端扫描时带出来）
 * 手动设为"自动识别"时按 2 → 3 的顺序判定。
 */
export function effectiveCopyrightClass(
  license: string | null,
  override?: string,
  dirClass?: string | null,
): CopyrightClass {
  if (
    override === "free" ||
    override === "paid" ||
    override === "timelimited" ||
    override === "unknown"
  ) {
    return override;
  }
  const cls = classifyLicense(license);
  if (cls !== "unknown") {
    return cls === "open" ? "free" : "paid";
  }
  if (
    dirClass === "free" ||
    dirClass === "paid" ||
    dirClass === "timelimited" ||
    dirClass === "unknown"
  ) {
    return dirClass;
  }
  return "unknown";
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
