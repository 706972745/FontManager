import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 契约守卫（不是行为测试 —— 这个仓库没有 React / DOM 测试环境，见报告）。
 *
 * 2026-11-12 这批改动里有两件事**无法**用行为测试表达，但一旦被改坏，症状极难发现：
 *
 * ① 「字重名点击复制」和「右键菜单 › 复制名字」必须粘出**逐字一致**的一串。
 *    唯一的保证方式是两条路调**同一个函数、传同一个参数**。行为测试只能分别断言
 *    各自的输出，改了其中一处它照样绿；这里改断言「只有一处拼法」。
 * ② 点搜索建议时，「输入框显示什么」和「跳转到哪个族」是两个不同的值
 *    （`label` = 本地化显示名，`value` = 族名主键）。中文界面下把 `label` 当族名用，
 *    表现为「点了建议，界面毫无反应」—— 而它不会让任何类型检查或单元测试变红。
 *
 * 所以这里读源码文本做断言：丑，但比没有好，而且失败信息直接指向该改哪一行。
 * 纯逻辑部分（退回链）在 `faceName.test.ts` 里是真跑函数的。
 */

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("「复制名字」只有一份拼法：字重名点击与右键菜单都调 faceFullName(family.name, face)", () => {
  const faceLine = src("../src/components/FaceLine.tsx");
  const menus = src("../src/lib/menus.tsx");

  // 两处都走同一个函数、且第一个参数都是族名**主键** family.name（不是显示名）：
  // 传 displayName 会得到「中文界面下粘出来是中文名」的分叉。
  assert.match(faceLine, /faceFullName\(family\.name, face\)/);
  assert.match(menus, /faceFullName\(family\.name, face\)/);

  // 老的内联拼法不许复活（2026-11-12 之前的写法，style 为 undefined 时会粘出 "undefined"）
  assert.ok(
    !menus.includes("${family.name} ${face.style}"),
    "menus.tsx 又出现了内联拼法，请改回 faceFullName()",
  );
});

test("搜索建议：跳转用 value（族名键）、显示用 label，两者不混", () => {
  const topBar = src("../src/components/TopBar.tsx");
  const suggest = src("../src/components/SearchSuggest.tsx");

  // label 是本地化显示名 → 只进输入框
  assert.match(topBar, /setSearchText\(sg\.label\)/);
  // value 才是 family.name → 只用于跳转；其余三类建议没有 value，按 label 退回
  assert.match(topBar, /jumpToFamily\(sg\.value \?\? sg\.label\)/);
  assert.ok(
    !/jumpToFamily\(sg\.label\)/.test(topBar),
    "跳转不能直接吃 label：中文界面下 label ≠ 族名键，跳转会整条失效",
  );

  // 生成建议时只有「字体」这一类带 value
  assert.match(suggest, /kind: "family".*value: f\.name/);
});
