import { useEffect, useState } from "react";
import { ipc, type FontFace } from "./ipc";

/**
 * 「这个字面里有没有中文字形」的查询。
 *
 * 为什么要专门做：字体没有汉字时，应用到 PS / AI / CorelDRAW 之后中文要么原样不变、
 * 要么变成方块。用户看不到任何变化，很容易以为「这个功能坏了」。
 * 后端只做一次 ttf 打开 + 几个码位查询，很便宜；前端把结果缓存起来，同一个字面只问一次。
 */

const cache = new Map<string, boolean>();
const inflight = new Map<string, Promise<boolean>>();

const keyOf = (face: Pick<FontFace, "path" | "faceIndex">) => `${face.path}#${face.faceIndex}`;

/** 已经查过的结果（没查过返回 undefined） */
export function cjkCached(face: Pick<FontFace, "path" | "faceIndex">): boolean | undefined {
  return cache.get(keyOf(face));
}

/** 查一次（带缓存 / 合并并发）；查不到就当作「有」，绝不因为 IO 失败去打扰用户 */
export function cjkKnown(face: Pick<FontFace, "path" | "faceIndex">): Promise<boolean> {
  const key = keyOf(face);
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = ipc
    .fontCjk([[face.path, face.faceIndex]])
    .then((res) => {
      const value = res[0] !== false;
      cache.set(key, value);
      inflight.delete(key);
      return value;
    })
    .catch(() => {
      inflight.delete(key);
      return true;
    });
  inflight.set(key, p);
  return p;
}

/** 批量预热（给一次展开一串字重的场景用） */
export async function cjkWarm(faces: Pick<FontFace, "path" | "faceIndex">[]): Promise<void> {
  const todo = faces.filter((f) => !cache.has(keyOf(f)));
  if (todo.length === 0) return;
  try {
    const res = await ipc.fontCjk(todo.map((f) => [f.path, f.faceIndex] as [string, number]));
    todo.forEach((f, i) => cache.set(keyOf(f), res[i] !== false));
  } catch {
    // 失败就算了，调用方会退回单条查询
  }
}

/**
 * React 版：返回 null = 还没查出来，true / false = 结论。
 * 用在字重行这种「查一次就有结论、之后走缓存」的地方。
 */
export function useCjkFlag(
  face: Pick<FontFace, "path" | "faceIndex"> | null | undefined,
): boolean | null {
  const key = face ? keyOf(face) : "";
  const [flag, setFlag] = useState<boolean | null>(() =>
    face ? (cjkCached(face) ?? null) : null,
  );
  useEffect(() => {
    if (!face) {
      setFlag(null);
      return;
    }
    const hit = cjkCached(face);
    if (hit !== undefined) {
      setFlag(hit);
      return;
    }
    setFlag(null);
    let alive = true;
    void cjkKnown(face).then((v) => {
      if (alive) setFlag(v);
    });
    return () => {
      alive = false;
    };
  }, [key]);
  return flag;
}
