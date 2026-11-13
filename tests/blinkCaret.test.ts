import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCaretX, sliceToCaret } from "../src/design/primitives/blinkCaret.ts";

/**
 * 自绘闪烁块状光标（2026-11-13）的定位纯函数。
 *
 * 组件没法在 node 里测（node --test 不转 JSX），所以镜像测宽的**几何部分**
 * 全部收敛在 computeCaretX / sliceToCaret 这两个纯函数里，在这里测：
 * - 文本超宽 + scrollLeft>0 时贴右缘（用户最常用的「点末尾继续输入」路径）；
 * - selectionStart 越界不得产生 NaN —— 光标 left 一旦是 NaN，整个竖条直接消失；
 * - 中文/增补平面字符按 code unit 切，与 input.selectionStart 同一口径。
 */

test("computeCaretX：常规定位与空内容", () => {
  // 选择点在中间：镜像宽就是答案
  assert.equal(computeCaretX("abc", 2, 40, 0, 200), 40);
  // 空输入框：光标在最左
  assert.equal(computeCaretX("", 0, 0, 0, 200), 0);
  // 内容区非法（clientWidth 0 / 负数，输入框还没布局出来）：不产生 NaN，贴左缘
  assert.equal(computeCaretX("abc", 3, 40, 0, 0), 0);
  assert.equal(computeCaretX("abc", 3, 40, 0, -5), 0);
});

test("computeCaretX：文本超宽时贴右缘、滚到左边贴左缘", () => {
  // 末尾 + 未滚动：镜像 500 > 内容区 200 → 夹到 200（贴右缘）
  assert.equal(computeCaretX("x".repeat(300), 300, 500, 0, 200), 200);
  // 已滚动 scrollLeft=300：raw = 500-300 = 200 → 仍是 200（末尾永远贴右缘）
  assert.equal(computeCaretX("x".repeat(300), 300, 500, 300, 200), 200);
  // 滚得多、选择点在中段：raw = 500-450 = 50
  assert.equal(computeCaretX("x".repeat(300), 50, 500, 450, 200), 50);
  // scrollLeft 超过镜像宽（越滚越多）：夹到左缘 0
  assert.equal(computeCaretX("x".repeat(300), 0, 500, 600, 200), 0);
});

test("computeCaretX：selectionStart 越界不得产生 NaN", () => {
  // 程序化 setSelectionRange / 竞态会把 selectionStart 顶过字符串长度
  const got = computeCaretX("abc", 999, 40, 0, 200);
  assert.ok(Number.isFinite(got), `必须是有限数，实际 ${got}`);
  assert.ok(got >= 0 && got <= 200, `必须夹在 [0,200]，实际 ${got}`);
  // 负数也一样
  const neg = computeCaretX("abc", -7, 40, 0, 200);
  assert.ok(Number.isFinite(neg) && neg >= 0 && neg <= 200);
});

test("sliceToCaret：中文按字符、增补平面按 code unit、越界夹取", () => {
  // 中文：selectionStart=2 是「两个汉字」，不是两个字节
  assert.equal(sliceToCaret("字体库abc", 2), "字体");
  // 增补平面（𝐀 是两个 code unit）：input.selectionStart 也是 code unit 口径 ——
  // 所以 sel=2 只到「𝐀 的末尾」，光标没法停在 𝐀 和 𝐁 之间，这与原生行为一致
  assert.equal(sliceToCaret("𝐀𝐁x", 2), "𝐀");
  assert.equal(sliceToCaret("𝐀𝐁x", 4), "𝐀𝐁");
  assert.equal(sliceToCaret("𝐀𝐁x", 5), "𝐀𝐁x");
  // 越界：负数 → 空串；超过长度 → 全文
  assert.equal(sliceToCaret("字体", -1), "");
  assert.equal(sliceToCaret("字体", 99), "字体");
});
