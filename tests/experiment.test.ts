import { test } from "node:test";
import assert from "node:assert/strict";
import { experiment, parseExpBool, parseExpNumber } from "../src/lib/experiment.ts";

test("parseExpNumber：没有配置就用默认值", () => {
  assert.equal(parseExpNumber(null, 6), 6);
  assert.equal(parseExpNumber("", 6), 6);
  assert.equal(parseExpNumber("   ", 6), 6);
});

test("parseExpNumber：非法值回退，不抛错", () => {
  assert.equal(parseExpNumber("abc", 6), 6);
  assert.equal(parseExpNumber("NaN", 6), 6);
  assert.equal(parseExpNumber("Infinity", 6), 6);
});

test("parseExpNumber：合法值生效并 clamp", () => {
  assert.equal(parseExpNumber("8", 6), 8);
  assert.equal(parseExpNumber("10", 6, 1, 20), 10);
  assert.equal(parseExpNumber("999", 6, 1, 20), 20);
  assert.equal(parseExpNumber("0", 6, 1, 20), 1);
});

test("parseExpBool：常见真值/假值写法", () => {
  for (const raw of ["1", "true", "TRUE", "on", "yes"]) {
    assert.equal(parseExpBool(raw, false), true, raw);
  }
  for (const raw of ["0", "false", "off", "no", ""]) {
    assert.equal(parseExpBool(raw, true), false, raw);
  }
});

test("parseExpBool：无法识别时回退默认值", () => {
  assert.equal(parseExpBool("maybe", false), false);
  assert.equal(parseExpBool(null, true), true);
});

test("默认值：测量类保持关闭，列表子集从 1.0.0-1 起默认开启", () => {
  // node 环境没有 window：readRaw 一律返回 null，等价于"用户没配置"
  assert.equal(experiment.gridOverscan(), 6);
  assert.equal(experiment.quickbarOverscan(), 4);
  assert.equal(experiment.quickbarRootMargin(), "240px");
  assert.equal(experiment.prefetch(), false);
  assert.equal(experiment.diag(), false);
  assert.equal(experiment.prefetchScreens(), 1);
  // 下面两项是**有意的默认变更**，不是回归：
  // - listSubset：产物只含屏上字符，失败自动回退完整链路，所以默认开；
  // - thumbnail：静态图与实时渲染的像素差异风险高，默认关，等数据指向「回滚痛」再开。
  assert.equal(experiment.listSubset(), true);
  assert.equal(experiment.thumbnail(), false);
});
