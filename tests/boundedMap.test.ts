import { test } from "node:test";
import assert from "node:assert/strict";
import { createBoundedMap } from "../src/lib/boundedMap.ts";

test("超过上限丢最早写入的", () => {
  const m = createBoundedMap<string, number>(3);
  m.set("a", 1);
  m.set("b", 2);
  m.set("c", 3);
  m.set("d", 4);

  assert.equal(m.size, 3);
  assert.equal(m.get("a"), undefined);
  assert.deepEqual(m.keys(), ["b", "c", "d"]);
});

test("重复写入同一个键会刷新它的位置，不会被当成最旧", () => {
  const m = createBoundedMap<string, number>(3);
  m.set("a", 1);
  m.set("b", 2);
  m.set("c", 3);
  m.set("a", 9); // 热点键

  m.set("d", 4);

  assert.equal(m.get("a"), 9, "刚写过的 a 应该留下");
  assert.equal(m.get("b"), undefined, "b 才是现在最旧的");
  assert.deepEqual(m.keys(), ["c", "a", "d"]);
});

test("删除后可以重新写入", () => {
  const m = createBoundedMap<string, number>(2);
  m.set("a", 1);
  assert.equal(m.delete("a"), true);
  assert.equal(m.has("a"), false);
  m.set("a", 2);
  assert.equal(m.get("a"), 2);
});
