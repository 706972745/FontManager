import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTagExpiry, isTagExpired, parseTagExpiry } from "../src/lib/tagExpiry.ts";

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
