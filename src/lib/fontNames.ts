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

/**
 * 界面语言 → 字体 name 表里该优先匹配的语言标签（按优先级）。
 *
 * 简体界面优先 zh-Hans，繁体优先 zh-Hant，其余按自身语言；
 * 同语族的变体都列上（zh-CN / zh-SG 之类写法在字体里很常见）。
 */
export function languagePriority(locale: string): string[] {
  const l = (locale || "").toLowerCase();
  if (l.startsWith("zh-hant") || l.startsWith("zh-tw") || l.startsWith("zh-hk")) {
    return ["zh-hant", "zh-tw", "zh-hk", "zh"];
  }
  if (l.startsWith("zh")) return ["zh-hans", "zh-cn", "zh-sg", "zh"];
  const base = l.split("-")[0];
  return [l, base];
}

/**
 * 「有全名字段的字族形状」：真实 `Family` 满足它，右键菜单那种只有一堆 `FontFace`
 * 的地方也能凑一个（不必为了取个显示名去建整个 Family）。
 */
export interface NamedFaces {
  name: string;
  faces: readonly FontFace[];
}

/** Regular 字面优先（它的 name 表通常最全） */
function facesWithRegularFirst(family: NamedFaces): FontFace[] {
  return [...family.faces].sort((a, b) => {
    const ar = a.style.toLowerCase() === "regular" ? 0 : 1;
    const br = b.style.toLowerCase() === "regular" ? 0 : 1;
    return ar - br;
  });
}

/**
 * 字族的**显示名**：优先用界面语言对应的本地化名，该语言确实没有名字时才回退默认名。
 *
 * 只影响显示，不改 `family.name`——收藏 / 标签 / 集合 / 快照都按 `name` 存，
 * 换语言不能让用户的数据全对不上。
 */
export function displayFamilyName(family: NamedFaces, locale: string): string {
  const wanted = languagePriority(locale);
  for (const want of wanted) {
    for (const face of facesWithRegularFirst(family)) {
      for (const entry of faceNames(face)) {
        const name = entry.name.trim();
        if (!name) continue;
        const lang = entry.lang.trim().toLowerCase();
        if (lang === want || lang.startsWith(want)) {
          return name;
        }
      }
    }
  }
  return family.name;
}

/** 一个字面能拿来搜的名字：族名 + name 表里每种语言的字族名 */
export function faceNameVariants(face: {
  family?: string;
  localizedNames?: { name: string }[] | null;
}): string[] {
  const out: string[] = [];
  const push = (value: string | undefined | null) => {
    const name = (value ?? "").trim();
    if (name) out.push(name);
  };
  push(face.family);
  for (const entry of face.localizedNames ?? []) push(entry.name);
  return out;
}

/**
 * 一个族**所有能被搜到的名字**：族名 + 每个字面的每种语言名（中文 / 英文 / 日文…）。
 *
 * 为什么必须收全：软件在「名称」列显示的是本地化名（比如 `微软雅黑`），而族名键可能是
 * `Microsoft YaHei`；只按族名搜就会出现「看得见、搜不到」。用户 2026-11-11 的原话是
 * 「不管是中文还是拉丁文还是其他语言的都应该可以搜索到」。
 *
 * 返回值保持出现顺序、按小写去重（同一串重复出现没有意义，匹配本身大小写不敏感）。
 */
export function familyNameVariants(family: {
  name: string;
  faces: readonly { family?: string; localizedNames?: { name: string }[] | null }[];
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (value: string | undefined | null) => {
    const name = (value ?? "").trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };
  push(family.name);
  for (const face of family.faces) {
    for (const name of faceNameVariants(face)) push(name);
  }
  return out;
}
