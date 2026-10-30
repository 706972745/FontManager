import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
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
 * 已加载 FontFace 的引用，按「最近使用」排序（Map 迭代顺序 = 插入顺序，touch 时挪到末尾）。
 * FontFace 一旦 add 进 document.fonts 就会被渲染进程常驻持有——字体文件动辄几 MB，
 * 长时间滚动浏览会把内存慢慢吃满，WebView2 渲染进程就会突然崩掉（表现为「用一会儿就闪退」）。
 * 所以这里做 LRU 淘汰：超过上限就把最久没用的字体从 document.fonts 里删掉，下次用到再重载。
 */
const loadedFaces = new Map<string, FontFace>();
/** 常驻字体上限。200 张卡片 × 平均 1~2 MB ≈ 200~400 MB，留有余量 */
const MAX_LOADED_FACES = 200;

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
  const ff = loadedFaces.get(name);
  if (ff) {
    loadedFaces.delete(name);
    loadedFaces.set(name, ff);
  }
  while (loadedFaces.size > MAX_LOADED_FACES) {
    const [oldest, oldFf] = loadedFaces.entries().next().value as [string, FontFace];
    loadedFaces.delete(oldest);
    try {
      document.fonts.delete(oldFf);
    } catch {
      /* 重复删除无所谓 */
    }
    cache.delete(oldest);
    listeners.get(oldest)?.forEach((fn) => fn());
    listeners.delete(oldest);
  }
}

function ensureLoaded(face: ZFontFace): void {
  ensurePathLoaded(cssName(face), face.previewPath ?? face.path, {
    id: face.id,
    path: face.previewPath ?? face.path,
    index: face.faceIndex ?? 0,
  });
}

/**
 * 「让后端修一份」的结果，按字面 id 记住。
 * 值可能是 null（修不出来），也要记：不然每次 LRU 淘汰后重载都要再跑一趟。
 */
const repaired = new Map<string, string | null>();

/**
 * 加载失败后的两段修复：
 *   1 档 = 原样重建（修 cmap / 表长度这类结构问题）；
 *   2 档 = 再额外去掉提示程序（fpgm / prep / cvt）。
 * 有的老字体 OTS 就是不说明原因地整份拒收（652-CAI978 那批），2 档能把它们救回来。
 */
async function repairLoad(name: string, hint: RepairHint): Promise<boolean> {
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
    }
    if (path && (await tryLoad(name, path))) {
      // 修一下就能显示 → 不算损坏，摘掉标记
      incompleteHook?.(hint.id, false);
      return true;
    }
  }
  // 两档都失败：这是「软件里预览不出来」，归到「无法预览 / 损坏」
  incompleteHook?.(hint.id, true);
  return false;
}

function tryLoad(name: string, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ff = new FontFace(name, `url("${convertFileSrc(path)}")`);
    ff.load()
      .then(() => {
        document.fonts.add(ff);
        resolve(true);
      })
      .catch(() => resolve(false));
  });
}

function ensurePathLoaded(name: string, path: string, repair?: RepairHint): void {
  if (cache.has(name)) {
    touch(name);
    return;
  }
  cache.set(name, "loading");

  void (async () => {
    let ok = await tryLoad(name, path);
    if (!ok && repair) {
      // 首次失败先试普通路径；还不行就问后端要副本（ttc 抽面 / cmap 重建 / 去提示程序）
      ok = await repairLoad(name, repair);
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

  useEffect(() => {
    if (!face || !name) return;
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
  }, [face, name]);

  const state = name ? cache.get(name) : undefined;
  return {
    fontFamily: state === "loaded" && name ? name : null,
    failed: state === "failed",
  };
}

export function usePathFontCss(key: string | null, path: string | null): string | null {
  const name = key ? `zfm-p-${hash(key)}` : null;
  const [, bump] = useState(0);

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
  }, [name, path]);

  return name && path && cache.get(name) === "loaded" ? name : null;
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

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
