import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CARET_TYPES,
  caretHeightFor,
  caretTopFor,
  charLengthAt,
  coveredCharBox,
  coveredIndexFor,
  textStartOffset,
} from "../src/design/primitives/blinkCaret.ts";

/**
 * 块状光标（蓝块包字 + 白字，2026-11-13 二次修正）的定位纯函数。
 *
 * 组件没法在 node 里测（node --test 不转 JSX），所以镜像测宽的**几何部分**
 * 全部收敛在 coveredIndexFor / coveredCharBox / charLengthAt 里，在这里测：
 * - coveredIndex 三态（末尾盖最后一个 / 开头盖第一个 / 空输入不盖）；
 * - 越界 selectionStart 与增补平面字符不得产生半个字符或 NaN；
 * - 左缘裁切：字符滚出可视区左边时块收回可视区、白字形贴回真实位置。
 */

test("coveredIndexFor：三态、越界夹取、增补平面整对回退", () => {
  // 末尾：盖最后一个字符
  assert.equal(coveredIndexFor("你好", 2), 1);
  // 光标在最前且有内容：盖第一个字符
  assert.equal(coveredIndexFor("你好", 0), 0);
  // 空输入：不盖任何字符
  assert.equal(coveredIndexFor("", 0), -1);
  // 越界 selectionStart：夹进 [0, len]
  assert.equal(coveredIndexFor("abc", 99), 2);
  assert.equal(coveredIndexFor("abc", -7), 0);
  // 增补平面（𝐀 占两个 code unit）：光标在它后面（sel=2）回退到整对的起点
  assert.equal(coveredIndexFor("𝐀𝐁x", 2), 0);
  assert.equal(charLengthAt("𝐀𝐁x", 0), 2);
  assert.equal(charLengthAt("你好", 1), 1);
});

test("coveredCharBox：常规定位、字符宽度自适应、blockPad 放宽", () => {
  // 中文：块宽 = 字符 advance（镜像实测传入）
  const cn = coveredCharBox("你好", 2, 14, 14, 0, 200);
  assert.deepEqual(cn, { left: 14, width: 14, char: "好", glyphShift: 0 });
  // 拉丁窄字符：同一套几何，宽度天然不同（由镜像实测决定）
  const latin = coveredCharBox("fix", 2, 10, 4, 0, 200);
  assert.deepEqual(latin, { left: 10, width: 4, char: "i", glyphShift: 0 });
  // 增补平面：char 是完整的一对，不是半个代理
  const astral = coveredCharBox("𝐀𝐁x", 2, 20, 18, 0, 200);
  assert.equal(astral.char, "𝐀");
  // blockPad=4（清晰度优先）：块比字符左右各宽 4px，白字形仍贴在字符真实位置
  const padded = coveredCharBox("你好", 2, 14, 14, 0, 200, 4);
  assert.deepEqual(padded, { left: 10, width: 22, char: "好", glyphShift: 4 });
});

test("coveredCharBox：左缘裁切 —— 块收回可视区，白字形贴回真实位置", () => {
  // 无 pad：字符滚出左边一半：rawLeft = 10-30 = -20 → left 夹到 0，宽 = 26-20 = 6，
  // 白字形相对块左缘 -20（被块的 overflow:hidden 裁掉，露出的部分与真实字形一致）
  const clipped = coveredCharBox("你好", 2, 10, 26, 30, 200);
  assert.deepEqual(clipped, { left: 0, width: 6, char: "好", glyphShift: -20 });
  // 整个字符滚出左边：宽度归 0（块不可见）
  const gone = coveredCharBox("你好", 2, 10, 26, 100, 200);
  assert.equal(gone.left, 0);
  assert.equal(gone.width, 0);
  assert.equal(gone.glyphShift, -90);
  // 有 pad 的裁切：块左缘 = 字符左缘 − pad 再夹 0；
  // rawCharLeft=-20、pad=4 → rawLeft=-24 → left=0，宽 = −20+26+4 = 10，
  // 即「字符可见部分 (6px) + 右侧 pad (4px)」，白字形在块内 −20px 被裁到只剩可见部分
  const padded = coveredCharBox("你好", 2, 10, 26, 30, 200, 4);
  assert.deepEqual(padded, { left: 0, width: 10, char: "好", glyphShift: -20 });
});

test("coveredCharBox：空输入退化为空盒；password 不在自绘集合", () => {
  // 空输入：char null → 组件渲染 0.55em 空块（CSS），几何无意义
  assert.deepEqual(coveredCharBox("", 0, 0, 0, 0, 200), {
    left: 0,
    width: 0,
    char: null,
    glyphShift: 0,
  });
  // password 必须不在自绘集合（镜像会把明文塞进 DOM）
  assert.equal(CARET_TYPES.has("password"), false);
  assert.equal(CARET_TYPES.has("text"), true);
});

// 2026-11-15 用户口径「光标比字大一点就行」：参考截图里 36px 输入框、13px 字号，
// 蓝块只有 ~15px 高。旧实现 top:0;bottom:0 会跟着输入框一起变成 36px。
test("caretHeightFor / caretTopFor：块高只跟字号走，不跟输入框高度走", () => {
  // 13px 字号 → 15px 块（字号 + 2），与参考截图一致
  assert.equal(caretHeightFor(13), 15);
  assert.equal(caretHeightFor(11), 14); // 小字控件有 14px 下限，不细成一条线
  assert.equal(caretHeightFor(32), 34); // 32px 预览字也只比字大 2px
  // 关键回归：同一个字号，输入框从 24px 换到 64px，块高**必须不变**
  const h24 = caretHeightFor(13);
  const h64 = caretHeightFor(13);
  assert.equal(h24, h64);
  assert.ok(h64 < 24, "块高不能撑满最小的输入框");
  // 只改垂直居中位置
  assert.equal(caretTopFor(36, 15), 11); // (36-15)/2 = 10.5 → 11
  assert.equal(caretTopFor(24, 15), 5); // (24-15)/2 = 4.5 → 5
  assert.equal(caretTopFor(10, 15), 0); // 控件比块还矮时不许出现负 top
  // 非法字号走 13px 兜底，不能产出 NaN / 0
  assert.equal(caretHeightFor(Number.NaN), 15);
  assert.equal(caretHeightFor(0), 15);
});

// 2.2.4：端口号 / 字符筛选这类 `text-align:center` 的窄输入框。镜像测宽是左对齐的，
// 不补偏移蓝块就贴左边跑（实测端口框偏左约 30px）。
test("textStartOffset：只有居中/右对齐才偏移，文本装不下时归零", () => {
  // 左对齐：有没有富余都不偏移
  assert.equal(textStartOffset("left", 96, 30), 0);
  assert.equal(textStartOffset("start", 96, 30), 0);
  assert.equal(textStartOffset("justify", 96, 30), 0);
  assert.equal(textStartOffset("", 96, 30), 0);
  // 居中：富余的一半
  assert.equal(textStartOffset("center", 96, 30), 33);
  assert.equal(textStartOffset("center", 96, 0), 48); // 空输入：块贴在居中位置
  // 右对齐（end 在 LTR 下等同 right）
  assert.equal(textStartOffset("right", 96, 30), 66);
  assert.equal(textStartOffset("end", 96, 30), 66);
  // 文本比内容区宽（开始横向滚动）：交给 scrollLeft，不再偏移
  assert.equal(textStartOffset("center", 40, 80), 0);
  assert.equal(textStartOffset("right", 40, 40), 0);
  // 非数字输入不能产出 NaN
  assert.equal(textStartOffset("center", Number.NaN, 30), 0);
});
