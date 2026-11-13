import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyOverrides,
  countKnown,
  landFullScan,
  navCountText,
  nextOverrides,
} from "../src/lib/seedOverrides.ts";

/**
 * 扫描期间的「用户决策覆盖」（2.1.4 / ADR-08）。
 *
 * 这几条规则是「读着读着把用户刚启用的字体又变回停用」的唯一防线，
 * 而且全是纯函数 —— 放在这里测比对着界面点一遍可靠得多。
 */
const face = (path: string, active: boolean, deactivatable = true) => ({
  path,
  active,
  deactivatable,
});

/** U18：扫描中把 X 停用，全量结果里 X 还是 active（扫描用的是开始那一刻的快照）→ 以用户为准 */
test("full scan keeps a deactivation made while scanning", () => {
  const full = [face("C:/f/x.ttf", true), face("C:/f/y.ttf", false)];
  const out = applyOverrides(full, new Map([["C:/f/x.ttf", false]]));
  assert.equal(out.find((f) => f.path === "C:/f/x.ttf")?.active, false);
  // 没被覆盖的那一条保持扫描结论
  assert.equal(out.find((f) => f.path === "C:/f/y.ttf")?.active, false);
});

/** 反过来也一样：扫描期间启用的，不能被旧快照改回停用 */
test("full scan keeps an activation made while scanning", () => {
  const out = applyOverrides([face("C:/f/x.ttf", false)], new Map([["C:/f/x.ttf", true]]));
  assert.equal(out[0].active, true);
});

/** U19：覆盖项指向的路径已经不在全量结果里 → 不复活它，覆盖项也要被裁掉 */
test("stale overrides never resurrect a path and get pruned", () => {
  const full = [face("C:/f/kept.ttf", true)];
  const overrides = new Map([
    ["C:/f/kept.ttf", true],
    ["C:/f/deleted.ttf", true],
  ]);
  const out = applyOverrides(full, overrides);
  assert.deepEqual(
    out.map((f) => f.path),
    ["C:/f/kept.ttf"],
    "覆盖表不能凭空造出字体",
  );
  // 落地后覆盖表清空（landFullScan），所以「路径已不存在」的条目也不可能留到下一轮
  assert.equal(landFullScan(full, overrides).overrides.size, 0);
});

/** U20：只读字面（系统字体）不覆盖 —— 注册表里根本改不动它，覆盖只会让界面撒谎 */
test("read-only faces are never overridden", () => {
  const out = applyOverrides(
    [face("C:/Windows/Fonts/arial.ttf", true, false)],
    new Map([["C:/Windows/Fonts/arial.ttf", false]]),
  );
  assert.equal(out[0].active, true);
});

/** U21：扫描结束后再记没有任何意义（结果已经是新的了），只会让 map 无限增长 */
test("noteOverrides only collects while scanning", () => {
  const prev = new Map<string, boolean>();
  // nextOverrides 本身不认识 phase —— 由 store 的 noteOverrides 把关；
  // 这里钉住「空路径不产生新 map」这条，避免每次批量都白建一个 Map 触发重渲染
  assert.equal(nextOverrides(prev, [], true), prev);
  const next = nextOverrides(prev, ["C:/f/a.ttf", "C:/f/b.ttf"], true);
  assert.equal(next.get("C:/f/a.ttf"), true);
  assert.equal(next.get("C:/f/b.ttf"), true);
  // 原 map 不被就地改写：zustand 靠引用变化判断要不要重渲染
  assert.equal(prev.size, 0);
});

/** U22：没有覆盖项时直接返回原数组（避免一次无意义的全量 map，几千条也不便宜） */
test("applyOverrides is a no-op when nothing was touched", () => {
  const full = [face("C:/f/a.ttf", true)];
  assert.equal(applyOverrides(full, new Map()), full);
});

/**
 * 侧栏计数三态（PRD US-4）：`undefined` 不显示、`null` 显示 `…`、数字原样。
 * 用 `count !== undefined` 判空的写法会把 `null` 渲染成字符串 "null" —— 这条钉住它。
 */
test("nav count renders unknown as an ellipsis, not as zero", () => {
  assert.equal(navCountText(undefined), null);
  assert.equal(navCountText(null), "…");
  assert.equal(navCountText(0), "0");
  assert.equal(navCountText(4214), "4214");
});

/* ────────────────────────────────────────────────────────────────────────────
 * QA（2.1.4 独立验证）补充：覆盖项的生命周期
 *
 * 设计 §3.3 的原文：「只在 `phase === "scanning"` 期间非空，`applyFullScan` 之后清空。」
 *
 * 下面这条钉住的是它的**行为后果**，而不是某个实现细节：一轮扫描结束时留在 map 里的
 * 覆盖项，必须已经「用掉」了 —— 不能让上一轮的决策在**下一轮**扫描里再赢一次。
 * 因为 noteOverrides 只在 scanning 期间记录，而 applyFullScan 会记 fullScanDone，
 * 用户在全量落地之后做的启停**不会**更新 map；那份旧决策留在 map 里就是纯粹的脏数据。
 * ──────────────────────────────────────────────────────────────────────────── */
test("overrides from a finished scan must not win again in the next scan", () => {
  const X = "C:/f/x.ttf";

  // 扫描 1 进行中：用户把 X 停用（这正是 PRD A4 明确允许的操作）
  const scan1Overrides = nextOverrides(new Map(), [X], false);
  // 扫描 1 落地：store 走的就是 landFullScan（fontStore.applyFullScan）。
  // 全量结果里 X 被压成停用（正确），同时覆盖表被清空。
  const landed1 = landFullScan([face(X, true)], scan1Overrides);
  assert.equal(landed1.fonts[0].active, false);

  // 「存活下来的覆盖表」= 落地函数返回的那张，store 会直接 set 回去
  const carried = landed1.overrides;

  // 之后（phase 已是 ready）用户又把 X 启用 —— noteOverrides 此时不记录（设计如此）
  // 扫描 2：注册表里 X 确实是启用的，扫描结论也是 active=true
  const scan2 = [face(X, true)];
  const landed2 = landFullScan(scan2, carried);

  assert.equal(
    carried.size,
    0,
    "扫描 1 的覆盖项被带进了扫描 2：下一轮全量会用它压过真实注册表状态，" +
      "界面从此长时间显示错的启用状态（落地后必须清空，不能只裁剪已消失路径）",
  );
  assert.equal(landed2.fonts[0].active, true, "扫描 2 的真实结论被上一轮的旧决策覆盖了");
});

/**
 * 侧栏计数的分档（2.1.4 第二版，用户 2026-11-13 反馈后重做）。
 *
 * 第一版用「首次全量是否落地」一个开关管住全部数字，于是「已启用 / 系统字体 /
 * 启用至关闭 / 分组」明明已经全在种子里、数量确定，却也被打成 `…`；空分组更是
 * 该显示 0 的地方显示 `…`。用户原话：「既然…先启用，那没启用前应该都是…，
 * 那一部分完全启用的就应该显示出数字才对」。
 */
test("计数分档：种子覆盖全集的类别在种子落地后即显示数字，其余等全量", () => {
  const nothing = { fullScanDone: false, seedLanded: false };
  assert.equal(countKnown("seed", nothing), false, "种子还没到，任何数字都是猜的");
  assert.equal(countKnown("whole", nothing), false);

  const seedOnly = { fullScanDone: false, seedLanded: true };
  assert.equal(
    countKnown("seed", seedOnly),
    true,
    "已启用 / 系统字体 / 分组 / 启用至关闭这几类必然全在种子里，种子一到数量就确定了",
  );
  assert.equal(
    countKnown("whole", seedOnly),
    false,
    "字体库总数 / 已停用 / 标签的分母是整个字库，全量没读完必然算错，必须保持 …",
  );

  const done = { fullScanDone: true, seedLanded: false };
  assert.equal(countKnown("seed", done), true, "空种子走骨架屏流程时，全量落地后照样要出数字");
  assert.equal(countKnown("whole", done), true);
});

test("计数分档：种子已覆盖但集合为空时显示 0，不是 …", () => {
  // 空分组：种子落了、组里就是没东西 —— 用户明确要求这时候是 0
  assert.equal(navCountText(0), "0");
  // 而这个集合在种子到达前是不该给数字的
  assert.equal(navCountText(null), "…");
});
