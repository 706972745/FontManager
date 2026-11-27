/**
 * `gridRowHeight` 的数字钉子（2026-11-27 滚动抖动修复 C1）。
 *
 * 为什么要把数字写死：这个函数的唯一用途是给虚拟列表一个「接近真实」的初值，
 * 估高偏一点，滚动条拇指长度就会在滚动过程中变（用户报的「画面别抖」）。
 * 所以这里不留 `±2` 这类宽松断言 —— 一旦 CSS 那侧的 padding / min-height 变了，
 * 或者有人把算式改回 `120 + size*1.5`，必须当场变红。
 *
 * 推导过程（每一项对应的 CSS 行号）见 `src/lib/gridMetrics.ts` 顶部注释。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gridRowHeight } from "../src/lib/gridMetrics.ts";

/**
 * 与 `src/state/fontStore.ts:128` 的 `SIZES` 逐字一致。
 * 这里刻意**手抄**而不是 import：`fontStore.ts` 会拉进 zustand / i18n / window，
 * `node --test` 里没有 DOM，import 它就变成「测 CSS 算式却要先起一个前端」。
 * 两边对不上时由下面的「档位清单」用例负责报错。
 */
const SIZES = [8, 14, 18, 24, 32, 48, 64, 96] as const;

test("档位清单与 fontStore 的 SIZES 一致（8 档、严格递增）", () => {
  assert.equal(SIZES.length, 8);
  for (let i = 1; i < SIZES.length; i++) {
    assert.ok(SIZES[i] > SIZES[i - 1], `第 ${i} 档 ${SIZES[i]} 必须大于前一档 ${SIZES[i - 1]}`);
  }
});

test("8 个档位逐档钉死：8..64 被 min-height 兜住（210），96 档外推（214.6）", () => {
  // 头部 28（`.star-btn` 的 --ctl-h，见 gridMetrics.ts §4）+ 预览块 max(size*1.35, 10 + size*1.15)：
  //   64 档：28 + 86.4 = 114.4，+43 = 157.4 < 196 ⇒ 卡片 196 ⇒ 210（本组最紧的一档）
  //   96 档：28 + 129.6 = 157.6，+43 = 200.6 > 196 ⇒ 卡片 200.6 ⇒ 214.6
  // 96 档是浮点运算，`*10 / 10` 只做一位小数的**精确**取整，不是容差断言。
  const expected: Record<number, number> = {
    8: 210,
    14: 210,
    18: 210,
    24: 210,
    32: 210,
    48: 210,
    64: 210,
    96: 214.6,
  };
  for (const size of SIZES) {
    const actual = size === 96 ? Math.round(gridRowHeight(size) * 10) / 10 : gridRowHeight(size);
    assert.equal(actual, expected[size], `字号 ${size}px 的行高`);
  }
});

test("默认档 32px 必须等于真机行高 210（旧算式 120 + 32*1.5 = 168 是低估 42px）", () => {
  assert.equal(gridRowHeight(32), 210);
  // 旧值只作为对照记在这里，别再退回那个算式
  assert.equal(120 + 32 * 1.5, 168);
});

test("96px 档越过 196 下限，按同一算式外推：28 + 129.6 + 43 + 14 = 214.6", () => {
  // 旧算式 120 + 96*1.5 = 264 是高估 49.4px（不是 54 —— 真机不是 210，是 214.6）。
  assert.equal(Math.round(gridRowHeight(96) * 10) / 10, 214.6);
  assert.equal(120 + 96 * 1.5, 264);
});

test("越界临界点与 >196 分支的外推（防止有人把函数简化成 return 210）", () => {
  // 内容高 ≥ 153（预览块 ≥ 125）才顶破 196，125 ÷ 1.35 ≈ 92.6：
  //   92 档：28 + 124.2 = 152.2 → +43 = 195.2 < 196 → 210
  //   93 档：28 + 125.55 = 153.55 → +43 = 196.55 → 210.55
  assert.equal(gridRowHeight(92), 210);
  assert.equal(gridRowHeight(93), 210.55);
  // 120px：max(120*1.35=162, 10+120*1.15=148) = 162 → 28+162+20+22+1+14 = 247
  assert.equal(gridRowHeight(120), 247);
  // 400px：max(540, 470) = 540 → 28+540+20+22+1+14 = 625
  assert.equal(gridRowHeight(400), 625);
  assert.notEqual(gridRowHeight(400), gridRowHeight(32));
});

test("非法字号退回最小行高，不产生 NaN / Infinity", () => {
  // 虚拟列表要求 estimateSize 永远返回有限正数，否则总高会变成 NaN（整张列表消失）。
  for (const bad of [0, -10, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const h = gridRowHeight(bad);
    assert.equal(h, 210, `输入 ${String(bad)}`);
    assert.ok(Number.isFinite(h), `输入 ${String(bad)} 必须返回有限值`);
  }
});
