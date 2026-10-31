import { test } from "node:test";
import assert from "node:assert/strict";
import { styleScope, styleScopeLabel } from "../src/lib/styleScope.ts";

type F = { id: string; style: string; postscriptName?: string };

/** Century751 No2 BT 的真实形状：4 个字重，PostScript 名互不相同 */
const all: F[] = [
  { id: "f-roman", style: "Roman", postscriptName: "Century751BT-RomanNo2B" },
  { id: "f-italic", style: "Italic", postscriptName: "Century751BT-No2ItalicB" },
  { id: "f-bold", style: "Bold", postscriptName: "Century751BT-BoldB" },
  { id: "f-bolditalic", style: "Bold Italic", postscriptName: "Century751BT-BoldItalicB" },
];

const fmt = {
  scoped: (s: number, t: number) => `${s}/${t} styles`,
  partial: (a: number, t: number) => `${a}/${t} on`,
  count: (c: number) => `${c} styles`,
};

test("全部字重都在 → 不写分数，写总数", () => {
  const s = styleScope(all, all);
  assert.deepEqual(s, { shown: 4, total: 4, narrowed: false });
  assert.equal(styleScopeLabel(s, null, fmt), "4 styles");
});

test("快照里只有 1 个字重 → 写 1/4（用户 2026-10-31 报的现象）", () => {
  const s = styleScope([all[0]], all);
  assert.deepEqual(s, { shown: 1, total: 4, narrowed: true });
  assert.equal(styleScopeLabel(s, null, fmt), "1/4 styles");
});

test("收窄到 2 个字重 → 也写分数", () => {
  const s = styleScope([all[0], all[2]], all);
  assert.equal(s.shown, 2);
  assert.equal(styleScopeLabel(s, null, fmt), "2/4 styles");
});

test("同一字面在系统 + 库里各一份 → 只算一种（与 uniqueFaces 同口径）", () => {
  const dup: F[] = [
    ...all,
    // 库里那份 Roman，PostScript 名与系统完全相同
    { id: "f-roman-lib", style: "Roman", postscriptName: "century751bt-romanno2b" },
  ];
  const s = styleScope(dup, dup);
  assert.equal(s.total, 4, "同名副本不该把总数撑成 5");
  assert.equal(s.narrowed, false);
});

test("没有 PostScript 名时按样式名去重", () => {
  const noPs: F[] = [
    { id: "a", style: "Regular" },
    { id: "b", style: "Regular" },
    { id: "c", style: "Bold" },
  ];
  assert.equal(styleScope(noPs, noPs).total, 2);
});

test("列表为空 → 不写 0/4 这种怪数", () => {
  const s = styleScope([], all);
  assert.equal(s.shown, 0);
  assert.equal(s.narrowed, false);
  assert.equal(styleScopeLabel(s, null, fmt), "4 styles");
});

test("没收窄但只启用一部分 → 仍走「已启用」文案（0.9.9-13 行为不回退）", () => {
  const s = styleScope(all, all);
  assert.equal(styleScopeLabel(s, { active: 2, total: 4 }, fmt), "2/4 on");
});

test("同时收窄又部分启用 → 收窄优先（先解释列表为什么只有几行）", () => {
  const s = styleScope([all[0]], all);
  assert.equal(styleScopeLabel(s, { active: 1, total: 4 }, fmt), "1/4 styles");
});

test("整族只启用一个且没收窄 → 不是收窄，写「1/4 已启用」", () => {
  const s = styleScope(all, all);
  assert.equal(s.narrowed, false);
  assert.equal(styleScopeLabel(s, { active: 1, total: 4 }, fmt), "1/4 on");
});
