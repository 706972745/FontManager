import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { experiment } from "./experiment";
import { ipc } from "./ipc";

/**
 * 卡片缩略图缓存（交接文档 §13）。
 *
 * ## 为什么要「同步判定」
 *
 * 缩略图的价值只有一条：**滚回来时不用再加载字体**。要拿到这个收益，
 * 卡片必须在**首次渲染时就知道**有没有图 —— 如果先渲染文字再异步查磁盘换成图片，
 * 用户看到的是闪烁，而 0.9.9-24 的教训正是「任何先不加载的优化都会显示成界面坏了」。
 *
 * 所以启动时把 key 列表一次性拉进内存 Set（`thumb_index`），卡片同步查。
 * 查不到就正常渲染文本，并在字体加载完成后**后台生成**：生成结果只加进 Set，
 * **不触发本次渲染** —— 下次滚回来（组件重新挂载）才用上。
 */

/** 已知有图的 key。模块级，故意不接 React 状态：生成后不重渲染，避免图片/文字跳变 */
const known = new Set<string>();
let indexDir = "";
let indexPromise: Promise<void> | null = null;

/** 拉一次索引（幂等）。失败就当没有缓存，不影响任何渲染 */
export function ensureThumbIndex(): Promise<void> {
  if (indexPromise) return indexPromise;
  indexPromise = (async () => {
    try {
      const idx = await ipc.thumbIndex();
      indexDir = idx.dir;
      for (const k of idx.keys) known.add(k);
    } catch {
      /* 命令不存在 / 目录读不到：当作没有缓存 */
    }
  })();
  return indexPromise;
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * 缩略图 key。**任何一个影响像素的输入都要进去**，否则会命中一张错的图：
 * 字面（字重不同轮廓不同）、字符集、字号档、DPR、预览宽度、文字颜色（主题）。
 */
export function thumbKey(input: {
  faceId: string;
  chars: string;
  sizePx: number;
  dpr: number;
  widthPx: number;
  color: string;
}): string {
  const widthBucket = Math.round(input.widthPx / 8) * 8;
  return `t${fnv(
    [
      input.faceId,
      input.chars,
      Math.round(input.sizePx),
      Math.round(input.dpr * 100),
      widthBucket,
      input.color,
    ].join("\u0001"),
  )}`;
}

/** 已有图 → asset URL；没有 → null */
export function thumbSrc(key: string | null): string | null {
  if (!key || !indexDir || !known.has(key)) return null;
  return convertFileSrc(`${indexDir}\\${key}.png`);
}

/** 后台生成一张缩略图并落盘。失败静默（下次滚回来再试） */
export async function renderThumb(opts: {
  key: string;
  text: string;
  fontFamily: string;
  sizePx: number;
  widthPx: number;
  dpr: number;
  color: string;
}): Promise<void> {
  if (!opts.text || opts.widthPx < 8) return;
  const height = Math.ceil(opts.sizePx * 1.7);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(opts.widthPx * opts.dpr));
  canvas.height = Math.max(1, Math.ceil(height * opts.dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(opts.dpr, opts.dpr);
  // 与卡片文本渲染同一套：字号 + 字族，基线居中
  ctx.font = `${opts.sizePx}px "${opts.fontFamily}"`;
  ctx.fillStyle = opts.color;
  ctx.textBaseline = "middle";
  ctx.fillText(opts.text, 0, height / 2);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
  if (!blob) return;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    await ipc.thumbPut(opts.key, Array.from(bytes));
    // 只记进 Set，**不**触发重渲染：本次会话继续用文本，滚回来时才用图
    known.add(opts.key);
  } catch {
    /* 落盘失败：不影响本次渲染 */
  }
}

/** 卡片预览的缩略图。`src` 非空 → 用它替代文本渲染，并且**不必再加载字体**。 */
export type CardThumb = {
  ref: React.RefObject<HTMLDivElement | null>;
  src: string | null;
  /** 当前尺寸下算出的 key（没有图时用它写盘） */
  key: string | null;
  /** 测量到的预览区宽度与文字颜色 */
  box: { width: number; color: string } | null;
};

/**
 * 量预览区尺寸 + 同步判断有没有现成的图。
 *
 * **不负责生成**：生成要等字体加载完，而「要不要加载字体」又取决于这里有没有图 ——
 * 两者互为前提，所以拆成两步，由调用方在 `useListFontCss` 之后调 `useThumbGenerate`。
 *
 * 测量放在 `useLayoutEffect`：它在浏览器绘制前执行，里面的 setState 会同步重渲染，
 * 所以用户看不到「先文字后图片」的跳变。
 */
export function useCardThumb(opts: {
  enabled: boolean;
  faceId: string | null;
  chars: string | null;
  sizePx: number;
}): CardThumb {
  const { enabled, faceId, chars, sizePx } = opts;
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ width: number; color: string } | null>(null);
  const on = enabled && experiment.thumbnail();

  useLayoutEffect(() => {
    if (!on) {
      setBox(null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const color = getComputedStyle(el).color || "#000";
      setBox((prev) =>
        prev && Math.abs(prev.width - rect.width) < 1 && prev.color === color
          ? prev
          : { width: rect.width, color },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [on]);

  useEffect(() => {
    if (on) void ensureThumbIndex();
  }, [on]);

  const key =
    on && faceId && chars && box && box.width > 8
      ? thumbKey({
          faceId,
          chars,
          sizePx,
          dpr: typeof devicePixelRatio === "number" ? devicePixelRatio : 1,
          widthPx: box.width,
          color: box.color,
        })
      : null;

  return { ref, src: thumbSrc(key), key, box };
}

/**
 * 没有图、字体又已经加载好 → 后台补一张。
 *
 * **结果不参与本次渲染**（只加进模块级 Set）：本次会话这张卡继续用文本，
 * 滚回来组件重新挂载时才用上图片。这样就没有「文字↔图片」的跳变。
 */
export function useThumbGenerate(
  thumb: CardThumb,
  fontFamily: string | null,
  text: string,
  sizePx: number,
): void {
  const { key, src, box } = thumb;
  useEffect(() => {
    if (!key || src || !fontFamily || !box || !text) return;
    void renderThumb({
      key,
      text,
      fontFamily,
      sizePx,
      widthPx: box.width,
      dpr: typeof devicePixelRatio === "number" ? devicePixelRatio : 1,
      color: box.color,
    });
  }, [key, src, fontFamily, box, text, sizePx]);
}
