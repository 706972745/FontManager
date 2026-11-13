import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 全量落地接线的结构守卫（2.1.4 / D-1 复验时补）。
 *
 * 为什么需要它：D-1 的修复分两半 —— `seedOverrides.landFullScan` 把「叠加 + 清空」
 * 绑在一起（纯函数，`seedOverrides.test.ts` 已钉住），以及 `fontStore.applyFullScan`
 * **确实调用了它**（store 依赖 Tauri `invoke`，Node 里 import 不进来，没法用行为测试）。
 *
 * 少了这一半的守卫，就会出现「纯函数测试全绿、store 却把旧覆盖表原样 set 回去」的
 * 假绿灯 —— 那正是 D-1 的形状。所以这里退一步做**结构**断言：钉住 store 里那 4 行
 * 接线（调用哪个函数、`overrides` 由谁提供），以及已删除的 `pruneOverrides` 不得复活。
 *
 * 代价是这条用例跟源码文本耦合：断言刻意写得窄（只认「调用 landFullScan」+
 * 「set 里唯一的 overrides 来自 landed」），改动 store 其它部分不会误报。
 */
const STORE = readFileSync(new URL("../src/state/fontStore.ts", import.meta.url), "utf8");

/** 截出 `applyFullScan: (full) => { ... },` 的函数体（到下一个 action `noteOverrides` 为止） */
function applyFullScanBody(): string {
  const start = STORE.indexOf("applyFullScan: (full) => {");
  assert.notEqual(start, -1, "fontStore 里找不到 applyFullScan —— 动作被改名或删掉了");
  const end = STORE.indexOf("noteOverrides:", start);
  assert.notEqual(end, -1, "applyFullScan 之后找不到 noteOverrides，无法界定函数体");
  return STORE.slice(start, end);
}

test("applyFullScan lands through landFullScan", () => {
  const body = applyFullScanBody();
  assert.match(
    body,
    /landFullScan\(\s*full\s*,/,
    "applyFullScan 没有走 landFullScan：叠加与清空又会被拆成两半，D-1 会复发",
  );
});

test("applyFullScan publishes the landed override map, not the old one", () => {
  const body = applyFullScanBody();
  assert.match(
    body,
    /\boverrides:\s*landed\.overrides\b/,
    "set({...}) 里的 overrides 不是 landFullScan 返回的那张 —— 旧的覆盖表会被原样写回 store",
  );
  // set({...}) 里只允许出现一处 `overrides:`，且必须是 landed 那张。
  // 多出来的第二处（例如有人把 `pruneOverrides(...)` 加回来）会让这条断言变红。
  const assignments = body.match(/\boverrides:/g) ?? [];
  assert.equal(
    assignments.length,
    1,
    `applyFullScan 里有 ${assignments.length} 处 overrides: 赋值，只应有一处（landed.overrides）`,
  );
});

test("pruneOverrides stays deleted", () => {
  // 它的语义（只裁掉「路径已不存在」的条目）挡不住 D-1：要命的是**还活着**的旧决策。
  // 留着它只会让下一次改这块的人以为「裁剪就够了」。
  //
  // 只查**代码**：注释里提到 pruneOverrides（比如解释它为什么被删掉）不该误报，
  // 所以先把 `//` 与 `/* */` 剥掉再判。
  const code = STORE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(
    code,
    /\bpruneOverrides\b/,
    "pruneOverrides 被重新引入了 —— 它的语义不足以避免旧覆盖项跨扫描生效（见 D-1）",
  );
});
