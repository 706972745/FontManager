import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PREFETCH_ITEMS, prefetchIndices } from "../src/lib/prefetch.ts";

test("向下滚：只预取视口下侧，窗口 = 一屏的条数", () => {
  // 可见 10..15（6 条），count 100，向下 → 16..21
  assert.deepEqual(prefetchIndices(100, 10, 15, 1), [16, 17, 18, 19, 20, 21]);
});

test("向上滚：只预取视口上侧，且由近到远", () => {
  assert.deepEqual(prefetchIndices(100, 10, 15, -1), [9, 8, 7, 6, 5, 4]);
});

test("没有方向时按向下处理（首屏用户大概率往下看）", () => {
  assert.deepEqual(prefetchIndices(100, 10, 15, 0), [16, 17, 18, 19, 20, 21]);
});

test("首屏向上滚没有上侧可预取", () => {
  assert.deepEqual(prefetchIndices(100, 0, 5, -1), []);
});

test("末屏向下滚没有下侧可预取", () => {
  assert.deepEqual(prefetchIndices(100, 94, 99, 1), []);
});

test("窗口在列表边界处裁剪，不越界", () => {
  // 视口 95..99，向下只剩 0 条；改向上 → 90..94（不含 95..99）
  assert.deepEqual(prefetchIndices(100, 90, 99, 1), []);
  assert.deepEqual(prefetchIndices(100, 2, 3, -1), [1, 0]);
});

test("总条数有硬上限，防止异常区间的 span 一次发起几百个", () => {
  const out = prefetchIndices(5000, 0, 0, 1, 999);
  assert.equal(out.length, MAX_PREFETCH_ITEMS);
  assert.equal(out[0], 1);
  assert.equal(out[out.length - 1], MAX_PREFETCH_ITEMS);
});

test("screens 放大窗口宽度", () => {
  const one = prefetchIndices(100, 10, 12, 1, 1); // span 3 → 3 条
  const two = prefetchIndices(100, 10, 12, 1, 2); // → 6 条
  assert.equal(one.length, 3);
  assert.equal(two.length, 6);
});

test("空列表与越界区间返回空", () => {
  assert.deepEqual(prefetchIndices(0, 0, 0, 1), []);
  assert.deepEqual(prefetchIndices(10, 50, 60, 1), []);
});

test("first > last 时按交换后的区间算（防御异常调用）", () => {
  assert.deepEqual(prefetchIndices(100, 15, 10, 1), [16, 17, 18, 19, 20, 21]);
});
