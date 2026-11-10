import { useEffect, useState } from "react";

/**
 * 在线库族名「用字体自己渲染」（2026-11-10）
 *
 * 方案 A：WebView 直连远程，**不落盘、不走后端、不进字体库**。
 * 取字走 Google Fonts 的字符级子集接口：
 *
 *   GET https://fonts.googleapis.com/css2?family=<族名>&text=<族名用到的字符>
 *
 * 返回的 CSS 里只有一条 @font-face，src 指向 fonts.gstatic.com 上**只含这几个字**的 woff2。
 * 实测（1984 族全量）：字符级子集平均 **335 B**，而完整 TTF 平均 46 KB、
 * fontsource 自己的 latin 子集平均 17 KB —— 差两个数量级，列表里几百张卡片完全扛得住。
 *
 * 为什么用 Google 的 `text=` 而不是 fontsource 自己的文件：
 * - fontsource 的 woff2 是按 unicode-range 切好的**整段子集**（latin 约 17 KB），
 *   里面全是用不上的字；
 * - Google 的 `text=` 是按**精确字符**切的，一个族名通常 200~600 B；
 * - 在线库的族本来就全是 Google Fonts 收录的（目录接口只收 `type=google`），
 *   所以「目录里的族名 → Google 字体名」几乎一一对应。
 *
 * **取不到就回退**：族名在 Google 上没有 / 请求失败 / CSP 拦下 → 卡片用界面字体显示，
 * 并在在线库顶部给一行说明，告诉用户有几个字族没能用自身字体显示（不静默）。
 *
 * 实测命中率：70 族抽样 100%（含带空格的族名）；轴限定（`:wght@300`）救回少数
 * 非 400 字重的族；最终仍失败的走回退 + 说明行。
 */

const CSS_ENDPOINT = "https://fonts.googleapis.com/css2";

/** 记住的族数上限（族名 → 结果）。条目很小，但别让它无限长。 */
const MAX_MEMO = 4000;
/** 同时在途的请求上限：一次只放 4 个，避免一屏卡片同时打过去被限流。 */
const MAX_INFLIGHT = 4;

type Entry = { status: "loading" | "loaded" | "failed"; name: string | null };

const memo = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();
/** 取不到自身字体的族名（给说明行用） */
const failedFamilies = new Set<string>();
const failListeners = new Set<() => void>();

let active = 0;
const queue: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_INFLIGHT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    queue.push(() => {
      active += 1;
      resolve();
    });
  });
}

function release(): void {
  active -= 1;
  const next = queue.shift();
  if (next) next();
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 族名里用到的字符（含空格：族名本身可能有空格，缺了会显示成断开的字） */
function charsOf(family: string): string {
  const set = new Set<string>(family);
  set.add(" ");
  return [...set].join("");
}

/** 从 Google 返回的 CSS 里取出唯一的 src url */
function parseSrc(css: string): string | null {
  const m = css.match(/src:\s*url\(([^)]+)\)/);
  if (!m) return null;
  const url = m[1].trim().replace(/^['"]|['"]$/g, "");
  return url.startsWith("http") ? url : null;
}

/**
 * 候选的 family 写法，按顺序试：
 * 1. 光写族名 —— 绝大多数族这样就行；
 * 2. 带 ital/wght 轴 —— 只有 300/500/700 这种非 400 字重的族，Google 要求显式指定；
 * 3. 只带 wght —— 轴顺序不被接受时的退路。
 */
function specsFor(family: string, weights: number[], styles: string[]): string[] {
  const out = [family];
  const w = weights[0] ?? 400;
  const ital = styles.includes("italic") ? 1 : 0;
  out.push(`${family}:ital,wght@${ital},${w}`);
  out.push(`${family}:wght@${w}`);
  return out;
}

async function fetchCss(spec: string, chars: string): Promise<string | null> {
  const url = `${CSS_ENDPOINT}?family=${encodeURIComponent(spec)}&text=${encodeURIComponent(chars)}`;
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return null;
    const css = await res.text();
    return parseSrc(css) ? css : null;
  } catch {
    return null;
  }
}

async function ensure(
  family: string,
  weights: number[],
  styles: string[],
): Promise<Entry> {
  const known = memo.get(family);
  if (known) return known;
  const running = inflight.get(family);
  if (running) return running;

  const task = (async (): Promise<Entry> => {
    memo.set(family, { status: "loading", name: null });
    await acquire();
    try {
      const chars = charsOf(family);
      let src: string | null = null;
      for (const spec of specsFor(family, weights, styles)) {
        const css = await fetchCss(spec, chars);
        if (css) {
          src = parseSrc(css);
          if (src) break;
        }
      }
      if (!src) throw new Error("no font src");
      const name = `zfm-on-${hash(family)}`;
      const face = new FontFace(name, `url("${src}")`);
      await face.load();
      document.fonts.add(face);
      const done: Entry = { status: "loaded", name };
      memo.set(family, done);
      return done;
    } catch {
      failedFamilies.add(family);
      for (const fn of failListeners) fn();
      const done: Entry = { status: "failed", name: null };
      memo.set(family, done);
      return done;
    } finally {
      release();
      inflight.delete(family);
      if (memo.size > MAX_MEMO) {
        // 族名不会超过两千个，这条只是兜底；丢最早的一条
        const first = memo.keys().next();
        if (!first.done) memo.delete(first.value);
      }
    }
  })();

  inflight.set(family, task);
  return task;
}

/** 订阅「取不到自身字体的族数」变化（在线库顶部那行说明用） */
export function subscribeFailedFamilies(fn: () => void): () => void {
  failListeners.add(fn);
  return () => {
    failListeners.delete(fn);
  };
}

export function failedFamilyCount(): number {
  return failedFamilies.size;
}

/**
 * 取某个族名的自身字体。返回该族的字体名（可直接写进 `font-family`）或 null。
 *
 * 导出出来是为了能单独测（浏览器里跑真实模块，而不是复刻一份逻辑）。
 */
export async function loadOnlineFamilyFont(
  family: string,
  weights: number[] = [],
  styles: string[] = [],
): Promise<string | null> {
  const entry = await ensure(family, weights, styles);
  return entry.status === "loaded" ? entry.name : null;
}

/**
 * 在线库卡片用自身字体显示族名。
 *
 * 只在**卡片真的滚进视口**时才去取字（IntersectionObserver + 240px 边距）：
 * 在线库一屏最多 400 张卡，全都去请求会把 fonts.googleapis.com 打爆，
 * 而用户真正看到的只有十几张。
 */
export function useOnlineFamilyFont(
  f: { family: string; weights: number[]; styles: string[] } | null,
): {
  fontFamily: string | null;
  failed: boolean;
  setEl: (el: HTMLElement | null) => void;
} {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [, bump] = useState(0);
  const key = f ? `${f.family}|${f.weights.join(",")}|${f.styles.join(",")}` : "";
  const entry = f ? memo.get(f.family) : undefined;

  useEffect(() => {
    if (!el || !f) return;
    let alive = true;
    const io = new IntersectionObserver(
      (records) => {
        for (const r of records) {
          if (!r.isIntersecting) continue;
          const known = memo.get(f.family);
          if (known && known.status !== "loading") continue;
          void ensure(f.family, f.weights, f.styles).then(() => {
            if (alive) bump((n) => n + 1);
          });
        }
      },
      { rootMargin: "240px" },
    );
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
    // key 变了 = 换了一个族，旧的 observer 订阅要作废
  }, [el, key]);

  return {
    fontFamily: entry?.status === "loaded" ? entry.name : null,
    failed: entry?.status === "failed",
    setEl,
  };
}
