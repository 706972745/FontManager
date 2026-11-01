import { test } from "node:test";
import assert from "node:assert/strict";
import { familyClassification } from "../src/lib/familyState.ts";
import type { Classification, FontFace } from "../src/lib/ipc.ts";

const face = (style: string, classification: Classification) =>
  ({ style, classification }) as unknown as FontFace;

test("回归：族分类看代表字面（Regular），不是「第一个非 unknown 的字面」", () => {
  // 这正是「勾了衬线，列表里却出现无衬线卡片」的根因：
  // 聚循环里 Italic 先被扫到，整族就被定成 serif，而卡片画的是 Regular（sans）
  const faces = [face("Italic", "serif"), face("Regular", "sans")];
  assert.equal(familyClassification(faces), "sans");
  // 顺序反过来也要是 sans —— 代表字面的口径不该被扫描顺序影响
  assert.equal(familyClassification([face("Regular", "sans"), face("Italic", "serif")]), "sans");
});

test("没有 Regular 时，代表字面取排序后的第一个", () => {
  assert.equal(
    familyClassification([face("Bold", "mono"), face("Italic", "script")]),
    "mono",
  );
});

test("代表字面是 unknown 时，退到全族出现最多的分类", () => {
  const faces = [
    face("Regular", "unknown"),
    face("Italic", "display"),
    face("Bold", "display"),
    face("Black", "mono"),
  ];
  assert.equal(familyClassification(faces), "display");
});

test("全是 unknown / 空列表都按 unknown 处理，不会崩", () => {
  assert.equal(familyClassification([face("Regular", "unknown")]), "unknown");
  assert.equal(familyClassification([]), "unknown");
});

test("代表字面有分类时，多数派不会盖掉它", () => {
  // Regular 是唯一的 sans，其余九个字面都是 serif —— 卡片画的是 Regular，就该判 sans
  const faces = [
    face("Regular", "sans"),
    ...Array.from({ length: 9 }, (_, i) => face(`Style${i}`, "serif")),
  ];
  assert.equal(familyClassification(faces), "sans");
});
