import { test } from "node:test";
import assert from "node:assert/strict";
import { pickRemovedFamilyNames, withoutFamilies } from "../src/lib/containerRemove.ts";

/**
 * 0.9.9-1：Delete 在分组/快照里改成「移出成员」。
 *
 * 这两条判定写错都不会报错，只会静默出错：
 * - 分组那侧用 toggle 语义 → 字体会被「删了又加回来」；
 * - 快照那侧按 faceKey 反查字体表 → 已经不在本的条目永远清不掉。
 * 所以单独抽成纯函数并在这里钉死。
 */

test("分组：命中的才算是被移出的", () => {
  assert.deepEqual(pickRemovedFamilyNames(["A", "B", "C"], ["B"]), ["B"]);
  assert.deepEqual(pickRemovedFamilyNames(["A", "B", "C"], ["A", "C"]), ["A", "C"]);
});

test("分组：一个都不在分组里时返回空（调用方据此静默返回，不弹提示）", () => {
  assert.deepEqual(pickRemovedFamilyNames(["A", "B"], ["X", "Y"]), []);
});

test("分组：传空数组不炸", () => {
  assert.deepEqual(pickRemovedFamilyNames([], ["A"]), []);
  assert.deepEqual(pickRemovedFamilyNames(["A"], []), []);
});

test("分组：同一项在待删列表里重复出现只算一次", () => {
  assert.deepEqual(pickRemovedFamilyNames(["A", "B"], ["A", "A", "A"]), ["A"]);
});

test("快照：按 family 删掉该族的全部字重", () => {
  const entries = [
    { key: "ps:a-regular", family: "A" },
    { key: "ps:a-bold", family: "A" },
    { key: "ps:b-regular", family: "B" },
  ];
  const left = withoutFamilies(entries, ["A"]);
  assert.equal(left.length, 1);
  assert.equal(left[0].family, "B");
});

test("快照：字体已不在本机（只有 family 字段、查不到 key）时也能删掉", () => {
  // 换机器 / 卸载过的典型形态：key 保留着，但本机字体表里没有它
  const entries = [{ key: "ps:gone", family: "已卸载的字体" }];
  assert.deepEqual(withoutFamilies(entries, ["已卸载的字体"]), []);
});

test("快照：删多个族只影响这些族", () => {
  const entries = [
    { key: "1", family: "A" },
    { key: "2", family: "B" },
    { key: "3", family: "C" },
    { key: "4", family: "D" },
  ];
  const left = withoutFamilies(entries, ["B", "D"]);
  assert.deepEqual(left.map((e) => e.family), ["A", "C"]);
});

test("快照：一族都没命中时原样返回", () => {
  const entries = [{ key: "1", family: "A" }];
  assert.equal(withoutFamilies(entries, ["Z"]).length, 1);
});
