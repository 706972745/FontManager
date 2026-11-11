import { test } from "node:test";
import assert from "node:assert/strict";
import { pickThemePref, THEME_MIGRATED_KEY } from "../src/lib/themePref.ts";

test("新装 / 老数据没有 themePref → 跟随系统", () => {
  assert.deepEqual(pickThemePref({}), { pref: "system", migrated: false });
  assert.deepEqual(pickThemePref(null), { pref: "system", migrated: false });
  assert.deepEqual(pickThemePref(undefined), { pref: "system", migrated: false });
});

test("存的是旧默认 dark 且没有迁移标记 → 改成 system 并回报迁移", () => {
  assert.deepEqual(pickThemePref({ themePref: "dark" }), { pref: "system", migrated: true });
});

test("已经迁移过就尊重存值：用户选回深色不会再被改掉", () => {
  assert.deepEqual(pickThemePref({ themePref: "dark", [THEME_MIGRATED_KEY]: true }), {
    pref: "dark",
    migrated: false,
  });
});

test("用户自己选的浅色 / 系统原样保留，不算迁移", () => {
  assert.deepEqual(pickThemePref({ themePref: "light" }), { pref: "light", migrated: false });
  assert.deepEqual(pickThemePref({ themePref: "system" }), { pref: "system", migrated: false });
});

test("脏数据（拼错的枚举 / 非字符串）退回跟随系统", () => {
  assert.deepEqual(pickThemePref({ themePref: "Dark" }), { pref: "system", migrated: false });
  assert.deepEqual(pickThemePref({ themePref: 1 }), { pref: "system", migrated: false });
  assert.deepEqual(pickThemePref({ themePref: null }), { pref: "system", migrated: false });
});
