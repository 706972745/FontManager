import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canScrollFurther,
  decayVelocity,
  glideDistance,
  inertiaAllowed,
  normalizeWheelDelta,
  renderStep,
  smoothFactor,
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

test("一格 100px 的滚轮会再滑 30~50px（既不木也不飘）", () => {
  // 与 momentumScroll.ts 里的 GAIN / DECAY / MIN_VELOCITY 对应
  const v0 = 100 * 2.2;
  const d = glideDistance(v0);
  assert.ok(d > 30 && d < 50, `实际 ${d.toFixed(1)}px`);
});

test("滚得越快滑得越远", () => {
  const slow = glideDistance(100 * 2.2);
  const fast = glideDistance(100 * 2.2 * 5);
  assert.ok(fast > slow * 5, `slow=${slow.toFixed(1)} fast=${fast.toFixed(1)}`);
});

test("慢滚（触控板的小分量）不滑", () => {
  // 8px 的小滚动连最小速度都够不到 —— 松手就是静止
  assert.equal(glideDistance(8 * 2.2), 0);
  // 45px/s 也在阈值以下
  assert.equal(glideDistance(45), 0);
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

test("追赶系数：差得越少追得越紧（触控板碎步不加延迟）", () => {
  // 单调递减
  assert.ok(smoothFactor(0) > smoothFactor(40));
  assert.ok(smoothFactor(40) > smoothFactor(80));
  // 小差距贴上限、大差距落到底
  assert.equal(smoothFactor(0), 50);
  assert.equal(smoothFactor(80), 18);
  assert.equal(smoothFactor(5000), 18);
  // 负数（往上滚）按绝对值算
  assert.equal(smoothFactor(-80), smoothFactor(80));
});

test("单帧位移有上限：连甩多格也不会一帧跳一大段", () => {
  const dt = 1 / 60;
  const cap = 2000 * dt; // MAX_RENDER_SPEED / 帧
  for (const diff of [200, 600, 1200, 5000]) {
    const step = renderStep(diff, dt);
    assert.ok(Math.abs(step) <= cap + 1e-9, `diff=${diff} step=${step} 超过 ${cap}`);
  }
  // 方向跟着差距走
  assert.ok(renderStep(300, dt) > 0);
  assert.ok(renderStep(-300, dt) < 0);
});

test("一格的位移被铺开：首帧不吞掉大半，约 100ms 走完", () => {
  const dt = 1 / 60;
  const first = renderStep(100, dt);
  assert.ok(first > 10 && first < 30, `首帧 ${first.toFixed(1)}px`);

  // 60fps 连续追，7 帧内走到 95%（≈117ms）—— 太快就是「跳」，太慢就是「拖」
  let pos = 0;
  let frames = 0;
  while (100 - pos > 5 && frames < 60) {
    pos += renderStep(100 - pos, dt);
    frames++;
  }
  assert.ok(frames >= 4 && frames <= 8, `用了 ${frames} 帧`);
});

test("触控板碎步三帧内到位（不加可感知的延迟）", () => {
  const dt = 1 / 60;
  let pos = 0;
  pos += renderStep(8 - pos, dt);
  pos += renderStep(8 - pos, dt);
  // 两帧走掉七成以上：16ms 一帧的话，此时已经过去 33ms，肉眼看是「跟着手走」
  assert.ok(pos > 8 * 0.75, `两帧只走了 ${pos.toFixed(2)}px`);
  pos += renderStep(8 - pos, dt);
  assert.ok(8 - pos < 0.5, `三帧后还差 ${(8 - pos).toFixed(2)}px`);
});

test("追赶与帧率无关（120Hz 两帧 ≈ 60Hz 一帧）", () => {
  // speedLimit 放大到不截断，只看指数本身
  const one = renderStep(500, 1 / 60, 1e9);
  const a = renderStep(500, 1 / 120, 1e9);
  const two = a + renderStep(500 - a, 1 / 120, 1e9);
  assert.ok(Math.abs(one - two) < 0.01, `one=${one} two=${two}`);
});
