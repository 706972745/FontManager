import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_RECHECK_TICK_MS,
  dueForUpdateCheck,
} from "../src/lib/updateGate.ts";

const NOW = 1_800_000_000_000;

test("没查过（0 / 缺失 / 脏数据）就要查", () => {
  assert.equal(dueForUpdateCheck(0, NOW), true);
  assert.equal(dueForUpdateCheck(undefined, NOW), true);
  assert.equal(dueForUpdateCheck(null, NOW), true);
  assert.equal(dueForUpdateCheck("1799999999999", NOW), true, "字符串不是时间戳，当没查过");
  assert.equal(dueForUpdateCheck(Number.NaN, NOW), true);
  assert.equal(dueForUpdateCheck(-1, NOW), true);
});

test("24 小时内不重复查（GitHub 匿名限额 60 次/小时/IP）", () => {
  assert.equal(dueForUpdateCheck(NOW - 1000, NOW), false);
  assert.equal(dueForUpdateCheck(NOW - 23 * 60 * 60 * 1000, NOW), false);
  assert.equal(
    dueForUpdateCheck(NOW - (UPDATE_CHECK_INTERVAL_MS - 1), NOW),
    false,
    "差 1 毫秒也不查"
  );
});

test("满 24 小时就到点（常驻用户也会被提醒）", () => {
  assert.equal(dueForUpdateCheck(NOW - UPDATE_CHECK_INTERVAL_MS, NOW), true);
  assert.equal(dueForUpdateCheck(NOW - 3 * 24 * 60 * 60 * 1000, NOW), true);
});

test("时钟回拨：last 落在未来也照查，别把提醒永久关掉", () => {
  assert.equal(dueForUpdateCheck(NOW + 60_000, NOW), true);
});

test("常驻复查间隔短于 24 小时，否则「昨天开机」要拖到明天才提醒", () => {
  assert.ok(UPDATE_RECHECK_TICK_MS > 0);
  assert.ok(UPDATE_RECHECK_TICK_MS <= UPDATE_CHECK_INTERVAL_MS / 2);
});
