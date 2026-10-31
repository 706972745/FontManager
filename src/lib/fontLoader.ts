import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { createFaceLru } from "./faceRegistry";
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
    if (path && (await tryLoad(name, path, bytes))) {
      // 修一下就能显示 → 不算损坏，摘掉标记
      incompleteHook?.(hint.id, false);
      return true;
    }
  }
  // 两档都失败：这是「软件里预览不出来」，归到「无法预览 / 损坏」
  incompleteHook?.(hint.id, true);
  return false;
}

function tryLoad(name: string, path: string, bytes = 0): Promise<boolean> {
  return new Promise((resolve) => {
    const ff = new FontFace(name, `url("${convertFileSrc(path)}")`);
    ff.load()
      .then(() => {
        // 登记进 LRU —— 这一步才真正 add 进 document.fonts，同时兑现「条数 + 字节」双上限的淘汰。
        // bytes 是这个字面文件的实际体积，字节预算靠它算（不认识体积就传 0，只受条数约束）。
        loadedFaces.register(name, ff, bytes);
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

export function pathBasename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * 诊断用计数（临时）：排查「滚动时内存为什么一直涨」时用来核对
 * 「到底加载了多少个 FontFace、现在常驻几个、账面上多少字节」。
 */
let loadCount = 0;
let evictCount = 0;

export function faceStats(): {
  resident: number;
  bytes: number;
  loads: number;
  evictions: number;
  cached: number;
} {
  return {
    resident: loadedFaces.size,
    bytes: loadedFaces.bytes,
    loads: loadCount,
    evictions: evictCount,
    cached: cache.size,
  };
}export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
