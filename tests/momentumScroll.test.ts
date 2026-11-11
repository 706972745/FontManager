import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canScrollFurther,
  decayVelocity,
  glideDistance,
  inertiaAllowed,
  normalizeWheelDelta,
  tailShare,
} from "../src/lib/momentumScroll.ts";

test("滚轮 deltaMode：行 / 页都折算成像素", () => {
  assert.equal(normalizeWheelDelta(100, 0, 800), 100);
  assert.equal(normalizeWheelDelta(3, 1, 800), 48); // 3 行 × 16px
  assert.equal(normalizeWheelDelta(1, 2, 800), 800); // 1 页 = 容器高度
  // 负数（往上滚）同样成立
  assert.equal(normalizeWheelDelta(-3, 1, 800), -48);
});

test("还能不能继续滚：贴边就交还原生", () => {
  // 中间：两个方向都能滚
  assert.equal(canScrollFurther(500, 1000, 100), true);
  assert.equal(canScrollFurther(500, 1000, -100), true);
  // 到底继续往下 → 不能；往上 → 能
  assert.equal(canScrollFurther(1000, 1000, 100), false);
  assert.equal(canScrollFurther(1000, 1000, -100), true);
  // 到顶继续往上 → 不能
  assert.equal(canScrollFurther(0, 1000, -100), false);
  assert.equal(canScrollFurther(0, 1000, 100), true);
  // 完全不能滚的容器（maxScroll = 0）
  assert.equal(canScrollFurther(0, 0, 100), false);
  // 亚像素余量（浏览器可能停在 999.5）
  assert.equal(canScrollFurther(999, 1000, 100), true);
  assert.equal(canScrollFurther(999.6, 1000, 100), false);
  // delta = 0 不接管
  assert.equal(canScrollFurther(500, 1000, 0), false);
});

test("一格 100px 的滚轮会再滑 40~60px（既不木也不飘）", () => {
  // 与 momentumScroll.ts 里的 GAIN / DECAY 对应：滑行距离 ≈ GAIN / DECAY × 100
  const v0 = 100 * 1.9;
  const d = glideDistance(v0);
  assert.ok(d > 40 && d < 60, `实际 ${d.toFixed(1)}px`);
});

test("滚得越快滑得越远，且大致成正比", () => {
  const slow = glideDistance(100 * 1.9);
  const fast = glideDistance(100 * 1.9 * 5);
  assert.ok(fast > slow * 4.5 && fast < slow * 5.5, `slow=${slow} fast=${fast}`);
});

test("慢滚（触控板的小分量）几乎不滑", () => {
  // 8px 的小滚动，滑行距离应该落在 4px 以内 —— 肉眼就是「停住了」
  assert.ok(glideDistance(8 * 1.9) < 4);
});

test("速度按帧衰减，且与帧率无关", () => {
  const v0 = 1000;
  const oneFrame60 = decayVelocity(v0, 1 / 60);
  assert.ok(oneFrame60 < v0 && oneFrame60 > v0 * 0.9);

  // 120Hz 跑两帧 == 60Hz 跑一帧（误差在浮点范围内）
  const twoFrames120 = decayVelocity(decayVelocity(v0, 1 / 120), 1 / 120);
  assert.ok(Math.abs(twoFrames120 - oneFrame60) < 0.001);

  // 1 秒后剩多少：e^-4.2 ≈ 1.5%
  assert.ok(decayVelocity(v0, 1) < v0 * 0.02);
});

test("减动效时整条关闭（设置里的开关与系统偏好都算）", () => {
  assert.equal(inertiaAllowed("reduced", false), false);
  assert.equal(inertiaAllowed("system", true), false);
  assert.equal(inertiaAllowed(undefined, true), false);
  assert.equal(inertiaAllowed("system", false), true);
  assert.equal(inertiaAllowed(undefined, false), true);
});

test("小分量（触控板）不给尾速，鼠标一格给满额", () => {
  // 触控板的碎步：只走不滑，避免和系统自带的惯性叠加
  assert.equal(tailShare(4), 0);
  assert.equal(tailShare(12), 0);
  assert.equal(tailShare(-12), 0);
  // 过渡区：(24-12)/(48-12) ≈ 0.33
  assert.ok(tailShare(24) > 0.3 && tailShare(24) < 0.36);
  assert.ok(Math.abs(tailShare(30) - 0.5) < 0.01);
  // 鼠标滚轮一格（100 / 120 / 53 都算大分量）
  assert.equal(tailShare(53), 1);
  assert.equal(tailShare(100), 1);
  assert.equal(tailShare(-100), 1);
});
