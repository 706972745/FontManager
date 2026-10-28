import { useEffect, useMemo, useState } from "react";
import { ipc, type FontFace } from "./ipc";

/**
 * 「顶栏那段示例文字用的是哪些书写系统，这个字面能不能显示」的查询。
 *
 * 和 lib/cjk.ts 的区别：cjk.ts 只回答「有没有汉字」，固定探针、用于应用前的警告；
 * 这里跟着用户在示例框里输入的内容走——输入中文就查汉字、输入假名就查假名、
 * 输入西里尔就查西里尔，缺哪种就在卡片 / 字重行上标出来。
 *
 * 探针用的是每个书写系统自带的常用字符，而不是用户输入的原字符：
 * ① 缓存 key 只跟「出现了哪些书写系统」有关，用户逐字打字不会让几千个查询反复失效；
 * ② 输入里的生僻字（比如「龘」）不会让一款正常的中文字体被误判成「没有中文」。
 */

export type ScriptId =
  | "han"
  | "kana"
  | "hangul"
  | "latin"
  | "cyrillic"
  | "greek"
  | "arabic"
  | "hebrew"
  | "thai"
  | "devanagari";

/**
 * 汉字判定用的分层抽样字表（与 Rust 端 `parser::HAN_SAMPLE` 同一个表）。
 *
 * 为什么汉字不能像别的书写系统那样只查三个字：那样判不出「只有几百个字」的字体。
 * 图标字体、只做标题字的展示字体、日文字体的汉字子集都会命中几个常用字，
 * 被打上「有中文」的标记，用户拿它排正文才发现一片豆腐块。
 *
 * 选字标准：**简繁同形**（简体字体和繁体字体都必然收录）、**高频**、
 * 并沿 U+4E00–U+9AD4 整段分散。正常中文字体应该接近百分之百命中。
 */
const HAN_SAMPLE =
  "一七三上下不世中主久之也事二五些交京人今代以位低作使供保信候做" +
  "光全共兵再出分切列到制前力加化十半南印原友反取受名向合和品商四在地外大天女好子字安定家小" +
  "山工年平心手文日月木水永火生田甲白目石立老金";

/** 每个书写系统的探针（除汉字外，命中 2 个算支持） */
const PROBES: Record<ScriptId, string> = {
  han: HAN_SAMPLE,
  kana: "あアの",
  hangul: "한국어",
  latin: "AaB",
  cyrillic: "Абв",
  greek: "Αβγ",
  arabic: "ابج",
  hebrew: "אבג",
  thai: "กขค",
  devanagari: "अकग",
};

/** 汉字算「完整支持」的最低命中比例（与 Rust 端一致，留 40% 余量应对个别缺字） */
const HAN_FULL_RATIO = 0.6;

export const SCRIPT_ORDER: ScriptId[] = [
  "han",
  "kana",
  "hangul",
  "latin",
  "cyrillic",
  "greek",
  "arabic",
  "hebrew",
  "thai",
  "devanagari",
];

/** 码位 → 书写系统。空白 / 数字 / 标点 / 符号返回 null（不算语言需求） */
function scriptOf(cp: number): ScriptId | null {
  // 数字、标点、各类符号、emoji 不参与判定
  if (cp <= 0x40) return null; // ASCII 标点与数字
  if (cp >= 0x5b && cp <= 0x60) return null; // [ \ ] ^ _ `
  if (cp >= 0x7b && cp <= 0xbf) return null; // { | } ~ 与拉丁补充符号
  if (cp >= 0x2000 && cp <= 0x2bff) return null; // 通用标点 / 上下标 / 箭头 / 数学符号
  if (cp >= 0x3000 && cp <= 0x303f) return null; // CJK 标点（、。「」等）
  if (cp >= 0xff00 && cp <= 0xff20) return null; // 全角标点
  if (cp >= 0x1f000) return null; // emoji 等

  if (cp >= 0x0041 && cp <= 0x005a) return "latin";
  if (cp >= 0x0061 && cp <= 0x007a) return "latin";
  if (cp >= 0x00c0 && cp <= 0x024f) return "latin";
  if (cp >= 0x1e00 && cp <= 0x1eff) return "latin";

  if (cp >= 0x0370 && cp <= 0x03ff) return "greek";
  if (cp >= 0x1f00 && cp <= 0x1fff) return "greek";

  if (cp >= 0x0400 && cp <= 0x052f) return "cyrillic";

  if (cp >= 0x0590 && cp <= 0x05ff) return "hebrew";
  if (cp >= 0xfb1d && cp <= 0xfb4f) return "hebrew";

  if (cp >= 0x0600 && cp <= 0x06ff) return "arabic";
  if (cp >= 0x0750 && cp <= 0x077f) return "arabic";
  if (cp >= 0xfb50 && cp <= 0xfdff) return "arabic";
  if (cp >= 0xfe70 && cp <= 0xfeff) return "arabic";

  if (cp >= 0x0900 && cp <= 0x097f) return "devanagari";
  if (cp >= 0x0e00 && cp <= 0x0e7f) return "thai";

  // 假名在汉字之前判断：日文里的汉字仍然算 han，假名单独算 kana
  if (cp >= 0x3040 && cp <= 0x30ff) return "kana";
  if (cp >= 0x31f0 && cp <= 0x31ff) return "kana";
  if (cp >= 0xff66 && cp <= 0xff9d) return "kana";

  if (cp >= 0x1100 && cp <= 0x11ff) return "hangul";
  if (cp >= 0x3130 && cp <= 0x318f) return "hangul";
  if (cp >= 0xa960 && cp <= 0xa97f) return "hangul";
  if (cp >= 0xac00 && cp <= 0xd7ff) return "hangul";

  if (cp >= 0x2e80 && cp <= 0x2eff) return "han";
  if (cp >= 0x3400 && cp <= 0x4dbf) return "han";
  if (cp >= 0x4e00 && cp <= 0x9fff) return "han";
  if (cp >= 0xf900 && cp <= 0xfaff) return "han";
  if (cp >= 0x20000 && cp <= 0x2fa1f) return "han";

  return null;
}

/** 这段文字需要哪些书写系统（保序去重；纯数字 / 标点 / 空文本返回空数组） */
export function scriptsInText(text: string): ScriptId[] {
  const seen = new Set<ScriptId>();
  const out: ScriptId[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const s = scriptOf(cp);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * 一个字面对某种书写系统的支持情况。
 *
 * - `ok`：能正常显示
 * - `partial`：有字形但明显不全（目前只有汉字会出现，比如只做了几百字的展示字体）
 * - `missing`：一个字形都没有
 */
export type ScriptStatus = {
  missing: ScriptId[];
  partial: ScriptId[];
};

type ProbeSet = {
  /** 所有探针字符拼成一条串，交给后端一次查完 */
  chars: string;
  /** 每个书写系统在 chars 里的区间 */
  spans: { script: ScriptId; from: number; to: number }[];
};

const probeCache = new Map<string, ProbeSet>();

function probeSetFor(scripts: ScriptId[]): ProbeSet {
  const key = scripts.join(",");
  const hit = probeCache.get(key);
  if (hit) return hit;
  let chars = "";
  const spans: ProbeSet["spans"] = [];
  for (const script of scripts) {
    const from = chars.length;
    chars += PROBES[script];
    spans.push({ script, from, to: chars.length });
  }
  const set = { chars, spans };
  probeCache.set(key, set);
  return set;
}

/** 结果缓存：key = 字体 + 需要的书写系统组合 */
const cache = new Map<string, ScriptStatus>();
const inflight = new Map<string, Promise<ScriptStatus>>();

const EMPTY_STATUS: ScriptStatus = { missing: [], partial: [] };

const faceKey = (face: Pick<FontFace, "path" | "faceIndex">) => `${face.path}#${face.faceIndex}`;
const fullKey = (face: Pick<FontFace, "path" | "faceIndex">, scripts: ScriptId[]) =>
  `${faceKey(face)}|${scripts.join(",")}`;

/** 已经查过的结果（没查过返回 undefined） */
export function scriptStatusCached(
  face: Pick<FontFace, "path" | "faceIndex">,
  scripts: ScriptId[],
): ScriptStatus | undefined {
  return cache.get(fullKey(face, scripts));
}

/**
 * 查一次（带缓存 / 合并并发）。查不到就当「都支持」——IO 失败不该给用户
 * 加一堆莫须有的「缺字」标签。
 */
export function scriptStatusKnown(
  face: Pick<FontFace, "path" | "faceIndex">,
  scripts: ScriptId[],
): Promise<ScriptStatus> {
  if (scripts.length === 0) return Promise.resolve(EMPTY_STATUS);
  const key = fullKey(face, scripts);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;

  const probe = probeSetFor(scripts);
  const p = ipc
    .fontCoverage([[face.path, face.faceIndex]], probe.chars)
    .then((res) => {
      const bits = res[0] ?? [];
      const status: ScriptStatus = { missing: [], partial: [] };
      for (const { script, from, to } of probe.spans) {
        const total = to - from;
        let hits = 0;
        for (let i = from; i < to; i += 1) if (bits[i]) hits += 1;
        if (script === "han") {
          // 汉字按覆盖率分档：一个字都没有 vs 有但明显不全，是两回事
          if (hits === 0) status.missing.push(script);
          else if (hits < total * HAN_FULL_RATIO) status.partial.push(script);
        } else if (hits < 2) {
          status.missing.push(script);
        }
      }
      cache.set(key, status);
      inflight.delete(key);
      return status;
    })
    .catch(() => {
      inflight.delete(key);
      return EMPTY_STATUS;
    });
  inflight.set(key, p);
  return p;
}

/** 注意：缓存可能随示例文字切换而涨。超过阈值整表清掉，重新问一遍比占着内存好 */
const CACHE_LIMIT = 20000;

/**
 * React 版：返回 null = 还没查出来或不需要标注（空文本），
 * 否则返回 { missing, partial }，两者都为空表示都支持。
 */
export function useScriptStatus(
  face: Pick<FontFace, "path" | "faceIndex"> | null | undefined,
  text: string,
): ScriptStatus | null {
  const scripts = useMemo(() => scriptsInText(text), [text]);
  const scriptsKey = scripts.join(",");
  const key = face ? `${faceKey(face)}|${scriptsKey}` : "";
  const [status, setStatus] = useState<ScriptStatus | null>(() => {
    if (!face || scripts.length === 0) return null;
    return scriptStatusCached(face, scripts) ?? null;
  });

  useEffect(() => {
    if (!face || scripts.length === 0) {
      setStatus(null);
      return;
    }
    const hit = scriptStatusCached(face, scripts);
    if (hit) {
      setStatus(hit);
      return;
    }
    setStatus(null);
    let alive = true;
    void scriptStatusKnown(face, scripts).then((v) => {
      if (!alive) return;
      if (cache.size > CACHE_LIMIT) cache.clear();
      setStatus(v);
    });
    return () => {
      alive = false;
    };
    // scripts 由 scriptsKey 代表（同一组合的对象每次都新建）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return status;
}

/** 有没有需要标注的东西（两个数组都空就不用渲染提示） */
export function hasScriptNote(status: ScriptStatus | null | undefined): boolean {
  return !!status && (status.missing.length > 0 || status.partial.length > 0);
}
