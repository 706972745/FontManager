import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 侧栏两种行的选中态必须同构（标签行 `.tag-row` / 分组行 `.tag-row.coll-row`）。
 *
 * 分组行复用了 `.tag-row`，看起来"改一处两边都生效"，实际已经踩过两次：
 * ① 2.4.2 之前，`.tag-row:not(.tag-c-none).sel::before` 把分组行的蓝竖线盖成透明；
 * ② 2.4.2 之后竖线对了，但锚点没跟上 —— 标签行的圆点会点亮成强调色，
 *    分组行的文件夹图标只从三级灰挪到二级灰，并排看就是「标签有反应、分组没反应」
 *    （用户 2026-11-19 连提三次）。
 *
 * 所以这里不用单元逻辑去测，直接扫 `src/app.css`：选中态的**五件事**必须两边都在，
 * 且锚点换色的时长/曲线必须同一条。谁以后只改其中一边，这条会红。
 * 扫源码而不是渲染后计算样式：跑单测的环境里没有 WebView，能钉住的只有规则本身。
 */

const css = readFileSync("src/app.css", "utf8");

/** 取出某个选择器的规则体（按行首锚定，避免 `.tag-dot` 命中 `.tag-chip .tag-dot`）。 */
function ruleBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`(?:^|\\n)[ \\t]*${escaped}[ \\t]*\\{`, "m").exec(css);
  assert.ok(found, `src/app.css 里找不到规则 \`${selector}\`（改名或删规则时要同步更新这条测试）`);
  const start = found.index;
  return css.slice(start, css.indexOf("}", start) + 1);
}

/** 取出规则里的 `transition:` 声明，按逗号拆成逐条属性。 */
function transitionParts(selector: string): string[] {
  const decl = /transition:\s*([^;]+);/.exec(ruleBlock(selector));
  assert.ok(decl, `\`${selector}\` 里没有 transition —— 锚点换色会退回硬切`);
  return decl[1]
    .split(",")
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

test("选中态的底色两边同一档", () => {
  assert.match(ruleBlock(".tag-row.sel"), /background:\s*var\(--ui-hover\)/);
});

test("左侧竖线：底座透明 + 选中时 scaleY 展开（两种行共用同一条规则）", () => {
  const base = ruleBlock(".tag-row::before");
  assert.match(base, /background:\s*transparent/);
  assert.match(base, /transform:\s*scaleY\(0\.35\)/);

  const selected = ruleBlock(".tag-row.sel::before");
  assert.match(selected, /background:\s*var\(--ui-accent\)/);
  assert.match(selected, /transform:\s*scaleY\(1\)/);
});

test("行名右移 2px：分组行挂的也是 .tag-row-name，同一条规则生效", () => {
  assert.match(ruleBlock(".tag-row.sel > .tag-row-name"), /transform:\s*translateX\(2px\)/);
});

test("锚点点亮：标签看圆点，分组看文件夹图标，都落到强调色", () => {
  // 标签：圆点取 --tc；没配色的标签 `.tag-row.sel.tag-c-none` 把它设成 --ui-accent
  assert.match(ruleBlock(".tag-row.sel .tag-dot"), /background:\s*var\(--tc/);
  assert.match(ruleBlock(".tag-row.sel.tag-c-none"), /--tc:\s*var\(--ui-accent\)/);
  // 分组：文件夹图标直接点亮
  assert.match(ruleBlock(".coll-row.sel .coll-icon"), /color:\s*var\(--ui-accent\)/);
});

test("锚点换色同一个节奏：圆点与文件夹图标的时长和曲线逐条一致", () => {
  for (const selector of [".tag-dot", ".coll-icon"]) {
    const parts = transitionParts(selector);
    assert.ok(parts.length > 0, `\`${selector}\` 的 transition 是空的`);
    for (const part of parts) {
      assert.match(
        part,
        /var\(--t-micro\) var\(--ease-std\)$/,
        `\`${selector}\` 的 \`${part}\` 没走 --t-micro + --ease-std —— 两行锚点节奏会不一致`,
      );
    }
  }
});

test("按压反馈在深浅两套主题里都朝「更深」走（混 --text-primary 而不是写死色）", () => {
  const press = ruleBlock(".tag-row:active");
  assert.match(press, /background:\s*color-mix\(in srgb, var\(--text-primary\)/);
  assert.match(press, /var\(--ui-hover\)\)/);
});

/**
 * 按压的**动效**在 JS 里，不在 CSS 里：标签行是 `motion.div` + `whileTap` 弹簧，
 * 分组行如果只是普通 `div`，按下去就完全没有反应 —— CSS 那套选中态再怎么对齐，
 * 手感依然是一个"压一下弹回来"、一个"硬切"（用户 2026-11-19 的原话）。
 * 所以这条守的是「两行用的是同一组 motion 参数」，改一边必须同步另一边。
 */
test("分组行与标签行是同一组 motion 按压参数（不是普通 div）", () => {
  const tagDock = readFileSync("src/components/TagDock.tsx", "utf8");
  const sidebar = readFileSync("src/components/Sidebar.tsx", "utf8");
  const press = /whileTap=\{\{\s*scale:\s*0\.985,\s*transition:\s*springSnappy\s*\}\}/;

  assert.match(tagDock, press, "标签行的 whileTap 参数变了 —— 分组行必须同步");
  assert.match(sidebar, press, "分组行缺少与标签行相同的 whileTap：按下去会像硬切");

  // whileTap 只有 motion 组件认；普通 div 写了也无效，所以元素类型也要守
  const at = sidebar.indexOf("tag-row coll-row");
  assert.ok(at > 0, "Sidebar.tsx 里找不到分组行的 className");
  const tag = sidebar.slice(Math.max(0, at - 300), at);
  assert.match(tag, /<motion\.div/, "分组行不是 motion.div —— whileTap 不会生效");
});
