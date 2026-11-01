import type { FontFace } from "./ipc";

/**
 * 快照应用（启用/停用一大批字体）的批次编排。
 *
 * 为什么单独抽出来：这层逻辑有三个容易被忽略的约束，放在组件/store 里既测不到也容易改坏：
 *   1. 批量启停很慢（Windows 上单个 `AddFontResourceW` 约 0.3~0.5 秒），必须分批 + 让出事件循环，
 *      否则窗口几分钟不响应；
 *   2. 每批写一次 2.4MB 的 state.json，100 批就是 240MB 磁盘 IO —— 中间批次必须跳过存盘；
 *   3. 跳过存盘之后，「取消」和「中途失败」这两条出口**必须补一次落盘**，
 *      否则内存里改了、磁盘上还是旧的，下次启动状态就错位。
 */

export interface ApplyBatch {
  paths: string[];
  active: boolean;
}

/** 每批多少个。实测 10 个约 4 秒，取消的响应延迟和进度刷新频率都比较合适 */
export const APPLY_CHUNK = 10;

/**
 * 先停用、后启用：切换快照时先把不在目标里的停掉，再启用目标字体。
 * 反过来的话，中间态会同时装着新旧两套字体，GDI 索引更抖。
 */
export function planBatches(
  toDeactivate: string[],
  toActivate: string[],
  chunk = APPLY_CHUNK,
): ApplyBatch[] {
  const batches: ApplyBatch[] = [];
  const push = (src: string[], active: boolean) => {
    for (let i = 0; i < src.length; i += chunk) {
      batches.push({ paths: src.slice(i, i + chunk), active });
    }
  };
  push(toDeactivate, false);
  push(toActivate, true);
  return batches;
}

/** 撤销用：顺序反转（后做的先撤），动作取反 */
export function reverseBatches(applied: ApplyBatch[]): ApplyBatch[] {
  return applied
    .slice()
    .reverse()
    .map((b) => ({ paths: b.paths, active: !b.active }));
}

/**
 * 丢掉「同一字面已经有副本启用着」的待启用项。
 *
 * 场景：同一个字体文件在 `C:\Windows\Fonts` 和用户的字体库里各有一份，两者
 * postscriptName 相同（`faceKey` 相同）。快照按 key 记录，解析时会同时命中两份路径，
 * 于是两份都要各花 0.4 秒去激活 —— 但字体只要有一份在系统里就已经可用了，
 * 第二份纯属白干（实测 301 个待启用项里有 289 个是这种重复副本）。
 *
 * 只在「另一份确实会保持启用」时才跳过：如果那份也在本次的停用名单里，跳过就会让字体消失。
 * `keyOf` 由调用方传入（就是 `snapshotKey.ts` 的 `faceKey`），这样本模块不依赖其它运行时代码。
 */
export function dropRedundantCopies(
  candidates: string[],
  facesByPath: Map<string, FontFace>,
  activeKeys: Set<string>,
  keyOf: (face: FontFace) => string,
): { keep: string[]; skipped: number } {
  const keep: string[] = [];
  let skipped = 0;
  for (const path of candidates) {
    const face = facesByPath.get(path);
    if (!face) continue;
    if (activeKeys.has(keyOf(face))) {
      skipped++;
      continue;
    }
    keep.push(path);
  }
  return { keep, skipped };
}

export interface ApplyOutcome {
  status: "done" | "cancelled" | "failed";
  done: number;
  error?: unknown;
}

export interface RunBatchesOptions {
  batches: ApplyBatch[];
  /** 执行一批。`noSave` 为真时后端不写 state.json */
  apply: (batch: ApplyBatch, noSave: boolean) => Promise<void>;
  /** 只落盘、不做启停（后端对空列表直接返回，只写 state.json） */
  flush: () => Promise<void>;
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
  /** 让出一次事件循环，让 React 把进度画出来、窗口能处理消息 */
  yieldToUi?: () => Promise<void>;
}

const nextTick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * 顺序跑完所有批次。
 *
 * 出口只有三个，每个都保证「磁盘上的 state.json 跟上内存」：
 *   - done：最后一批已经落盘；
 *   - cancelled：补一次 flush 再返回；
 *   - failed：同样补一次 flush，错误原样交回调用方。
 */
export async function runBatches(o: RunBatchesOptions): Promise<ApplyOutcome> {
  const total = o.batches.reduce((n, b) => n + b.paths.length, 0);
  const yieldToUi = o.yieldToUi ?? nextTick;
  let done = 0;
  try {
    for (let i = 0; i < o.batches.length; i++) {
      if (o.isCancelled?.()) {
        await o.flush().catch(() => {});
        return { status: "cancelled", done };
      }
      const last = i === o.batches.length - 1;
      await o.apply(o.batches[i], !last);
      done += o.batches[i].paths.length;
      o.onProgress?.(done, total);
      await yieldToUi();
    }
    return { status: "done", done };
  } catch (error) {
    await o.flush().catch(() => {});
    return { status: "failed", done, error };
  }
}

/**
 * 批量「移到回收站」要发给后端的条目（C8 的前端那一半）。
 *
 * 三个约束，改坏了会很贵：
 *   1. **一个路径只发一次** —— TTC 一个文件里有多个字面，`fonts` 里会有同一 path 的多条记录；
 *      去不去重差的不是几条请求，而是整个 uninstall 搬运次数。
 *   2. **系统字体一律不发** —— 动不了，发过去只会让后端为它写一条失败信息。
 *   3. **整批一次 IPC** —— 后端 `uninstall_fonts` 只在结尾落盘一次；
 *      逐个文件调 `uninstall_font` 会变成「每个文件重写 2.27 MB 的 state.json」，
 *      4020 个文件实测写了 9 GB（2026-11-01 事故）。
 */
export function trashItems(
  faces: Pick<FontFace, "family" | "path" | "source">[],
  families: Iterable<string>,
): { path: string; family: string }[] {
  const wanted = new Set(families);
  const seen = new Set<string>();
  const items: { path: string; family: string }[] = [];
  for (const f of faces) {
    if (f.source === "system" || !wanted.has(f.family)) continue;
    const key = `${f.family}\u0000${f.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ path: f.path, family: f.family });
  }
  return items;
}
