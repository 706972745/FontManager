/**
 * 扫描期间的「用户决策覆盖」与侧栏计数显示（2.1.4）。
 *
 * 为什么单独一个文件：这几条规则（全量结果怎么叠加用户操作、哪些计数该显示 `…`）
 * 全是纯函数，能脱离 React / Tauri 直接测。塞回 `fontStore.ts` 就只能整库跑起来才验得了，
 * 而它们恰好是「读着读着把用户刚启用的字体又变回停用」这类问题的唯一防线。
 */

/** 覆盖表要用的字段：只要这三样就能决定「要不要改、能不能改、改成什么」 */
export interface OverrideTarget {
  path: string;
  active: boolean;
  deactivatable: boolean;
}

/**
 * 记下用户这次的启停决策（path → active）。
 *
 * 只在扫描期间收集：全量结果用的 `active` 来自**扫描开始那一刻**的注册表快照，
 * 用户在扫描期间做的启停都不在那个快照里；不记下来，全量落地时会把这些操作原地抹掉。
 * 扫描结束（`phase === "ready"`）之后再记毫无意义 —— 那时结果已经是新的了，
 * 记了只会让 map 无限增长（ADR-08 的 U21）。
 */
export function nextOverrides(
  prev: Map<string, boolean>,
  paths: readonly string[],
  active: boolean,
): Map<string, boolean> {
  if (paths.length === 0) return prev;
  const next = new Map(prev);
  for (const p of paths) next.set(p, active);
  return next;
}

/**
 * 把覆盖表叠加到全量结果上（**唯一**一次 `set({fonts})` 之前调用）。
 *
 * 顺序不能反：扫描结论是「扫描开始那一刻」的真相，用户操作比它新，所以用户赢。
 * 只读字面（系统字体）不覆盖 —— 注册表里根本改不动它，覆盖只会让界面撒谎。
 */
export function applyOverrides<T extends OverrideTarget>(
  full: T[],
  overrides: Map<string, boolean>,
): T[] {
  if (overrides.size === 0) return full;
  return full.map((f) => {
    const want = overrides.get(f.path);
    if (want === undefined || !f.deactivatable || want === f.active) return f;
    return { ...f, active: want };
  });
}

/**
 * 裁掉指向「本轮已经不存在的路径」的覆盖项。
 *
 * 不裁的反例：路径被删除后复用了同一个名字（回收站还原、重新导入同名文件），
 * 上一次会话残留的覆盖项会在下一次全量里误伤这个新文件。
 */
export function pruneOverrides(
  overrides: Map<string, boolean>,
  alive: Iterable<string>,
): Map<string, boolean> {
  if (overrides.size === 0) return overrides;
  const keep = new Set(alive);
  const next = new Map<string, boolean>();
  for (const [p, v] of overrides) if (keep.has(p)) next.set(p, v);
  return next;
}

/**
 * 侧栏计数该怎么显示：`null` = 还不知道（渲染 `…`），`undefined` = 这一行不显示计数。
 *
 * 三态而非两态的原因：`0` 会被读成「没有字体」，而读字体的过程中给出的任何数字都是错的
 * （PRD US-4）。`undefined` 与 `null` 必须分开判 —— 用 `count !== undefined` 判空时
 * `null` 会被渲染成字符串 "null"。
 */
export function navCountText(count: number | null | undefined): string | null {
  if (count === undefined) return null;
  if (count === null) return "…";
  return String(count);
}
