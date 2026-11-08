import { test } from "node:test";
import assert from "node:assert/strict";
import { clampIndex, MAX_STEPS_PER_EVENT, wheelStep, WHEEL_UNIT } from "../src/lib/previewWheel.ts";

/**
 * Ctrl+滚轮调字号（2026-11-08 用户需求）。
 *
 * 这里锁的是「换算」这一层：一格滚轮必须只走一档、触控板的小增量要攒起来、
 * 猛甩滚轮不能一步跳到头。真机上「滚了有没有变」由 hook 负责，不在这测。
 */

test("往上滚一格（deltaY = -100）走一档放大", () => {
  const r = wheelStep(0, -WHEEL_UNIT);
  assert.equal(r.steps, 1);
  assert.equal(r.acc, 0);
});

test("往下滚一格走一档缩小", () => {
  const r = wheelStep(0, WHEEL_UNIT);
  assert.equal(r.steps, -1);
});

test("DPI 缩放下的 125 delta 仍然只走一档（不是两档）", () => {
  const r = wheelStep(0, 125);
  assert.equal(r.steps, -1);
  // 多出来的 25 留到下一次，不要丢
  assert.equal(r.acc, 25);
});

test("同一方向滚两格走两档", () => {
  const r = wheelStep(0, 2 * WHEEL_UNIT);
  assert.equal(r.steps, -2);
});

test("猛甩 10 格最多两档，且残余清到一格以内（反向立刻有反应）", () => {
  const r = wheelStep(0, 10 * WHEEL_UNIT);
  assert.equal(r.steps, -MAX_STEPS_PER_EVENT);
  assert.ok(Math.abs(r.acc) <= WHEEL_UNIT, `残余过大：${r.acc}`);
  // 立刻反方向滚一格，必须马上放大，而不是先还债
  const back = wheelStep(r.acc, -WHEEL_UNIT);
  assert.equal(back.steps, 1);
});

test("触控板的小增量先攒着，不满一格不动", () => {
  let acc = 0;
  let steps = 0;
  for (let i = 0; i < 9; i++) {
    const r = wheelStep(acc, -12); // 累计 -108
    acc = r.acc;
    steps += r.steps;
  }
  assert.equal(steps, 1, "9 次 -12 累计到一格，应当正好走一档");
});

test("deltaMode = 行时按行换算", () => {
  // 3 行 * 40 = 120 → 一档
  assert.equal(wheelStep(0, -3, 1).steps, 1);
});

test("clampIndex 卡在上下限里", () => {
  assert.equal(clampIndex(7, 1, 0, 7), 7);
  assert.equal(clampIndex(0, -1, 0, 7), 0);
  assert.equal(clampIndex(3, 1, 3, 7), 4, "卡片视图最低 24px（下标 3）");
  assert.equal(clampIndex(3, -1, 3, 7), 3, "低于 24px 时不动，而不是越界");
});
