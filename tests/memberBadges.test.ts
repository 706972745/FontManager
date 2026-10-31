import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectionBadgesFor,
  faceLabel,
  memberBadge,
  snapshotBadgesFor,
} from "../src/lib/memberBadges.ts";
import type { FontFace } from "../src/lib/ipc.ts";

const face = (style: string, ps: string) => ({ style, postscriptName: ps }) as unknown as FontFace;

const faces = [
  face("標準體", "PingFangTC-Regular"),
  face("極細體", "PingFangTC-Ultralight"),
  face("粗體", "PingFangTC-Bold"),
];

const entry = (family: string, style: string, key: string) => ({ family, style, key, system: false });

/** 测试里自己给一个 keyOf（正式代码传 faceKey），这样这个 lib 不依赖别的模块 */
const keyOf = (f: FontFace) => `ps:${(f.postscriptName ?? "").toLowerCase()}`;

test("字重显示名：样式名优先，空就退回 PostScript 名", () => {
  assert.equal(faceLabel("Bold", "X-Bold"), "Bold");
  assert.equal(faceLabel("  ", "X-Bold"), "X-Bold");
  assert.equal(faceLabel("", ""), "—");
});

test("同一个字重名只算一次（系统 + 库里各一份时快照会有两条同名条目）", () => {
  const b = memberBadge("584", ["Roman", "roman", "Italic"]);
  assert.equal(b.count, 2);
  assert.deepEqual(b.styles, ["Roman", "Italic"]);
});

test("快照只算这个字族自己的条目，其它字族不算", () => {
  const snaps = [
    {
      name: "584",
      entries: [
        entry(".蘋方-繁", "標準體", "ps:a"),
        entry("Courier10 BT", "Roman", "ps:b"),
      ],
    },
  ];
  const badges = snapshotBadgesFor(".蘋方-繁", snaps);
  assert.equal(badges.length, 1);
  assert.deepEqual(badges[0].styles, ["標準體"]);
  assert.equal(badges[0].count, 1);
});

test("字族不在任何快照里 → 没有胶囊", () => {
  const snaps = [{ name: "584", entries: [entry("别的字体", "Roman", "ps:b")] }];
  assert.deepEqual(snapshotBadgesFor(".蘋方-繁", snaps), []);
});

test("快照按名字排序，输出稳定", () => {
  const snaps = [
    { name: "b", entries: [entry("F", "Roman", "ps:1")] },
    { name: "a", entries: [entry("F", "Italic", "ps:2")] },
  ];
  assert.deepEqual(
    snapshotBadgesFor("F", snaps).map((b) => b.name),
    ["a", "b"],
  );
});

test("分组：整族在组里 → 该族所有字重都算", () => {
  const badges = collectionBadgesFor("F", faces, { n: ["F"] }, {}, keyOf);
  assert.equal(badges.length, 1);
  assert.equal(badges[0].count, 3);
});

test("分组：只放了部分字重 → 只算那几个（用户最关心的场景）", () => {
  const badges = collectionBadgesFor(
    "F",
    faces,
    { n: [] },
    { n: ["ps:pingfangtc-ultralight", "ps:pingfangtc-bold"] },
    keyOf,
  );
  assert.equal(badges.length, 1);
  assert.deepEqual(badges[0].styles, ["極細體", "粗體"]);
  assert.equal(badges[0].count, 2);
});

test("分组：字族完全不在组里 → 没有胶囊", () => {
  assert.deepEqual(collectionBadgesFor("F", faces, { n: ["别的"] }, { n: [] }, keyOf), []);
});

test("分组：整族 + 字重成员同时存在 → 按整族算，不重复计数", () => {
  const badges = collectionBadgesFor(
    "F",
    faces,
    { n: ["F"] },
    { n: ["ps:pingfangtc-bold"] },
    keyOf,
  );
  assert.equal(badges[0].count, 3, "整族在组里时不该把 Bold 额外算一次");
});
