import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoaderStats, percentile } from "../src/lib/loaderStats.ts";

test("percentile：空样本返回 0，单样本返回它自己", () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([12], 95), 12);
});

test("percentile：最近秩，不插值", () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.equal(percentile(values, 50), 50);
  assert.equal(percentile(values, 95), 95);
  assert.equal(percentile(values, 100), 100);
  // 输入顺序不影响结果
  assert.equal(percentile([...values].reverse(), 95), 95);
});

test("环形上限：超出后丢最早的，样本数不涨", () => {
  const s = createLoaderStats(3);
  s.record(10, 0);
  s.record(20, 0);
  s.record(30, 0);
  s.record(40, 0);

  assert.equal(s.size, 3);
  // 10 被丢掉，剩下 20/30/40
  assert.equal(s.snapshot().max, 40);
  assert.equal(s.snapshot().p50, 30);
});

test("原始加载与修复加载分开统计（repair 的两次 IPC 不许污染 p95）", () => {
  const s = createLoaderStats(100);
  s.record(5, 0, false);
  s.record(6, 0, false);
  s.record(7, 0, false);
  // 修复链路慢得多：400ms / 600ms
  s.record(400, 0, true);
  s.record(600, 0, true);

  const snap = s.snapshot();
  assert.equal(snap.count, 3);
  assert.equal(snap.p95, 7); // 只算原始
  assert.equal(snap.repairCount, 2);
  assert.equal(snap.repairP95, 600);
  assert.equal(snap.max, 7);
});

test("registerMs 单独取 p95，不混进加载耗时", () => {
  const s = createLoaderStats(100);
  s.record(5, 0, false, 1);
  s.record(6, 0, false, 30);

  assert.equal(s.snapshot().registerP95, 30);
  assert.equal(s.snapshot().p95, 6);
});

test("time-to-ink 单独计样本", () => {
  const s = createLoaderStats(100);
  s.recordInk(4);
  s.recordInk(20);
  s.record(999, 0);

  const snap = s.snapshot();
  assert.equal(snap.inkCount, 2);
  assert.equal(snap.inkP50, 4);
  assert.equal(snap.inkP95, 20);
  assert.equal(snap.p95, 999);
});

test("预取计数与命中率：没发起过预取时命中率是 0 而不是 NaN", () => {
  const s = createLoaderStats(100);
  assert.equal(s.prefetchHitRate(), 0);

  s.countPrefetch("queued");
  s.countPrefetch("queued");
  s.countPrefetch("hit");
  assert.equal(s.prefetchHitRate(), 0.5);

  s.countPrefetch("skipBudget");
  const c = s.prefetchCounters();
  assert.equal(c.queued, 2);
  assert.equal(c.hit, 1);
  assert.equal(c.skipBudget, 1);
});

test("reset 清空全部样本与计数", () => {
  const s = createLoaderStats(100);
  s.record(10, 0);
  s.recordInk(5);
  s.countPrefetch("queued");
  s.reset();

  const snap = s.snapshot();
  assert.equal(s.size, 0);
  assert.equal(snap.count, 0);
  assert.equal(snap.inkCount, 0);
  assert.equal(s.prefetchCounters().queued, 0);
});
