import { test } from "node:test";
import assert from "node:assert/strict";
import { collectionFaceScope } from "../src/lib/collectionScope.ts";

type F = { id: string; style: string };
const faces: F[] = [
  { id: "f-regular", style: "Regular" },
  { id: "f-light", style: "Light" },
  { id: "f-bold", style: "Bold" },
];
const keyOf = (f: F) => `ps:${f.style.toLowerCase()}`;
const key = (style: string) => `ps:${style.toLowerCase()}`;

const run = (memberKeys: string[], wholeFamilies: string[]) =>
  collectionFaceScope("PingFang", faces, keyOf, memberKeys, wholeFamilies);

test("只加了一个字重 → 只显示那个字重", () => {
  const scope = run([key("Regular")], []);
  assert.deepEqual([...(scope ?? [])], ["f-regular"]);
});

test("整族是成员 → 显示整族（即使字重成员也在）", () => {
  assert.equal(run([key("Regular")], ["PingFang"]), null);
});

test("先加字重再加整族 → 显示整族（BUG-2 回归）", () => {
  // 真机复现顺序：先「標準體」进组，再整族 .蘋方-繁 进同一分组
  const scope = run([key("Regular")], ["PingFang"]);
  assert.equal(scope, null, "整族进来后不该再被收窄成单字重");
});

test("移除整族但保留字重成员 → 收窄回那个字重", () => {
  const scope = run([key("Light")], []);
  assert.deepEqual([...(scope ?? [])], ["f-light"]);
});

test("没有任何成员 → 显示整族", () => {
  assert.equal(run([], []), null);
});

test("字重成员属于别的字族 → 本族显示整族", () => {
  const scope = run(["ps:other-family-bold"], []);
  assert.equal(scope, null, "一个都没命中时不该把卡片清空");
});

test("字重成员覆盖了全部字面 → 不需要收窄", () => {
  const scope = run([key("Regular"), key("Light"), key("Bold")], []);
  assert.equal(scope, null);
});

test("加入了不存在的键 + 一个有效键 → 仍按有效键收窄", () => {
  const scope = run([key("Bold"), "ps:ghost"], []);
  assert.deepEqual([...(scope ?? [])], ["f-bold"]);
});
