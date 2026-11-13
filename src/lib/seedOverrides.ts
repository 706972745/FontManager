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
 * 一次全量落地的完整结果：叠加好的字体表 + **落地后**的覆盖表。
 *
 * 覆盖表落地后一律是空的 —— 这正是 D-1 那条缺陷的修复点，所以两件事绑在一个函数里，
 * 谁也没法只改一半（曾经分开写：字体表叠加 + 覆盖表「只裁掉已消失路径」，结果留下了
 * 「还活着」的旧决策）。
 *
 * 为什么是**清空**而不是「裁掉已消失路径」：override 的语义是「本轮扫描期间用户压过了
 * 扫描结论」。扫描结论一旦落地，它就完成使命了。而 `noteOverrides` 只在
 * `phase === "scanning"` 时记录 —— 落地之后用户再改启停**不会**更新这张表
 * （`phase` 已是 `ready`）。于是留着的那条旧决策会在**下一轮**任意 rescan
 * （导入字体 / watcher / 换字体库）里压过**更新的**真相：
 * 界面显示停用、注册表其实已启用（或反过来：界面说启用、套用到 PS/AI 时失败），
 * 而且要到重启才可能对上。只裁「路径已不存在」的那些挡不住这条路径 ——
 * 要命的是**还活着**的旧决策。
 */
export function landFullScan<T extends OverrideTarget>(
  full: T[],
  overrides: Map<string, boolean>,
): { fonts: T[]; overrides: Map<string, boolean> } {
  return { fonts: applyOverrides(full, overrides), overrides: new Map() };
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
