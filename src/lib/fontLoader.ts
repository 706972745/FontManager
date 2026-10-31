import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { createFaceLru } from "./faceRegistry";
import { createLoaderStats } from "./loaderStats";
import { ipc } from "./ipc";
import type { FontFace as ZFontFace } from "./ipc";

/** 加载失败时用来「找后端修一份」的定位信息 */
type RepairHint = { id: string; path: string; index: number };

type LoadState = "loading" | "loaded" | "failed";

/**
 * 预览结果要同步到「无法预览 / 损坏」这一类：由 fontStore 注册的钩子处理
 * （既更新内存里的字面，也让后端把名单持久化）。
 * 用钩子而不是直接 import store，避免 lib 与 state 互相引用。
 */
let incompleteHook: ((id: string, on: boolean) => void) | null = null;
export function setUnpreviewableHook(fn: (id: string, on: boolean) => void) {
  incompleteHook = fn;
}
const cache = new Map<string, LoadState>();
const listeners = new Map<string, Set<() => void>>();

/**
 * 诊断样本（见交接文档 §10）。
 *
 * **纯被动**：这里只记录，任何一处 `record()` 都不参与加载路径的判断。
 * 0.9.9-24 的回归就是让「滚动中」这个信号反过来决定要不要加载，结果预览格
 * 停在 skeleton，用户直接判定「界面坏了」。测量工具不许影响被测量的东西。
 */
const stats = createLoaderStats(2000);

/** 累计计数：加载/淘汰各打了多少次（诊断 HUD 与 A/B 对照用） */
let loadCount = 0;
let evictCount = 0;

/**
 * 加载完成的时间戳，用来算 time-to-ink（加载完成 → 首帧绘制）。
 * 有上限：历史上加载过的字面可能有几千个，值很小但没有理由一直涨。
 */
const loadedAt = new Map<string, number>();
const MAX_LOADED_AT = 500;

function rememberLoadedAt(name: string): void {
  loadedAt.delete(name);
  loadedAt.set(name, performance.now());
  if (loadedAt.size > MAX_LOADED_AT) {
    const first = loadedAt.keys().next();
    if (!first.done) loadedAt.delete(first.value);
  }
}

/**
 * 「预取已经完成、但还在等用户滚过来」的字面。
 * 用于命中率统计（`prefetchHit / prefetchQueued`，交付标准 ≥ 40%，见 §14.3）。
 */
const prefetchReady = new Set<string>();
const MAX_PREFETCH_READY = 200;

function trimPrefetchReady(): void {
  if (prefetchReady.size <= MAX_PREFETCH_READY) return;
  const first = prefetchReady.values().next();
  if (!first.done) prefetchReady.delete(first.value);
}

/** 可见加载用上了预取的成果 → 记一次命中 */
function notePrefetchHit(name: string): void {
  if (!prefetchReady.has(name)) return;
  prefetchReady.delete(name);
  stats.countPrefetch("hit");
}
/**
 * 常驻字体上限 —— **条数 + 字节双上限**。
 *
 * 只限条数（0.9.9-22 及以前）在真实字体库上不成立：用户库里 p90 = 4 MB、
 * 88 个字体超过 15 MB，200 个字面能吃出 855 MB（2026-10-31 实测），
 * 理论最坏 1.5 GB —— 16 GB 机器会直接被挤到换页。
 *
 * 160 MB ≈ 40 个中文字面，或 ~200 个普通拉丁字面（后者先撞到条数上限）。
 * 屏幕上一屏 6~12 张卡片，回滚 3~4 屏不会触发重新加载，够用。
 */
const MAX_LOADED_FACES = 200;
const MAX_LOADED_BYTES = 160 * 1024 * 1024;

/**
 * 正在屏上渲染的字面（引用计数）。
 *
 * 被淘汰的那个「最久没用」的字体，很可能正是屏幕最上面那张卡片在用的。
 * 淘汰它会清掉状态缓存 → 卡片立刻重新加载 → 又超预算 → 再淘汰一条，
 * 一次滚动就能打出上百次加载/淘汰（0.9.9-23 用诊断 HUD 实测：180 格滚动加载 235 次、淘汰 206 次）。
 * 而 `document.fonts.delete()` 并不会把字体数据还给系统，重新加载只会让渲染进程再多留一份。
 * 所以挂载期间给名字加一，卸载时减一，淘汰跳过它们。
 */
const pinned = new Map<string, number>();

function pinFace(name: string): void {
  pinned.set(name, (pinned.get(name) ?? 0) + 1);
}

function unpinFace(name: string): void {
  const left = (pinned.get(name) ?? 0) - 1;
  if (left > 0) pinned.set(name, left);
  else pinned.delete(name);
}
/**
 * 已加载 FontFace 的 LRU（实现在 lib/faceRegistry.ts），按「最近使用」淘汰。
 * FontFace 一旦 add 进 document.fonts 就会被渲染进程常驻持有——字体文件动辄几 MB，
 * 长时间滚动浏览会把内存慢慢吃满，WebView2 渲染进程就会突然崩掉（表现为「用一会儿就闪退」）。
 *
 * 0.9.9-13 的老实现是 `const loadedFaces = new Map()` + tryLoad 里只 `document.fonts.add(ff)`，
 * 从没往 Map 里写过东西 → 淘汰分支是死代码，上限从来没生效过。
 */
const loadedFaces = createFaceLru<FontFace>(document.fonts, {
  max: MAX_LOADED_FACES,
  maxBytes: MAX_LOADED_BYTES,
  canEvict: (name) => !pinned.has(name),
  onEvict: (name) => {
    evictCount += 1;
    // 被淘汰说明这次预取没等到用户，不能算命中
    prefetchReady.delete(name);
    // 被淘汰的字体可能还在屏幕上：清掉状态缓存并唤醒等待者，让组件重新走一次加载自愈，
    // 否则卡片会静默退回系统字体（cache 还有 "loaded"）或永久停在空白（cache 已被删）。
    cache.delete(name);
    const waiting = listeners.get(name);
    listeners.delete(name);
    waiting?.forEach((fn) => fn());
  },
});

function cssName(face: ZFontFace): string {
  return `zfm-${hash(face.id)}`;
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 记一次「用到这个字体」：存在就挪到 LRU 末尾，顺便按上限淘汰最旧的 */
function touch(name: string): void {
  loadedFaces.touch(name);
}

function ensureLoaded(face: ZFontFace): void {
  ensurePathLoaded(
    cssName(face),
    face.previewPath ?? face.path,
    {
      id: face.id,
      path: face.previewPath ?? face.path,
      index: face.faceIndex ?? 0,
    },
    face.fileSize ?? 0,
  );
}

/**
 * 「让后端修一份」的结果，按字面 id 记住。
 * 值可能是 null（修不出来），也要记：不然每次 LRU 淘汰后重载都要再跑一趟。
 */
const repaired = new Map<string, string | null>();
/**
 * 修复结果的条数上限。每个字面最多记 2 条（两档修复），6295 个字面全走过就是 1.2 万条，
 * 值本身很小但没理由一直涨；超了丢最早的，代价只是那一次多问后端一趟。
 */
const MAX_REPAIRED = 2000;

/**
 * 加载失败后的两段修复：
 *   1 档 = 原样重建（修 cmap / 表长度这类结构问题）；
 *   2 档 = 再额外去掉提示程序（fpgm / prep / cvt）。
 * 有的老字体 OTS 就是不说明原因地整份拒收（652-CAI978 那批），2 档能把它们救回来。
 */
async function repairLoad(name: string, hint: RepairHint, bytes: number): Promise<boolean> {
  for (const level of [1, 2]) {
    const key = `${hint.id}#${level}`;
    let path = repaired.get(key);
    if (path === undefined) {
      try {
        path = await ipc.fontPreviewFile(hint.path, hint.index, level);
      } catch {
        path = null;
      }
      repaired.set(key, path);
      if (repaired.size > MAX_REPAIRED) {
        // Map 保持插入顺序，第一个就是最早记下的
        const first = repaired.keys().next();
        if (!first.done) repaired.delete(first.value);
      }
    }
    if (path && (await tryLoad(name, path, bytes, true))) {
      // 修一下就能显示 → 不算损坏，摘掉标记
      incompleteHook?.(hint.id, false);
      return true;
    }
  }
  // 两档都失败：这是「软件里预览不出来」，归到「无法预览 / 损坏」
  incompleteHook?.(hint.id, true);
  return false;
}

function tryLoad(
  name: string,
  path: string,
  bytes = 0,
  repaired = false,
): Promise<boolean> {
  return new Promise((resolve) => {
    const started = performance.now();
    const ff = new FontFace(name, `url("${convertFileSrc(path)}")`);
    ff.load()
      .then(() => {
        // 登记进 LRU —— 这一步才真正 add 进 document.fonts，同时兑现「条数 + 字节」双上限的淘汰。
        // bytes 是这个字面文件的实际体积，字节预算靠它算（不认识体积就传 0，只受条数约束）。
        const registerStart = performance.now();
        loadedFaces.register(name, ff, bytes);
        // 诊断样本：加载耗时 + add 的同步耗时（add 偶发长任务时能单独归因）
        stats.record(
          registerStart - started,
          bytes,
          repaired,
          performance.now() - registerStart,
        );
        rememberLoadedAt(name);
        loadCount += 1;
        resolve(true);
      })
      .catch(() => resolve(false));
  });
}

function ensurePathLoaded(
  name: string,
  path: string,
  repair?: RepairHint,
  bytes = 0,
): void {
  if (cache.has(name)) {
    // 可见加载撞上了预取（已完成或仍在途）→ 记一次命中。
    // 这是判断「预取值不值得做」的唯一硬指标（交付标准 ≥ 40%，见 §14.3）。
    notePrefetchHit(name);
    touch(name);
    return;
  }
  cache.set(name, "loading");

  void (async () => {
    let ok = await tryLoad(name, path, bytes);
    if (!ok && repair) {
      // 首次失败先试普通路径；还不行就问后端要副本（ttc 抽面 / cmap 重建 / 去提示程序）
      ok = await repairLoad(name, repair, bytes);
    }
    cache.set(name, ok ? "loaded" : "failed");
    if (ok) touch(name);
    listeners.get(name)?.forEach((fn) => fn());
    listeners.delete(name);
  })();
}

export function useFontCss(face: ZFontFace | null): {
  fontFamily: string | null;
  failed: boolean;
} {
  const name = face ? cssName(face) : null;
  const [, bump] = useState(0);
  const state = name ? cache.get(name) : undefined;

  // 挂载期间把它标记为「屏上在用」，LRU 淘汰会跳过（见 pinned 的注释）
  useEffect(() => {
    if (!name) return;
    pinFace(name);
    return () => unpinFace(name);
  }, [name]);

  useEffect(() => {
    if (!face || !name) return;
    // 依赖里带上 state：被 LRU 淘汰后 cache 里没有这个名字、state 变 undefined，
    // effect 会重跑并重新加载。少了这一条，淘汰正在显示的字体会让它永久停在系统字体上。
    ensureLoaded(face);
    if (cache.get(name) === "loading") {
      const set = listeners.get(name) ?? new Set();
      const fn = () => bump((n) => n + 1);
      set.add(fn);
      listeners.set(name, set);
      return () => {
        set.delete(fn);
      };
    }
  }, [face, name, state]);

  /**
   * time-to-ink：加载完成 → 下一帧绘制。
   *
   * 为什么放在 hook 里而不是组件里：卡片、字重行、速览、详情四个地方都在用这个 hook，
   * 放这里四处自动都有样本，不用挨个组件加代码（也不会有人漏掉）。
   * 只记第一次：同一字面反复进出视口时，第二次已经不是「加载 → 上屏」而是纯切换。
   */
  useEffect(() => {
    if (!name || state !== "loaded") return;
    const at = loadedAt.get(name);
    if (at === undefined) return;
    loadedAt.delete(name);
    if (typeof requestAnimationFrame !== "function") return;
    const id = requestAnimationFrame(() => stats.recordInk(performance.now() - at));
    return () => cancelAnimationFrame(id);
  }, [name, state]);

  return {
    fontFamily: state === "loaded" && name ? name : null,
    failed: state === "failed",
  };
}

export function usePathFontCss(key: string | null, path: string | null): string | null {
  const name = key ? `zfm-p-${hash(key)}` : null;
  const [, bump] = useState(0);
  const state = name ? cache.get(name) : undefined;

  // 挂载期间把它标记为「屏上在用」，LRU 淘汰会跳过（见 pinned 的注释）
  useEffect(() => {
    if (!name) return;
    pinFace(name);
    return () => unpinFace(name);
  }, [name]);

  useEffect(() => {
    if (!name || !path) return;
    ensurePathLoaded(name, path);
    if (cache.get(name) === "loading") {
      const set = listeners.get(name) ?? new Set();
      const fn = () => bump((n) => n + 1);
      set.add(fn);
      listeners.set(name, set);
      return () => {
        set.delete(fn);
      };
    }
  }, [name, path, state]);

  // 同 useFontCss：time-to-ink 只记第一次，样本按字面名去重
  useEffect(() => {
    if (!name || state !== "loaded") return;
    const at = loadedAt.get(name);
    if (at === undefined) return;
    loadedAt.delete(name);
    if (typeof requestAnimationFrame !== "function") return;
    const id = requestAnimationFrame(() => stats.recordInk(performance.now() - at));
    return () => cancelAnimationFrame(id);
  }, [name, state]);

  return name && path && state === "loaded" ? name : null;
}

export function loadFaceCss(face: ZFontFace): Promise<string> {
  const name = cssName(face);
  ensureLoaded(face);
  const state = cache.get(name);
  if (state === "loaded") return Promise.resolve(name);
  if (state === "failed") return Promise.reject(new Error("font failed to load"));
  return new Promise((resolve, reject) => {
    const set = listeners.get(name) ?? new Set();
    set.add(() => {
      if (cache.get(name) === "loaded") resolve(name);
      else reject(new Error("font failed to load"));
    });
    listeners.set(name, set);
  });
}

// ===== 主动预取（§14，默认关闭）=====

let inflightPrefetch = 0;
const MAX_INFLIGHT_PREFETCH = 3;

/**
 * 把字面提前解码进 LRU。**不 pin、不 repair、不写失败状态。**
 *
 * 与提案原版的四处差异（都来自 §9.2 的坑）：
 * - **不带 repair hint**：repair 会走两次后端 IPC 并写 preview-cache，
 *   预取批量触发等于一串磁盘写 + 主线程抖动，而且会污染 p95；
 * - **失败不写 `"failed"`**：`ensurePathLoaded` 见到 failed 直接 return，
 *   用户真滚到这张卡时不会再走原始+repair → 永久「无法预览」；
 * - **失败必须删掉 `"loading"`**：这是文档伪代码的隐蔽死角 —— 只"不写"是不够的，
 *   前面已经 `cache.set(name, "loading")` 了，残留的 loading 会让可见加载直接 return，
 *   那张卡**永远不加载**。比写 failed 更难查。
 * - **不触发 `incompleteHook`**：预取失败不代表字体损坏，不能给用户持久化「无法预览」标记。
 */
export function prefetchFace(face: ZFontFace): void {
  const name = cssName(face);
  if (cache.has(name)) {
    // 已加载 / 在加载 / 曾失败，都跳过 —— 失败的那次留给可见加载去 repair
    stats.countPrefetch("skipKnown");
    return;
  }
  const bytes = face.fileSize ?? 0;
  // 单字面超过预算 1/4（40MB）不预取：它一进来就会把整屏挤掉
  if (bytes > MAX_LOADED_BYTES / 4) {
    stats.countPrefetch("skipSize");
    return;
  }
  // 预算吃紧时预取必然打空：预取项是最新的，先被淘汰的却是"刚滚过去"那批
  if (loadedFaces.bytes > MAX_LOADED_BYTES * 0.6) {
    stats.countPrefetch("skipBudget");
    return;
  }
  if (inflightPrefetch >= MAX_INFLIGHT_PREFETCH) {
    stats.countPrefetch("skipInflight");
    return;
  }

  cache.set(name, "loading");
  inflightPrefetch += 1;
  stats.countPrefetch("queued");
  void tryLoad(name, face.previewPath ?? face.path, bytes)
    .then((ok) => {
      if (ok) {
        touch(name);
        prefetchReady.add(name);
        trimPrefetchReady();
        return;
      }
      cache.delete(name);
    })
    .finally(() => {
      inflightPrefetch -= 1;
    });
}

/** 实验脚本切档时清空样本，避免上一档的数字混进这一档 */
export function resetLoaderStats(): void {
  stats.reset();
}

export function pathBasename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * 诊断用计数：排查「滚动时为什么顿 / 内存为什么涨」时用来核对
 * 「加载了多少个 FontFace、现在常驻几个、账面上多少字节、解码慢在哪一段」。
 *
 * 分位统计**原始加载与修复加载分开**：repair 会走两次 IPC（TTC 抽面 / cmap 重建 /
 * 去提示程序），耗时量级完全不同，混在一起会让 p95 失去分辨力。
 */
export function faceStats() {
  const s = stats.snapshot();
  const p = stats.prefetchCounters();
  return {
    resident: loadedFaces.size,
    bytes: loadedFaces.bytes,
    loads: loadCount,
    evictions: evictCount,
    cached: cache.size,
    /** pin 数：overscan A/B 的核心观测之一（overscan 项会挂载 → 加载 → pin） */
    pinned: pinned.size,
    loadCount: s.count,
    loadP50: s.p50,
    loadP95: s.p95,
    loadMax: s.max,
    repairLoads: s.repairCount,
    repairP95: s.repairP95,
    registerP95: s.registerP95,
    inkCount: s.inkCount,
    inkP50: s.inkP50,
    inkP95: s.inkP95,
    prefetchQueued: p.queued,
    prefetchHit: p.hit,
    prefetchHitRate: stats.prefetchHitRate(),
    prefetchSkipSize: p.skipSize,
    prefetchSkipBudget: p.skipBudget,
    prefetchSkipInflight: p.skipInflight,
    prefetchSkipKnown: p.skipKnown,
    inflightPrefetch,
  };
}export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
