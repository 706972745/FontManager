import { test } from "node:test";
import assert from "node:assert/strict";
import { OVER_TOP, SNAP_TOP_LOGICAL, snapDragTop } from "../src/lib/dragSnap.ts";

/**
 * 0.9.8-12：速览拖到「距顶边还差一点点」时自动吸附到 y=0。
 * 用户特别强调要考虑不同分辨率 —— 阈值必须随 DPR 换算，不能写死物理像素。
 */

test("距顶边在吸附距离内（含越顶）一律贴到 0", () => {
  assert.equal(snapDragTop(0, 1), 0);
  assert.equal(snapDragTop(3, 1), 0);
  assert.equal(snapDragTop(SNAP_TOP_LOGICAL, 1), 0); // 正好在阈值上也吸
  assert.equal(snapDragTop(-20, 1), 0); // 越过顶边同样贴顶，不再停在 -OVER_TOP
});

test("离开吸附区后恢复自由拖动", () => {
  const y = SNAP_TOP_LOGICAL + 5;
  assert.equal(snapDragTop(y, 1), y);
  assert.equal(snapDragTop(500, 1), 500);
});

test("阈值随 DPR 换算：高分屏吸附距离等比放大", () => {
  // 同一个物理距离 10：100% 缩放下已出吸附区，150% 缩放下仍在吸附区内
  assert.equal(snapDragTop(10, 1), 10);
  assert.equal(snapDragTop(10, 1.5), 0);
  assert.equal(snapDragTop(10, 2), 0);
  // 200% 下阈值 = 16 物理像素，20 已经在外面
  assert.equal(snapDragTop(16, 2), 0);
  assert.equal(snapDragTop(20, 2), 20);
});

test("DPR 异常（0 / 负数）退化为 1，不出 NaN", () => {
  assert.equal(snapDragTop(4, 0), 0);
  assert.equal(snapDragTop(20, -1), 20);
  assert.ok(Number.isFinite(snapDragTop(7, Number.NaN)));
});

test("越顶余量常量保持原有语义", () => {
  assert.equal(OVER_TOP, 4);
});
