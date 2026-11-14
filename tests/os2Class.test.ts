import { test } from "node:test";
import assert from "node:assert/strict";
import { OS2_CLASS_NAMES, os2ClassName, os2ClassOf } from "../src/lib/os2Class.ts";
import { deriveTags, type FamilyFacts } from "../src/lib/derivedTags.ts";

/**
 * OS/2 分类（只读展示）。
 *
 * 这份测试守两件事：
 * ① 类目表必须与 OS/2 `sFamilyClass` 规范一致 —— 它是苹果 `CTFontStylisticClass`、
 *    Suitcase Fusion `Classification` 共同的上游，抄错一个 id 就等于跟别家软件对不上；
 * ② **它永远不许变成标签**。这套值一旦进了标签体系，就会有「同一个族既有 `vox:slab`
 *    又有 `Slab Serifs`」两条，筛选菜单立刻翻倍，而信息量是零。
 */

const facts = (over: Partial<FamilyFacts> = {}): FamilyFacts => ({
  name: "Rockwell",
  classification: "serif",
  scripts: ["latin"],
  features: [],
  isVariable: false,
  axes: [],
  monospaced: false,
  weights: [400],
  italic: false,
  ...over,
});

test("OS/2 类目表：规范里的 10 个 classId 一个不多一个不少", () => {
  assert.deepEqual(
    Object.keys(OS2_CLASS_NAMES).map(Number).sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 7, 8, 9, 10, 12],
  );
  assert.equal(OS2_CLASS_NAMES[1], "Oldstyle Serifs");
  assert.equal(OS2_CLASS_NAMES[5], "Slab Serifs");
  assert.equal(OS2_CLASS_NAMES[8], "Sans Serif");
  assert.equal(OS2_CLASS_NAMES[10], "Script");
  assert.equal(OS2_CLASS_NAMES[12], "Symbolic");
});

test("OS/2 类目表：0 / 保留位（6、11）/ 未知值都返回 null", () => {
  for (const id of [0, 6, 11, 13, 99, null, undefined]) {
    assert.equal(os2ClassName(id), null, `classId=${id} 不该有类名`);
  }
});

test("os2ClassOf：跳过未填写的字面，取第一个有值的", () => {
  const faces = [
    { sFamilyClass: null },
    { sFamilyClass: 0 },
    { sFamilyClass: (5 << 8) | 0 }, // Slab Serifs
    { sFamilyClass: (8 << 8) | 5 },
  ];
  assert.deepEqual(os2ClassOf(faces), { id: 5, label: "Slab Serifs" });
});

test("os2ClassOf：全族都没填时返回 null（真库 72.5% 属于这种）", () => {
  assert.equal(os2ClassOf([{ sFamilyClass: null }, { sFamilyClass: 0 }]), null);
  assert.equal(os2ClassOf([]), null);
});

test("os2ClassOf：只认高 8 位，subclassId 不影响类名", () => {
  const a = os2ClassOf([{ sFamilyClass: (8 << 8) | 0 }]);
  const b = os2ClassOf([{ sFamilyClass: (8 << 8) | 5 }]);
  assert.equal(a?.label, "Sans Serif");
  assert.equal(b?.label, "Sans Serif");
  assert.equal(a?.id, 8);
});

test("OS/2 类名永远不会变成标签（不进标签云 / 不进筛选）", () => {
  const labels = new Set(Object.values(OS2_CLASS_NAMES));
  // 给一组「最容易被 OS/2 带跑」的事实：拉丁衬线 + sFamilyClass=Slab + PANOSE 也是拉丁文本
  const tags = deriveTags(
    facts({
      panose: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      sFamilyClass: (5 << 8) | 0,
    }),
  ).map((d) => d.tag);

  for (const t of tags) {
    assert.ok(!labels.has(t), `标签里出现了 OS/2 类名「${t}」，它应当只出现在详情面板`);
    // 所有自动标签必须还是 `namespace:value` 形态，不能冒出裸的英文类名
    assert.match(t, /^[a-z]+:[a-z0-9-]+$/, `标签「${t}」不符合 命名空间:值 的形态`);
  }
});
