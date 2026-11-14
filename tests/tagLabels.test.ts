import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TAG_LABEL_KEYS, tagLabel } from "../src/lib/tagLabels.ts";
import {
  CLASS_TAGS,
  CN_STYLES,
  DECOR_WORDS,
  VOX_BY_CLASS,
} from "../src/lib/tagVocabulary.ts";
import type { TKey } from "../src/lib/i18n.ts";

/**
 * 自动标签的显示名。
 *
 * 三条不能破的规矩：
 * ① 内部 id 不变（`cn:song` 永远是 `cn:song`），只有显示层跟着语言走；
 * ② **用户自己打的标签一个字都不许改** —— 切语言时「我的宋体」必须还是「我的宋体」；
 * ③ Vox 专名保持英文（Garalde / Didone / Neo-grotesque 是字体史术语，翻译反而对不上文献）。
 */

// 假的 t：只把 key 原样包起来，用来证明「走的是哪条分支」，不依赖真的语言包
const fakeT = (key: TKey) => `«${key}»`;

test("词表里的标签都有显示名，走了翻译分支", () => {
  assert.equal(tagLabel("cn:song", fakeT), "«tagl.cn.song»");
  assert.equal(tagLabel("class:serif", fakeT), "«tagl.cls.serif»");
  assert.equal(tagLabel("decor:outline", fakeT), "«tagl.decor.outline»");
  assert.equal(tagLabel("weight:has-bold", fakeT), "«tagl.weight.hasBold»");
});

test("用户自己的标签原样返回（切语言不受影响）", () => {
  for (const mine of ["我的宋体", "品牌A专用", "待确认授权", "cn:Song", "Song"]) {
    assert.equal(tagLabel(mine, fakeT), mine, `「${mine}」被改写了`);
  }
});

test("Vox 专名保持英文，只提首字母", () => {
  assert.equal(tagLabel("vox:neo-grotesque", fakeT), "Neo-grotesque");
  assert.equal(tagLabel("vox:garalde", fakeT), "Garalde");
  assert.equal(tagLabel("vox:humanist-sans", fakeT), "Humanist-sans");
});

test("不认识的自动标签露原值（方便排查，不做猜测式翻译）", () => {
  assert.equal(tagLabel("foo:bar", fakeT), "foo:bar");
  assert.equal(tagLabel("class:weird", fakeT), "class:weird");
});

test("规则能产出的每一个标签都有显示名（未来新增值必须同时补文案）", () => {
  const src = readFileSync("src/lib/derivedTags.ts", "utf8");
  const literal = [...src.matchAll(/tag: "([a-z]+:[a-z0-9-]+)"/g)].map((m) => m[1]);

  const ids = new Set<string>([
    ...literal,
    ...Object.values(CLASS_TAGS),
    ...CN_STYLES.map((d) => d.value),
    ...DECOR_WORDS.map((d) => d.value),
    ...Object.values(VOX_BY_CLASS),
  ]);

  const missing: string[] = [];
  for (const id of ids) {
    if (id.startsWith("vox:")) continue; // 专名走 prettify 分支，不需要词条
    if (!TAG_LABEL_KEYS[id]) missing.push(id);
  }
  assert.deepEqual(missing, [], "这些标签会以原始 id 显示在界面上，请补 TAG_LABEL_KEYS 与 9 份语言包");
});

test("一级分类的五个值都能映射成标签，unknown 不产", () => {
  assert.deepEqual(Object.keys(CLASS_TAGS).sort(), ["display", "mono", "sans", "script", "serif"]);
  assert.equal(CLASS_TAGS.unknown, undefined);
});
