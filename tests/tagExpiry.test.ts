import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  canSetExpiry,
  expiryNeedsConfirm,
  formatTagExpiry,
  isTagExpired,
  parseTagExpiry,
  sweepTagResult,
} from "../src/lib/tagExpiry.ts";

test("formatTagExpiry hides the year inside the current year", () => {
  const now = new Date(2026, 10, 13); // 2026-11-13
  assert.equal(formatTagExpiry("2026-11-12", now), "11-12");
  assert.equal(formatTagExpiry("2027-01-05", now), "2027-01-05");
  // 坏值原样返回（校验在 parseTagExpiry，这里只管展示不炸）
  assert.equal(formatTagExpiry("garbage", now), "garbage");
});

test("isTagExpired stays valid on the expiry day itself", () => {
  // 当天 23:59:59 仍有效（与 copyrightExpired 的当天口径对齐）
  const noon = new Date(2026, 10, 12, 12, 0, 0);
  assert.equal(isTagExpired("2026-11-12", noon), false);
  const lateNight = new Date(2026, 10, 12, 23, 59, 59, 999);
  assert.equal(isTagExpired("2026-11-12", lateNight), false);
  const nextDay = new Date(2026, 10, 13, 0, 0, 0);
  assert.equal(isTagExpired("2026-11-12", nextDay), true);
});

test("isTagExpired never expires on malformed input", () => {
  // 宁可少删不可误删：坏值一律视为未到期
  assert.equal(isTagExpired("garbage", new Date(2027, 0, 1)), false);
  assert.equal(isTagExpired("", new Date(2027, 0, 1)), false);
});

test("parseTagExpiry keeps only strict YYYY-MM-DD strings", () => {
  assert.equal(parseTagExpiry("2026-11-12"), "2026-11-12");
  assert.equal(parseTagExpiry("2026-11-12T00:00:00Z"), null);
  assert.equal(parseTagExpiry("26-11-12"), null);
  assert.equal(parseTagExpiry(42), null);
  assert.equal(parseTagExpiry(null), null);
});

test("sweepTagResult keeps the expiry key when removal only partially failed", () => {
  const expiry = { "临时素材": "2026-11-12" };
  // removeTagEverywhere 内部吞掉逐族失败并回滚、不抛出 —— 标签还挂在
  // 某个字族上 = 没删干净：保留到期键（下一轮 sweep 重试），调用方跳过成功 toast
  const partial = sweepTagResult(
    expiry,
    { "Lora": ["临时素材"], "Inter": [] },
    "临时素材",
  );
  assert.equal(partial, null, "部分失败必须保留到期键");
  assert.deepEqual(expiry, { "临时素材": "2026-11-12" }, "入参不被原地改写");
});

test("sweepTagResult drops the expiry key only when the tag is gone everywhere", () => {
  const expiry = { "临时素材": "2026-11-12", "其它": "2027-01-01" };
  const next = sweepTagResult(
    expiry,
    { "Lora": [], "Inter": ["别的标签"] },
    "临时素材",
  );
  assert.deepEqual(next, { "其它": "2027-01-01" }, "删干净才删键，其它键不受影响");
  // tags 值不是数组的脏数据按「不在任何族」处理（不炸、不误判成失败）
  const dirty = sweepTagResult(expiry, { "Lora": null as unknown as string[] }, "临时素材");
  assert.deepEqual(dirty, { "其它": "2027-01-01" });
});

/* ── 2.1.7（用户 2026-11-14）：自动标签不给日期 + 波及面先问一句 ────────────── */

test("自动标签不能设到期日：按名字判，不看在不在手工标签里", () => {
  for (const auto of ["class:serif", "cn:song", "vox:garalde", "tech:small-caps", "form:heavy"]) {
    assert.equal(canSetExpiry(auto), false, `${auto} 不该允许设日期`);
  }
  // 用户认可的、删掉后又手打的同名标签，仍然是软件的名字 → 同样不给
  assert.equal(canSetExpiry("class:mono"), false);
});

test("用户自己造的标签可以设到期日", () => {
  for (const mine of ["客户A", "待确认授权", "nihaooff", "临时素材"]) {
    assert.equal(canSetExpiry(mine), true, `${mine} 应当允许设日期`);
  }
});

test("2 个及以上字体就提示（用户 2026-11-14 21:12：含 2 个）", () => {
  assert.equal(expiryNeedsConfirm(0), false);
  assert.equal(expiryNeedsConfirm(1), false);
  assert.equal(expiryNeedsConfirm(2), true, "两个正好也要提示");
  assert.equal(expiryNeedsConfirm(3), true);
  assert.equal(expiryNeedsConfirm(1493), true);
});

/**
 * 「波及面提示每次点击都问」（用户 2026-11-14 21:12 二次明确）。
 *
 * 21:06 版曾把确认记进 prefs.expiryAck（问过一次就不再问）——用户随后推翻：
 * 只要标签**还没定过日期**，每一次点日历图标都要弹（关面板、重启都一样）；
 * 已定过日期的不再问，日期本身就是知情决定。这条守卫扫源码：store 里不许再留
 * expiryAck，界面要用 `!tagExpiry[tag]` 当闸门，不许用任何「记住了」的机制。
 */
test("波及面提示每次都问：不记 ack，未定日期才弹", () => {
  const store = readFileSync("src/state/fontStore.ts", "utf8");
  assert.doesNotMatch(store, /expiryAck/, "store 里不该再有 expiryAck（每次都要问）");
  assert.doesNotMatch(store, /ackExpiryWarn/, "ack 动作要一并删掉");

  const panel = readFileSync("src/components/DetailPanel.tsx", "utf8");
  assert.doesNotMatch(panel, /expiryAck|ackExpiryWarn/, "界面不许再引用 ack 记忆");
  assert.match(
    panel,
    /expiryNeedsConfirm\(n\) && !tagExpiry\[tag\]/,
    "闸门必须是「波及达标 且 该标签还没定过日期」",
  );
});
