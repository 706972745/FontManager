import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildContainerIndex,
  buildContainerIndexCached,
  containersFor,
  resetContainerIndexCache,
  sortContainers,
} from "../src/lib/faceContainers.ts";

const entry = (family: string, key: string) => ({ family, style: "", key, system: false });

const K_REG = "ps:pingfangtc-regular";
const K_BOLD = "ps:pingfangtc-bold";

/** 断言用简写：只看「图标类型 + 序号」，名字另测 */
const shape = (list: { kind: string; index: number }[]) =>
  list.map((c) => `${c.kind}${c.index}`);

test("快照条目按字面 key 命中，进了两个快照就返回两个", () => {
  const idx = buildContainerIndex(
    [
      { name: "584", entries: [entry("F", K_REG), entry("F", K_BOLD)] },
      { name: "回归", entries: [entry("F", K_REG)] },
    ],
    {},
    {},
  );
  const got = containersFor(idx, "F", K_REG);
  assert.equal(got.length, 2);
  assert.deepEqual(
    got.map((c) => c.name),
    ["584", "回归"],
  );
});

test("没进任何快照的字面返回空数组（= 不显示胶囊）", () => {
  const idx = buildContainerIndex([{ name: "584", entries: [entry("F", K_BOLD)] }], {}, {});
  assert.deepEqual(containersFor(idx, "F", K_REG), []);
});

test("字重级分组成员命中", () => {
  const idx = buildContainerIndex([], {}, { n: [K_REG] });
  const got = containersFor(idx, "F", K_REG);
  assert.deepEqual(shape(got), ["coll1"]);
  assert.deepEqual(containersFor(idx, "F", K_BOLD), []);
});

test("整族进组时该族每个字重都算在组里", () => {
  const idx = buildContainerIndex([], { n: ["F"] }, {});
  assert.deepEqual(shape(containersFor(idx, "F", K_REG)), ["coll1"]);
  assert.deepEqual(shape(containersFor(idx, "F", K_BOLD)), ["coll1"]);
  // 别的字族不受影响
  assert.deepEqual(containersFor(idx, "G", K_REG), []);
});

test("整族 + 字重级成员同时在组里：不重复出现", () => {
  const idx = buildContainerIndex([], { n: ["F"] }, { n: [K_REG] });
  assert.deepEqual(shape(containersFor(idx, "F", K_REG)), ["coll1"]);
});

test("序号按名字排序编号，与侧栏顺序一致（不是按命中顺序从 1 数）", () => {
  const idx = buildContainerIndex(
    [
      { name: "584", entries: [entry("F", K_REG)] },
      { name: "1", entries: [] },
      { name: "2", entries: [] },
    ],
    { n: [], fjfe: [] },
    {},
  );
  // 排序后：1 → 快照1，2 → 快照2，584 → 快照3
  assert.deepEqual(shape(containersFor(idx, "F", K_REG)), ["snap3"]);
  // 分组：fjfe 排在 n 前
  const idx2 = buildContainerIndex([], { n: ["F"], fjfe: ["F"] }, {});
  assert.deepEqual(
    containersFor(idx2, "F", K_REG).map((c) => `${c.name}=${c.index}`),
    ["fjfe=1", "n=2"],
  );
});

test("同一字面进了多个快照：序号升序，且不与分组混排", () => {
  const idx = buildContainerIndex(
    [
      { name: "3", entries: [entry("F", K_REG)] },
      { name: "1", entries: [entry("F", K_REG)] },
      { name: "2", entries: [entry("F", K_REG)] },
    ],
    { 组A: ["F"], 组B: ["F"] },
    {},
  );
  const got = containersFor(idx, "F", K_REG);
  assert.deepEqual(shape(got), ["snap1", "snap2", "snap3", "coll1", "coll2"]);
  // 快照整段在前：哪怕快照3 的序号比分组1 大，也不能插到分组后面
  assert.equal(got[2].kind, "snap");
  assert.equal(got[3].kind, "coll");
});

test("空 key 的旧快照条目不会被当成「名字空白的快照」", () => {
  const idx = buildContainerIndex([{ name: "旧", entries: [entry("F", "")] }], {}, {});
  assert.deepEqual(containersFor(idx, "F", ""), []);
});

test("缓存：输入引用不变时复用同一份索引，变了就重建", () => {
  resetContainerIndexCache();
  const snapshots = [{ name: "584", entries: [entry("F", K_REG)] }];
  const collections: Record<string, string[]> = {};
  const collectionFaces: Record<string, string[]> = {};

  const a = buildContainerIndexCached(snapshots, collections, collectionFaces);
  const b = buildContainerIndexCached(snapshots, collections, collectionFaces);
  assert.equal(a, b, "引用没变应复用");

  const c = buildContainerIndexCached(
    [{ name: "584", entries: [entry("F", K_REG), entry("F", K_BOLD)] }],
    collections,
    collectionFaces,
  );
  assert.notEqual(a, c, "快照变了要重建");
  assert.deepEqual(shape(containersFor(c, "F", K_BOLD)), ["snap1"]);
});

test("sortContainers 与容器编号同序：侧栏第 2 行就是「快照 2」", () => {
  const names = ["n", "fjfe", "2", "584", "1"];
  const sorted = sortContainers(names);
  // 编号必须是按 sortContainers 的顺序发的，否则侧栏和字重行对不上
  const idx = buildContainerIndex(sorted.map((name) => ({ name, entries: [] })), {}, {});
  sorted.forEach((name, i) => assert.equal(idx.snapNo.get(name), i + 1));
  // 且排序结果与侧栏一致
  assert.deepEqual(sorted, ["1", "2", "584", "fjfe", "n"]);
});
