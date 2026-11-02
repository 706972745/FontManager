import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMembership } from "../src/lib/familyMembership.ts";
import { sortContainers } from "../src/lib/faceContainers.ts";
import type { FontFace } from "../src/lib/ipc.ts";

const face = (style: string, ps: string) => ({ style, postscriptName: ps }) as unknown as FontFace;

const fam = (name: string, faces: FontFace[]) => ({ name, faces });

const keyOf = (f: FontFace) => `ps:${(f.postscriptName ?? "").toLowerCase()}`;

const pingfang = fam("PingFang TC", [face("細體", "PF-Thin"), face("粗體", "PF-Bold")]);
const harmony = fam("HarmonyOS Sans", [face("Regular", "HOS-Regular")]);

const entry = (family: string, style: string, key: string) => ({ family, style, key, system: false });

test("快照胶囊只算这个字族自己的条目", () => {
  const m = buildMembership(
    [pingfang, harmony],
    [
      {
        name: "584",
        entries: [entry("PingFang TC", "細體", "ps:pf-thin"), entry("HarmonyOS Sans", "Regular", "ps:hos-regular")],
      },
    ],
    {},
    {},
    keyOf,
  );
  assert.deepEqual(m.get("PingFang TC")?.snaps.map((b) => [b.name, b.count]), [["584", 1]]);
  assert.deepEqual(m.get("HarmonyOS Sans")?.snaps.map((b) => [b.name, b.count]), [["584", 1]]);
});

test("整族在分组里 → 胶囊列出全族字重", () => {
  const m = buildMembership([pingfang, harmony], [], { 中文: ["PingFang TC"] }, {}, keyOf);
  const colls = m.get("PingFang TC")?.colls ?? [];
  assert.equal(colls.length, 1);
  assert.equal(colls[0].name, "中文");
  assert.equal(colls[0].count, 2);
  assert.deepEqual(colls[0].styles, ["細體", "粗體"]);
  assert.equal(m.get("HarmonyOS Sans"), undefined, "没放进分组的字族不该出现");
});

test("只放了某个字重 → 胶囊只数那几个字重", () => {
  const m = buildMembership(
    [pingfang],
    [],
    {},
    { 中文: ["ps:pf-bold"] },
    keyOf,
  );
  const colls = m.get("PingFang TC")?.colls ?? [];
  assert.equal(colls.length, 1);
  assert.equal(colls[0].count, 1);
  assert.deepEqual(colls[0].styles, ["粗體"]);
});

test("整族 + 字重同时在同一个分组里，只出一枚胶囊（不重复计数）", () => {
  const m = buildMembership(
    [pingfang],
    [],
    { 中文: ["PingFang TC"] },
    { 中文: ["ps:pf-bold", "ps:pf-thin"] },
    keyOf,
  );
  const colls = m.get("PingFang TC")?.colls ?? [];
  assert.equal(colls.length, 1, "同一个分组不能在同一个字族上叠两枚胶囊");
  assert.equal(colls[0].count, 2);
});

test("多个分组按名字排序，与侧栏顺序一致", () => {
  const m = buildMembership(
    [pingfang],
    [],
    { 乙组: ["PingFang TC"], 甲组: ["PingFang TC"] },
    {},
    keyOf,
  );
  // 具体先后取决于**系统区域**：中文区域按拼音（甲 jiǎ 在 乙 yǐ 前），
  // 英文区域退化成码位序（乙 U+4E59 在 甲 U+7532 前）。所以这里不能写死
  // ["甲组","乙组"] —— 那会让这条用例在英文 runner 上必挂（2026-11-02 CI 实测）。
  // 真正要保证的是「与侧栏用的是同一个排序函数」，那就直接比它。
  assert.deepEqual(
    m.get("PingFang TC")?.colls.map((b) => b.name),
    sortContainers(["乙组", "甲组"]),
  );
});

test("字重指向的字族不存在（字体已删除）时静默跳过", () => {
  const m = buildMembership([harmony], [], { 组: ["已删除的字族"] }, { 组: ["ps:gone"] }, keyOf);
  assert.equal(m.has("已删除的字族"), false);
});

test("空分组 / 空快照不产生任何胶囊", () => {
  const m = buildMembership([pingfang, harmony], [], { 空组: [] }, { 空组: [] }, keyOf);
  assert.equal(m.size, 0);
});
