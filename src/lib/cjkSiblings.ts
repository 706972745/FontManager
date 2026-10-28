import { useEffect, useState } from "react";
import { hanLevelKnown } from "./cjk";
import { familiesFor, useFontStore, type Family } from "../state/fontStore";
import type { FontFace } from "./ipc";

/**
 * 「这个家族没中文，但它的中文版装在另一个家族里」的指路查询。
 *
 * 典型场景是华为鸿蒙那类按语言拆包的字体：`HarmonyOS Sans` 只有 866 个西文码位，
 * 中文字形在 `HarmonyOS Sans SC` / `_TC` 里，是三个独立的 family。用户在字体库里
 * 看到 `HarmonyOS Sans` 标着「无中文」，第一反应是软件判错了——其实判断没错，
 * 只是没告诉他中文在哪。
 *
 * 只在这一张卡片确实缺中文时才查，结果按家族名缓存：绝大多数中文字体根本不会走到这里。
 */

type Cand = { name: string; face: Pick<FontFace, "path" | "faceIndex"> };

/** 结果缓存：家族名 → 有中文的兄弟家族名（null = 没有） */
const resultCache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

/** 兄弟候选缓存：家族名 → 候选列表（按推荐顺序排好） */
const siblingCache = new Map<string, Cand[]>();
/** 上次建索引时的字体库快照：fonts / tags 一变（导入 / 删除 / 重新扫描）就整个作废 */
let cachedFonts: FontFace[] | null = null;
let cachedTags: Record<string, string[]> | null = null;
let cachedFamilies: Family[] = [];

/**
 * 当前字族列表。`familiesFor` 每次都要把 5000 多个字面重新分组，不能每张卡片都调一次，
 * 所以按 store 里的 fonts / tags 引用做缓存，只有字体库真的变了才重建。
 */
function currentFamilies(): Family[] {
  const st = useFontStore.getState();
  if (cachedFonts === st.fonts && cachedTags === st.tags) return cachedFamilies;
  cachedFonts = st.fonts;
  cachedTags = st.tags;
  cachedFamilies = [...familiesFor(st.fonts, st.tags).values()];
  siblingCache.clear();
  resultCache.clear();
  return cachedFamilies;
}

const SIMPLIFIED = /(^|[\s_\-.])(SC|CN|GB|HANS|CHS|SIMPLIFIED)([\s_\-.]|$)/i;
const TRADITIONAL = /(^|[\s_\-.])(TC|TW|HK|HANT|CHT|TRADITIONAL)([\s_\-.]|$)/i;

/**
 * 版本后缀的推荐优先级：简中优先，繁中次之，其他（Condensed / Italic / Arabic 之类）
 * 最后。用户排中文正文九成要简体，先试这个能省掉几次文件读取。
 */
function rank(name: string): number {
  if (SIMPLIFIED.test(name)) return 0;
  if (TRADITIONAL.test(name)) return 1;
  return 2;
}

/** 两个名字是不是「同一套字体的不同版本」：互相是对方加空格后的前缀 */
function isSibling(a: string, b: string): boolean {
  return b.toLowerCase().startsWith(`${a.toLowerCase()} `) ||
    a.toLowerCase().startsWith(`${b.toLowerCase()} `);
}

function siblingsOf(name: string): Cand[] {
  const fonts = currentFamilies();
  const hit = siblingCache.get(name);
  if (hit) return hit;

  const out: Cand[] = [];
  for (const f of fonts) {
    if (f.name === name || !isSibling(name, f.name)) continue;
    const lead = f.faces.find((x) => x.style === "Regular") ?? f.faces[0];
    if (!lead) continue;
    out.push({ name: f.name, face: lead });
  }
  // 先按版本后缀排，再按名字长度（越短越接近原家族），保证同一套里 SC 排在最前
  out.sort((a, b) => rank(a.name) - rank(b.name) || a.name.length - b.name.length);
  siblingCache.set(name, out);
  return out;
}

/**
 * 找同族的含中文版本。只认真·完整中文（`full`）——`sparse` 那种只有几百字的
 * 版本推过去等于让用户踩另一个坑。
 */
export function cjkSiblingKnown(familyName: string): Promise<string | null> {
  const key = familyName;
  const cached = resultCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = inflight.get(key);
  if (pending) return pending;

  const p = (async () => {
    for (const cand of siblingsOf(key)) {
      const level = await hanLevelKnown(cand.face);
      if (level === "full") {
        resultCache.set(key, cand.name);
        inflight.delete(key);
        return cand.name;
      }
    }
    resultCache.set(key, null);
    inflight.delete(key);
    return null;
  })().catch(() => {
    inflight.delete(key);
    return null;
  });

  inflight.set(key, p);
  return p;
}

/**
 * React 版。`enabled` 为假时完全不查——只在卡片确实缺中文时打开。
 * 返回兄弟家族名（null = 没找到或者还在查）。
 */
export function useCjkSibling(familyName: string, enabled: boolean): string | null {
  const [sibling, setSibling] = useState<string | null>(() =>
    enabled ? (resultCache.get(familyName) ?? null) : null,
  );

  useEffect(() => {
    if (!enabled) {
      setSibling(null);
      return;
    }
    const cached = resultCache.get(familyName);
    if (cached !== undefined) {
      setSibling(cached);
      return;
    }
    let alive = true;
    void cjkSiblingKnown(familyName).then((v) => {
      if (alive) setSibling(v);
    });
    return () => {
      alive = false;
    };
  }, [familyName, enabled]);

  return sibling;
}
