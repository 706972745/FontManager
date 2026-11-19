import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 「在 PS / AI / CDR 中应用」对**缺 PostScript 名**的字体的契约（2026-11-19）。
 *
 * 背景：字体库里约 1.6% 的字面没有 PostScript 名（多半是国产老字体）。
 * 老代码把「有 PostScript 名」当成硬前置：字重菜单里菜单项直接 disabled，
 * 但禁用态与可用态没有任何视觉差异，用户点一下什么都不会发生 —— 报上来就是
 * 「PS 无法应用字体」，而实际连后端都没调用。
 *
 * 后端 `adobe::font_candidates` 本来就用族名 / 本地化名兜底，所以这一层不该拦；
 * 真正套不上时后端回 `font-not-found`，前端再解释「这个字体没有 PostScript 名」。
 *
 * 扫源码而不是渲染：这两条不变量一条在菜单装配、一条在 store 的调参，
 * 且真机 GUI 自动化在这台多屏机上坐标不可信。
 */
const read = (p: string) => readFileSync(p, "utf8");

/** 去掉注释行再比对：说明「以前怎么写」的注释里会原样出现旧代码，不算违规 */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const s = l.trim();
      return !s.startsWith("*") && !s.startsWith("//") && !s.startsWith("/*");
    })
    .join("\n");

test("缺 PostScript 名不再禁用菜单项", () => {
  const menus = codeOnly(read("src/lib/menus.tsx"));
  assert.doesNotMatch(
    menus,
    /disabled:\s*!face\.postscriptName/,
    "禁用态没有视觉差异，点不动等于「功能坏了」；要么不禁用，要么让禁用看得出来",
  );
});

test("缺 PostScript 名仍然发起应用，失败时才解释原因", () => {
  const store = codeOnly(read("src/state/fontStore.ts"));
  // 老写法：先判断、直接 return（后端一次都没调）
  assert.doesNotMatch(store, /if \(!lead\.postscriptName\)/, "族级应用不许再提前 return");
  assert.doesNotMatch(store, /if \(!face\.postscriptName\) \{/, "字重级应用不许再提前 return");
  // 空串交给后端，由 font_candidates 用族名 / 别名兜底
  assert.match(store, /lead\.postscriptName \?\? ""/);
  assert.match(store, /face\.postscriptName \?\? ""/);
  // 失败文案按「有没有 PostScript 名」分流
  assert.match(store, /reportApplyOutcome\(outcome, family, app, !!lead\.postscriptName\)/);
  assert.match(store, /reportApplyOutcome\(outcome, label, app, !!face\.postscriptName\)/);
});
