import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CARET_TYPES,
  charLengthAt,
  coveredCharBox,
  coveredIndexFor,
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
