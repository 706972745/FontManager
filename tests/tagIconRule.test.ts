import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AUTO_TAG_IDS,
  CLASS_TAGS,
  CN_STYLES,
  DECOR_WORDS,
  VOX_BY_CLASS,
  isAutoTagId,
} from "../src/lib/tagVocabulary.ts";

/**
 * 「魔棒还是标签」这个图标必须是按**名字**判的。
 *
 * 用户 2026-11-14 定的规矩：
 * ① 用户把自动标签「认可」成手工标签之后，图标不能变回手工；
 * ② 用户删掉某条自动标签、后来又手打了同一个名字，也照样是魔棒；
 * ③ 只有用户自己造的词才是标签图标。
 * 所以判据只能是「这个名字在不在软件的自动标签词表里」，不能看它存在 state.json 还是运行时。
 */

test("软件词表里的 id 全部认得（含字面量规则那批）", () => {
  // 每个命名空间抽一条：漏一条都说明 AUTO_TAG_IDS 没跟上词表
  for (const id of [
    "class:serif",
    "class:sans",
    "cn:song",
    "cn:hei",
    "decor:outline",
    "vox:garalde",
    "use:poster",
    "form:condensed",
    "form:heavy",
    "tech:tabular-figures",
    "tech:monospaced-candidate",
    "style:italic",
    "weight:has-bold",
  ]) {
    assert.ok(isAutoTagId(id), `${id} 应当被认成自动标签`);
  }
});

test("用户自己造的名字不是自动标签", () => {
  for (const mine of ["我的宋体", "品牌A专用", "待确认授权", "Song", "cn:自定义", "mood:happy", ""]) {
    assert.equal(isAutoTagId(mine), false, `「${mine}」不该有魔棒`);
  }
});

test("词表驱动的命名空间一条不漏（从数据算，不靠手抄）", () => {
  for (const v of Object.values(CLASS_TAGS)) assert.ok(AUTO_TAG_IDS.has(v), v);
  for (const s of CN_STYLES) assert.ok(AUTO_TAG_IDS.has(s.value), s.value);
  for (const d of DECOR_WORDS) assert.ok(AUTO_TAG_IDS.has(d.value), d.value);
  for (const v of Object.values(VOX_BY_CLASS)) assert.ok(AUTO_TAG_IDS.has(v), v);
});

/**
 * 结构守卫：`derivedTags.ts` 里的字面量规则没法从数据推，
 * 只能手抄进 `AUTO_TAG_IDS` —— 这条测试扫源码，保证「加了新规则忘了登记」会红。
 */
test("derivedTags.ts 里每一处 `tag: \"...\"` 都登记进了 AUTO_TAG_IDS", () => {
  const src = readFileSync("src/lib/derivedTags.ts", "utf8");
  const found = [...src.matchAll(/tag:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(found.length >= 20, `只扫到 ${found.length} 条字面量，扫描规则可能失效了`);

  const missing = [...new Set(found)].filter((t) => !AUTO_TAG_IDS.has(t));
  assert.deepEqual(missing, [], `这些 id 没登记，界面上会错用「标签」图标：${missing.join(", ")}`);
});

/**
 * 反向守卫：侧栏 / 顶栏筛选 / 详情面板三处都改成了按名字判定。
 * 谁要是改回「只有自动标签撑起来的才用魔棒」，这里会红 —— 那正是用户报的问题。
 */
test("三处图标判定都走 isAutoTagId，没有退回 autoOnly", () => {
  for (const file of [
    "src/components/Sidebar.tsx",
    "src/components/TopBar.tsx",
    "src/components/DetailPanel.tsx",
  ]) {
    const src = readFileSync(file, "utf8");
    assert.match(src, /isAutoTagId\(/, `${file} 没使用 isAutoTagId`);
    assert.doesNotMatch(src, /autoOnlyTags\.has\(/, `${file} 又按「只有自动标签」判定了`);
  }
});
