import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareVersions, hasUpdate } from "../src/lib/workshop.ts";

/**
 * 插件中心的「更新」按钮（2026-11-19 用户要求）。
 *
 * 判定必须严：**多给一次更新**只是白下载一遍、把插件的运行状态重置，
 * **漏给**才是用户抱怨的「装了新版但中心里还是旧版、只能卸载重装」。
 * 所以这里把三个边角焊死：本机没装、清单没写版本、本机版本更高（开发中的本地版）。
 */

const read = (p: string) => readFileSync(p, "utf8");

test("hasUpdate：只有「清单版本更高」才算更新", () => {
  assert.equal(hasUpdate("1.2.0", "1.1.9"), true);
  assert.equal(hasUpdate("1.1.9", "1.2.0"), false, "本机更新时不能提示更新（会把开发中的版本降级）");
  assert.equal(hasUpdate("1.2.0", "1.2.0"), false);
  assert.equal(hasUpdate("1.0", "1.0.0"), false, "缺段按 0，1.0 == 1.0.0");
  assert.equal(hasUpdate("1.0.1", "1.0"), true);
});

test("hasUpdate：没装 / 没写版本一律 false（由「安装」负责，不是「更新」）", () => {
  assert.equal(hasUpdate("1.2.0", undefined), false);
  assert.equal(hasUpdate("1.2.0", null), false);
  assert.equal(hasUpdate("1.2.0", ""), false);
  assert.equal(hasUpdate(undefined, "1.0.0"), false);
  assert.equal(hasUpdate("", "1.0.0"), false);
  assert.equal(hasUpdate("   ", "1.0.0"), false);
});

test("hasUpdate：容忍 v 前缀与空白（社区件常这么写）", () => {
  assert.equal(hasUpdate("v1.2.0", "1.1.0"), true);
  assert.equal(hasUpdate("V2.0.0", "v1.9.9"), true);
  assert.equal(hasUpdate(" 1.2.0 ", " 1.1.0 "), true);
  assert.equal(hasUpdate("v1.2.0", "v1.2.0"), false);
});

test("compareVersions 与 hasUpdate 口径一致（同一条判据，不许各写一份）", () => {
  for (const [a, b] of [["1.2.3", "1.2.2"], ["2.0.0", "10.0.0"], ["0.9.5", "0.9.4"]] as const) {
    assert.equal(hasUpdate(a, b), compareVersions(a, b) > 0, `${a} vs ${b}`);
  }
});

test("面板真的用了这个判据，并且更新走安装同一条通道", () => {
  const app = read("src/workshop/App.tsx");
  assert.match(app, /hasUpdate\(entry\.version, installedVersions\.get\(entry\.id\)\)/, "更新判据必须是 hasUpdate");
  assert.match(app, /onInstall\(detail, installedIds\.has\(detail\.id\) \? "update" : "install"\)/, "详情页要区分更新/安装");
  assert.match(app, /onInstall\(entry, "update"\)/, "卡片上的更新按钮要传 update 模式");
  // 卡片是 role=button，内部按钮必须拦冒泡，否则点更新会同时打开详情
  assert.match(app, /onClick=\{\(e\) => \{\s*e\.stopPropagation\(\);\s*onUpdate\(\);/, "卡片更新按钮要 stopPropagation");
});

test("九种语言都有 update / updateTo / updateBadge 词条", () => {
  const dict = read("src/workshop/i18n.ts");
  for (const key of ["update", "updateTo", "updateBadge", "updatedToast", "updateFailed"]) {
    const hits = dict.match(new RegExp(`"${key}":`, "g")) ?? [];
    assert.ok(hits.length >= 9, `${key} 只有 ${hits.length} 条，9 种语言要齐`);
  }
});
