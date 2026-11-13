import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyOverrides,
  navCountText,
  nextOverrides,
  pruneOverrides,
} from "../src/lib/seedOverrides.ts";

/**
 * 扫描期间的「用户决策覆盖」（2.1.4 / ADR-08）。
 *
 * 这几条规则是「读着读着把用户刚启用的字体又变回停用」的唯一防线，
 * 而且全是纯函数 —— 放在这里测比对着界面点一遍可靠得多。
 */
const face = (path: string, active: boolean, deactivatable = true) => ({
  path,
  active,
  deactivatable,
});

/** U18：扫描中把 X 停用，全量结果里 X 还是 active（扫描用的是开始那一刻的快照）→ 以用户为准 */
test("full scan keeps a deactivation made while scanning", () => {
  const full = [face("C:/f/x.ttf", true), face("C:/f/y.ttf", false)];
  const out = applyOverrides(full, new Map([["C:/f/x.ttf", false]]));
  assert.equal(out.find((f) => f.path === "C:/f/x.ttf")?.active, false);
  // 没被覆盖的那一条保持扫描结论
  assert.equal(out.find((f) => f.path === "C:/f/y.ttf")?.active, false);
});

/** 反过来也一样：扫描期间启用的，不能被旧快照改回停用 */
test("full scan keeps an activation made while scanning", () => {
  const out = applyOverrides([face("C:/f/x.ttf", false)], new Map([["C:/f/x.ttf", true]]));
  assert.equal(out[0].active, true);
});

/** U19：覆盖项指向的路径已经不在全量结果里 → 不复活它，覆盖项也要被裁掉 */
test("stale overrides never resurrect a path and get pruned", () => {
  const full = [face("C:/f/kept.ttf", true)];
  const overrides = new Map([
    ["C:/f/kept.ttf", true],
    ["C:/f/deleted.ttf", true],
  ]);
  const out = applyOverrides(full, overrides);
  assert.deepEqual(
    out.map((f) => f.path),
    ["C:/f/kept.ttf"],
    "覆盖表不能凭空造出字体",
  );
  const pruned = pruneOverrides(
    overrides,
    full.map((f) => f.path),
  );
  assert.deepEqual([...pruned.keys()], ["C:/f/kept.ttf"]);
});

/** U20：只读字面（系统字体）不覆盖 —— 注册表里根本改不动它，覆盖只会让界面撒谎 */
test("read-only faces are never overridden", () => {
  const out = applyOverrides(
    [face("C:/Windows/Fonts/arial.ttf", true, false)],
    new Map([["C:/Windows/Fonts/arial.ttf", false]]),
  );
  assert.equal(out[0].active, true);
});

/** U21：扫描结束后再记没有任何意义（结果已经是新的了），只会让 map 无限增长 */
test("noteOverrides only collects while scanning", () => {
  const prev = new Map<string, boolean>();
  // nextOverrides 本身不认识 phase —— 由 store 的 noteOverrides 把关；
  // 这里钉住「空路径不产生新 map」这条，避免每次批量都白建一个 Map 触发重渲染
  assert.equal(nextOverrides(prev, [], true), prev);
  const next = nextOverrides(prev, ["C:/f/a.ttf", "C:/f/b.ttf"], true);
  assert.equal(next.get("C:/f/a.ttf"), true);
  assert.equal(next.get("C:/f/b.ttf"), true);
  // 原 map 不被就地改写：zustand 靠引用变化判断要不要重渲染
  assert.equal(prev.size, 0);
});

/** U22：没有覆盖项时直接返回原数组（避免一次无意义的全量 map，几千条也不便宜） */
test("applyOverrides is a no-op when nothing was touched", () => {
  const full = [face("C:/f/a.ttf", true)];
  assert.equal(applyOverrides(full, new Map()), full);
});

/**
 * 侧栏计数三态（PRD US-4）：`undefined` 不显示、`null` 显示 `…`、数字原样。
 * 用 `count !== undefined` 判空的写法会把 `null` 渲染成字符串 "null" —— 这条钉住它。
 */
test("nav count renders unknown as an ellipsis, not as zero", () => {
  assert.equal(navCountText(undefined), null);
  assert.equal(navCountText(null), "…");
  assert.equal(navCountText(0), "0");
  assert.equal(navCountText(4214), "4214");
});
