import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fitPickPanel, PICK_LIST_MIN, PICK_LIST_WANT } from "../src/lib/pickerFit.ts";

/**
 * 「从已有标签里选」面板：点开后必须自己撑满可视区，不能让用户再滚一下
 * （用户 2026-11-14 反馈：每点一次都得手动滚才能看到列表和确认按钮）。
 */
test("空间够：列表直接顶到上限，不动滚动条", () => {
  const r = fitPickPanel({ boxBottom: 900, btnBottom: 300, chrome: 90, gap: 6, room: 800 });
  assert.equal(r.listMax, PICK_LIST_WANT);
  assert.equal(r.scrollBy, 0);
});

test("空间差一点：先滚最小必要距离，列表仍然是满高", () => {
  // 按钮离底边只剩 300px，扣掉 chrome 后列表只有 ~190 —— 要补 ~130
  const r = fitPickPanel({ boxBottom: 900, btnBottom: 590, chrome: 90, gap: 6, room: 400 });
  assert.ok(r.scrollBy > 0, "应当产生滚动");
  assert.equal(r.listMax, PICK_LIST_WANT);
  // 滚完之后按钮上方的高度刚好等于：原剩余 + 滚动量
  const availBefore = 900 - 12 - (590 + 6) - 90;
  assert.equal(availBefore + r.scrollBy >= PICK_LIST_WANT, true);
});

test("滚不动了：列表压到下限，不返回负数", () => {
  const r = fitPickPanel({ boxBottom: 700, btnBottom: 690, chrome: 90, gap: 6, room: 0 });
  assert.equal(r.scrollBy, 0);
  assert.equal(r.listMax, PICK_LIST_MIN);
});

test("按钮已经在可视区外（负数空间）也不会算出负高度", () => {
  const r = fitPickPanel({ boxBottom: 600, btnBottom: 900, chrome: 90, gap: 6, room: 50 });
  assert.equal(r.listMax, PICK_LIST_MIN);
  assert.equal(r.scrollBy, 50, "只能滚到容器底部为止");
});

test("上限与下限都夹住：极端高的窗口不会把列表撑爆", () => {
  const r = fitPickPanel({ boxBottom: 5000, btnBottom: 10, chrome: 90, gap: 6, room: 0 });
  assert.equal(r.listMax, PICK_LIST_WANT);
});

/* ── 结构守卫：标签 chip 上不能再挂 motion 的 layout ──────────────────────────
   layout 投影用 bounding box 比对新旧位置，而 chip 的入场动画本身在跑 scale 0.85 → 1，
   两者叠加会让 chip 按 1/0.85 ≈ 1.18 反向缩放、并压住下一行 —— 就是「点开面板后
   上方手工标签偏移」。这条守卫防的是有人觉得「加个 layout 更顺滑」又加回去。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("手工标签 chip 不挂 motion layout（会被入场 scale 干扰成错位）", () => {
  const src = stripComments(readFileSync("src/components/DetailPanel.tsx", "utf8"));
  // 2.1.7 起 chip 的 map 换成了块体（要先算 `expirable`），两种写法都认
  const start = Math.max(
    src.indexOf("tags.map((tag) => ("),
    src.indexOf("tags.map((tag) => {"),
  );
  assert.ok(start > 0, "没找到手工标签的渲染块，守卫失效");
  const block = src.slice(start, src.indexOf("</motion.span>", start));

  // 正控：确认切到的是对的那一段
  assert.match(block, /className="tag-chip tag-chip-iconed"/);
  assert.match(block, /initial=\{\{ opacity: 0, scale: 0\.85 \}\}/);

  assert.doesNotMatch(block, /^\s*layout\s*$/m, "chip 上又加了 layout，会重新引入错位");
});

test("列表高度确实由 fitPickPanel 算出并写进内联样式", () => {
  const src = stripComments(readFileSync("src/components/DetailPanel.tsx", "utf8"));
  assert.match(src, /fitPickPanel\(\{/);
  assert.match(src, /scroller\.scrollTop \+= fit\.scrollBy/);
  assert.match(src, /<ul className="tag-picker-list" style=\{\{ maxHeight: listMax \}\}>/);
});
