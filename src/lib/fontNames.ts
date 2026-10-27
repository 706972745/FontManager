import type { Family } from "../state/fontStore";
import type { FontFace } from "./ipc";

export interface ExtraFontName {
  /** BCP-47 语言标签，如 en / zh-Hans / ja */
  lang: string;
  name: string;
  /** 是否为英文名 */
  english: boolean;
}

export function isEnglishLang(lang: string): boolean {
  return lang.toLowerCase().startsWith("en");
}

function faceNames(face: FontFace): { lang: string; name: string }[] {
  return Array.isArray(face.localizedNames) ? face.localizedNames : [];
}

/**
 * 字族的其他语言名称（不含与列表显示名相同的那一项）。
 * 英文名排在最前，其余按字母序稳定排列；同一字符串只保留一次。
 */
export function extraFamilyNames(family: Family): ExtraFontName[] {
  const seen = new Set<string>([family.name.trim().toLowerCase()]);
  const out: ExtraFontName[] = [];
  // Regular 字面通常名称最全，先扫它
  const faces = [...family.faces].sort((a, b) => {
    const ar = a.style.toLowerCase() === "regular" ? 0 : 1;
    const br = b.style.toLowerCase() === "regular" ? 0 : 1;
    return ar - br;
  });
  for (const face of faces) {
    for (const entry of faceNames(face)) {
      const name = entry.name.trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      out.push({ lang: entry.lang, name, english: isEnglishLang(entry.lang) });
    }
  }
  out.sort((a, b) => Number(b.english) - Number(a.english) || a.lang.localeCompare(b.lang));
  return out;
}

/** 英文字体名（没有则 null） */
export function englishFamilyName(family: Family): string | null {
  return extraFamilyNames(family).find((n) => n.english)?.name ?? null;
}

/** 除英文以外的其他语言名 */
export function otherFamilyNames(family: Family): ExtraFontName[] {
  return extraFamilyNames(family).filter((n) => !n.english);
}

/** 语言的本地化显示名（如 ja → 日语），取不到时退回语言标签本身 */
export function languageLabel(lang: string, locale: string): string {
  try {
    const display = new Intl.DisplayNames([locale], { type: "language" });
    const value = display.of(lang);
    if (value && value !== lang) return value;
  } catch {
    /* 老 WebView 不支持 Intl.DisplayNames 时忽略 */
  }
  return lang;
}

/** 菜单里展示用的短名称（过长时截断） */
export function shortName(name: string, max = 30): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}
