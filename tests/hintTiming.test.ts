import { test } from "node:test";
import assert from "node:assert/strict";
import { HINT_DELAY, HINT_SKIP_DELAY, HINT_SKIP_WINDOW, hintDelay } from "../src/lib/hintTiming.ts";

test("第一次悬停等满 1 秒（确认不是路过）", () => {
  assert.equal(hintDelay(null, 1_000_000), HINT_DELAY);
});

test("刚看完一条，立刻挪到下一个按钮只等 120ms", () => {
  const closedAt = 5_000;
  assert.equal(hintDelay(closedAt, closedAt + 1), HINT_SKIP_DELAY);
  assert.equal(hintDelay(closedAt, closedAt + 300), HINT_SKIP_DELAY);
});

test("窗口边界：2 秒内算同一次浏览，满 2 秒就重置", () => {
  const closedAt = 5_000;
  assert.equal(hintDelay(closedAt, closedAt + HINT_SKIP_WINDOW - 1), HINT_SKIP_DELAY);
  assert.equal(hintDelay(closedAt, closedAt + HINT_SKIP_WINDOW), HINT_DELAY);
  assert.equal(hintDelay(closedAt, closedAt + HINT_SKIP_WINDOW + 5_000), HINT_DELAY);
});

test("快速通道不能比首次还慢", () => {
  assert.ok(HINT_SKIP_DELAY < HINT_DELAY);
});

test("时钟倒退（休眠唤醒 / 手工对时）当成第一次，宁可慢也别乱快", () => {
  assert.equal(hintDelay(9_000, 1_000), HINT_DELAY);
});
