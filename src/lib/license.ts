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
 * 计算字族的实际版权分类：
 * 用户手动设置的优先；未设置时根据版权信息自动识别。
 */
export function effectiveCopyrightClass(
  license: string | null,
  override?: string,
): CopyrightClass {
  if (
    override === "free" ||
    override === "paid" ||
    override === "timelimited"
  ) {
    return override;
  }
  const cls = classifyLicense(license);
  return cls === "open" ? "free" : cls === "restrictive" ? "paid" : "unknown";
}
