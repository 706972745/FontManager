import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canScrollFurther,
  decayVelocity,
  followSpeedLimit,
  glideCap,
  glideDistance,
  GLIDE_DECAY,
  inertiaAllowed,
  measureVelocity,
  normalizeWheelDelta,
  renderStep,
  shouldGlide,
  smoothFactor,
  type WheelSample,
} from "../src/lib/momentumScroll.ts";

test("滚轮 deltaMode：行 / 页都折算成像素", () => {
  assert.equal(normalizeWheelDelta(100, 0, 800), 100);
  assert.equal(normalizeWheelDelta(3, 1, 800), 48); // 3 行 × 16px
  assert.equal(normalizeWheelDelta(1, 2, 800), 800); // 1 页 = 容器高度
  assert.equal(normalizeWheelDelta(-3, 1, 800), -48);
});

test("还能不能继续滚：贴边就交还原生", () => {
  assert.equal(canScrollFurther(500, 1000, 100), true);
  assert.equal(canScrollFurther(500, 1000, -100), true);
  assert.equal(canScrollFurther(1000, 1000, 100), false);
  assert.equal(canScrollFurther(1000, 1000, -100), true);
  assert.equal(canScrollFurther(0, 1000, -100), false);
  assert.equal(canScrollFurther(0, 1000, 100), true);
  assert.equal(canScrollFurther(0, 0, 100), false);
  assert.equal(canScrollFurther(999, 1000, 100), true);
  assert.equal(canScrollFurther(999.6, 1000, 100), false);
  assert.equal(canScrollFurther(500, 1000, 0), false);
});

test("测速：一格滚轮测不出速度（所以松手就是停）", () => {
  assert.equal(measureVelocity([]), 0);
  assert.equal(measureVelocity([{ t: 0, d: 100 }]), 0);
});

test("测速：窗口内的位移 / 时间跨度 = 手速", () => {
  const five: WheelSample[] = [
    { t: 0, d: 100 },
    { t: 75, d: 100 },
    { t: 150, d: 100 },
    { t: 225, d: 100 },
    { t: 300, d: 100 },
  ];
  const v = measureVelocity(five);
  // 500px / 300ms ≈ 1666px/s
  assert.ok(v > 1500 && v < 1800, `实际 ${v.toFixed(0)}px/s`);
});

test("测速：同帧补发的事件不会算出假速度（跨度夹到 50ms）", () => {
  const burst: WheelSample[] = [
    { t: 1000, d: 100 },
    { t: 1002, d: 100 },
    { t: 1004, d: 100 },
  ];
  const v = measureVelocity(burst);
  // 300px / 50ms = 6000，正好是上限，不会算出 150000
  assert.ok(v <= 6000, `实际 ${v.toFixed(0)}px/s`);
});

test("测速：反向滚动的速度是负的", () => {
  const v = measureVelocity([
    { t: 0, d: -100 },
    { t: 100, d: -100 },
  ]);
  assert.ok(v < 0, `实际 ${v.toFixed(0)}`);
});

test("慢滚 / 触控板碎步不起滑，快速滚动才起滑", () => {
  assert.equal(shouldGlide(0), false);
  assert.equal(shouldGlide(200), false);
  assert.equal(shouldGlide(299), false);
  assert.equal(shouldGlide(300), true);
  assert.equal(shouldGlide(-800), true);
});

test("滑行距离 = v/λ，滚得越快滑得越远", () => {
  // 默认 λ = 7：1000px/s 约滑 143px
  assert.ok(Math.abs(glideDistance(1000) - 1000 / 7) < 1e-6);
  assert.ok(glideDistance(5000) > glideDistance(1000) * 4);
});

test("滑行有两道封顶：不超过半屏，也不超过刚才滚过的距离", () => {
  // 屏幕封顶：视口 800 × 0.45 → 最多 360
  assert.equal(glideCap(800, 100000), 360);
  // 输入封顶：只滚了 200px，最多再滑 120（0.6 倍）
  assert.equal(glideCap(800, 200), 120);
  // 取两者更小的
  assert.equal(glideCap(800, 100), 60);
  // 异常输入不产生负值
  assert.equal(glideCap(0, 0), 0);
});

test("速度按帧衰减，且与帧率无关", () => {
  const v0 = 1000;
  const oneFrame60 = decayVelocity(v0, 1 / 60);
  assert.ok(oneFrame60 < v0 && oneFrame60 > v0 * 0.85);

  const twoFrames120 = decayVelocity(decayVelocity(v0, 1 / 120), 1 / 120);
  assert.ok(Math.abs(twoFrames120 - oneFrame60) < 0.001);

  // 0.4 秒后剩不到 7%（时间常数 0.14s）
  assert.ok(decayVelocity(v0, 0.4) < v0 * 0.07);
  // 1 秒后基本归零
  assert.ok(decayVelocity(v0, 1) < v0 * 0.002);
});

test("减动效时整条关闭（设置里的开关与系统偏好都算）", () => {
  assert.equal(inertiaAllowed("reduced", false), false);
  assert.equal(inertiaAllowed("system", true), false);
  assert.equal(inertiaAllowed(undefined, true), false);
  assert.equal(inertiaAllowed("system", false), true);
  assert.equal(inertiaAllowed(undefined, false), true);
});

test("追赶系数：差得越少追得越紧（触控板碎步不加延迟）", () => {
  assert.ok(smoothFactor(0) > smoothFactor(40));
  assert.ok(smoothFactor(40) > smoothFactor(80));
  assert.equal(smoothFactor(0), 50);
  assert.equal(smoothFactor(80), 18);
  assert.equal(smoothFactor(5000), 18);
  assert.equal(smoothFactor(-80), smoothFactor(80));
});

test("画面限速跟着手速走：手快时不许欠账", () => {
  // 静止时仍保底 1600，防一帧跳一大段
  assert.equal(followSpeedLimit(0), 1600);
  assert.equal(followSpeedLimit(300), 1600);
  // 手速 5000 → 允许 15000px/s（250px/帧），画面才追得上
  assert.equal(followSpeedLimit(5000), 15000);
});

test("单帧位移有上限：静止时连甩多格也不会一帧跳一大段", () => {
  const dt = 1 / 60;
  const cap = 1600 * dt;
  for (const diff of [200, 600, 1200, 5000]) {
    const step = renderStep(diff, dt);
    assert.ok(Math.abs(step) <= cap + 1e-9, `diff=${diff} step=${step} 超过 ${cap}`);
  }
  assert.ok(renderStep(300, dt) > 0);
  assert.ok(renderStep(-300, dt) < 0);
});

test("一格的位移被铺开：首帧不吞掉大半，约 100ms 走完", () => {
  const dt = 1 / 60;
  const first = renderStep(100, dt);
  assert.ok(first > 15 && first < 28, `首帧 ${first.toFixed(1)}px`);

  let pos = 0;
  let frames = 0;
  while (100 - pos > 5 && frames < 60) {
    pos += renderStep(100 - pos, dt);
    frames++;
  }
  assert.ok(frames >= 5 && frames <= 10, `用了 ${frames} 帧`);
});

test("触控板碎步三帧内到位（不加可感知的延迟）", () => {
  const dt = 1 / 60;
  let pos = 0;
  pos += renderStep(8 - pos, dt);
  pos += renderStep(8 - pos, dt);
  assert.ok(pos > 8 * 0.75, `两帧只走了 ${pos.toFixed(2)}px`);
  pos += renderStep(8 - pos, dt);
  assert.ok(8 - pos < 0.5, `三帧后还差 ${(8 - pos).toFixed(2)}px`);
});

test("追赶与帧率无关（120Hz 两帧 ≈ 60Hz 一帧）", () => {
  const one = renderStep(500, 1 / 60, 1e9);
  const a = renderStep(500, 1 / 120, 1e9);
  const two = a + renderStep(500 - a, 1 / 120, 1e9);
  assert.ok(Math.abs(one - two) < 0.01, `one=${one} two=${two}`);
});

/**
 * 模拟「松手之后」的滑行：用实现里的同一套公式跑一遍，量出滑行距离与时长。
 * 断言的是用户能感知的结论，而不是某个常量。
 */
function simulateGlide(v0: number, viewport: number, inputPx: number) {
  const dt = 1 / 60;
  const limit = glideCap(viewport, inputPx);
  // 与实现一致：距离封顶先换算成速度上限，减速曲线才完整
  let v = Math.min(Math.abs(v0), limit * GLIDE_DECAY);
  let traveled = 0;
  let t = 0;
  while (v >= 40 && traveled < limit && t < 5) {
    const step = v * dt;
    if (traveled + step > limit) {
      traveled = limit;
      break;
    }
    traveled += step;
    v = decayVelocity(v, dt);
    t += dt;
  }
  return { traveled, seconds: t };
}

test("连甩 10 格（5000px/s）：松手后最多 0.45 屏，0.65 秒内停住", () => {
  const { traveled, seconds } = simulateGlide(5000, 800, 1000);
  assert.ok(traveled <= 360 + 1e-6, `滑了 ${traveled.toFixed(0)}px`);
  assert.ok(seconds <= 0.65, `用了 ${seconds.toFixed(2)}s`);
});

test("连续滚 5 格（1666px/s）：松手后不超过 250px，0.6 秒内停住", () => {
  const { traveled, seconds } = simulateGlide(1666, 800, 500);
  assert.ok(traveled <= 250 + 1e-6, `滑了 ${traveled.toFixed(0)}px`);
  assert.ok(seconds <= 0.6, `用了 ${seconds.toFixed(2)}s`);
});

test("慢慢滚一格：不起滑，松手就是停", () => {
  assert.equal(measureVelocity([{ t: 0, d: 100 }]), 0);
  assert.equal(shouldGlide(0), false);
});
