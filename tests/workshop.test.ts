import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  applyWorkshopFilters,
  communityDirFor,
  compareVersions,
  humanBytes,
  matchesWorkshopQuery,
  meetsMinAppVersion,
  parseWorkshopIndex,
  parseWorkshopIndexStrict,
  workshopAuthorLabel,
  type WorkshopEntry,
} from "../src/lib/workshop.ts";

function entry(over: Partial<WorkshopEntry> = {}): WorkshopEntry {
  return {
    id: "font-renamer",
    name: "批量重命名",
    brief: "按规则批量重命名字体族",
    detail: "详细说明全文",
    author: "alice",
    official: false,
    version: "1.2.0",
    runtime: null,
    minAppVersion: null,
    lang: "zh-CN",
    download: null,
    size: 2048,
    dir: "font-renamer__alice",
    files: [{ path: "main.py", sha256: "aa", url: "https://x/main.py", size: 64 }],
    permissions: ["fonts:read"],
    ...over,
  };
}

// ── 解析 ────────────────────────────────────────────────────────────────

test("parseWorkshopIndex merges official + community and marks official", () => {
  const doc = {
    version: 1,
    generatedAt: "2026-11-14T14:00:00Z",
    official: [{ id: "font-sync", name: "字体同步", author: "official" }],
    plugins: [entry()],
  };
  const idx = parseWorkshopIndex(doc);
  assert.equal(idx.entries.length, 2);
  assert.equal(idx.entries[0].id, "font-sync");
  assert.equal(idx.entries[0].official, true);
  assert.equal(idx.entries[1].official, false);
  assert.equal(idx.version, "1");
  assert.equal(idx.generatedAt, "2026-11-14T14:00:00Z");
});

test("parseWorkshopIndex is tolerant: missing fields get defaults", () => {
  const idx = parseWorkshopIndex({ plugins: [{ id: "a" }] });
  const e = idx.entries[0];
  assert.equal(e.name, "a"); // 名字回落到 id
  assert.equal(e.brief, "");
  assert.equal(e.runtime, null);
  assert.equal(e.minAppVersion, null);
  assert.equal(e.download, null);
  assert.equal(e.size, 0);
  assert.deepEqual(e.permissions, []);
  assert.equal(e.files, null);
});

test("parseWorkshopIndex drops entries without id and non-objects", () => {
  const idx = parseWorkshopIndex({ plugins: [{ name: "no id" }, "junk", 42, null, { id: "ok" }] });
  assert.equal(idx.entries.length, 1);
  assert.equal(idx.entries[0].id, "ok");
});

test("parseWorkshopIndex never throws on garbage input", () => {
  for (const garbage of [null, 42, "text", [], { official: "x", plugins: 7 }]) {
    const idx = parseWorkshopIndex(garbage);
    assert.deepEqual(idx.entries, []);
  }
});

test("parseWorkshopIndex filters file rows missing path/url instead of dropping the entry", () => {
  const idx = parseWorkshopIndex({
    plugins: [{ id: "a", files: [{ path: "p", url: "u" }, { path: "no-url" }, "junk"] }],
  });
  assert.equal(idx.entries[0].files!.length, 1);
  assert.equal(idx.entries[0].files![0].path, "p");
});

test("parseWorkshopIndexStrict throws on invalid JSON / empty list", () => {
  assert.throws(() => parseWorkshopIndexStrict("not json"));
  assert.throws(() => parseWorkshopIndexStrict("{}"));
});

// ── 搜索 / 筛选 ─────────────────────────────────────────────────────────

test("matchesWorkshopQuery hits name, brief and author case-insensitively", () => {
  const e = entry({ name: "Font Renamer", brief: "Batch rename", author: "Alice" });
  assert.equal(matchesWorkshopQuery(e, "renam"), true);
  assert.equal(matchesWorkshopQuery(e, "batch"), true);
  assert.equal(matchesWorkshopQuery(e, "ALICE"), true);
  assert.equal(matchesWorkshopQuery(e, "nomatch"), false);
  assert.equal(matchesWorkshopQuery(e, ""), true);
});

test("applyWorkshopFilters: kind / runtime / installedOnly", () => {
  const entries = [
    entry({ id: "off", official: true, runtime: "python" }),
    entry({ id: "py", runtime: "python" }),
    entry({ id: "node", runtime: "node" }),
    entry({ id: "none", runtime: null }),
  ];
  const installed = new Set(["py"]);
  const base = { query: "", installedIds: installed };
  assert.deepEqual(
    applyWorkshopFilters(entries, { ...base, kind: "official", runtime: "any", installedOnly: false }).map((e) => e.id),
    ["off"],
  );
  assert.deepEqual(
    applyWorkshopFilters(entries, { ...base, kind: "community", runtime: "python", installedOnly: false }).map((e) => e.id),
    ["py"],
  );
  assert.deepEqual(
    applyWorkshopFilters(entries, { ...base, kind: "all", runtime: "node", installedOnly: false }).map((e) => e.id),
    ["node"],
  );
  assert.deepEqual(
    applyWorkshopFilters(entries, { ...base, kind: "all", runtime: "none", installedOnly: false }).map((e) => e.id),
    ["none"],
  );
  assert.deepEqual(
    applyWorkshopFilters(entries, { ...base, kind: "all", runtime: "any", installedOnly: true }).map((e) => e.id),
    ["py"],
  );
});

// ── 展示辅助 ────────────────────────────────────────────────────────────

test("humanBytes formats B/KB/MB and treats 0 as unknown", () => {
  assert.equal(humanBytes(0), null);
  assert.equal(humanBytes(-5), null);
  assert.equal(humanBytes(512), "512 B");
  assert.equal(humanBytes(2048), "2.0 KB");
  assert.equal(humanBytes(5.5 * 1024 * 1024), "5.5 MB");
  assert.equal(humanBytes(3 * 1024 * 1024 * 1024), "3.0 GB");
});

test("workshopAuthorLabel: official empty, missing author falls back to anonymous", () => {
  assert.equal(workshopAuthorLabel(entry({ official: true })), "");
  assert.equal(workshopAuthorLabel(entry({ author: "alice" })), "alice");
  assert.equal(workshopAuthorLabel(entry({ author: "" })), "anonymous");
});

test("communityDirFor: registry dir wins, else <id>__<author>", () => {
  assert.equal(communityDirFor(entry({ dir: "dir-from-registry" })), "dir-from-registry");
  assert.equal(communityDirFor(entry({ dir: null })), "font-renamer__alice");
  assert.equal(communityDirFor(entry({ dir: null, author: "" })), "font-renamer__anonymous");
});

test("communityDirFor: registry 的 dir 是仓库相对路径，只取最后一段", () => {
  // 真实 registry 的样子：plugins/<id>__<author>
  assert.equal(
    communityDirFor(entry({ dir: "plugins/font-renamer__alice" })),
    "font-renamer__alice",
  );
  assert.equal(
    communityDirFor(entry({ dir: "plugins/spec-counter__anonymous-7f3a" })),
    "spec-counter__anonymous-7f3a",
  );
  // 单个点是允许的（带点的 id 合法，别误伤）
  assert.equal(
    communityDirFor(entry({ dir: "plugins/my.plugin__alice" })),
    "my.plugin__alice",
  );
  // 末段为空（结尾就是斜杠）→ 非法，**不回落**（Rust 侧同样判非法）
  assert.equal(communityDirFor(entry({ dir: "plugins/" })), null);
});

test("communityDirFor: 越界输入一律拒（与 Rust 的 dir_name_of 同口径）", () => {
  // 穿越标记不许被静默纠正：`plugins/../evil` 不能压成 `evil`
  assert.equal(communityDirFor(entry({ dir: "plugins/../evil" })), null);
  assert.equal(communityDirFor(entry({ dir: "../evil" })), null);
  assert.equal(communityDirFor(entry({ dir: "plugins/../../evil" })), null);
  assert.equal(communityDirFor(entry({ dir: "plugins/subdir/../../../evil" })), null);
  // 当前目录段
  assert.equal(communityDirFor(entry({ dir: "plugins/./evil" })), null);
  assert.equal(communityDirFor(entry({ dir: ".." })), null);
  assert.equal(communityDirFor(entry({ dir: "." })), null);
  // Windows 分隔符：混用 `\` 能绕过分段检查，所以整条拒
  assert.equal(communityDirFor(entry({ dir: "plugins\\..\\evil" })), null);
  assert.equal(communityDirFor(entry({ dir: "plugins\\evil" })), null);
  // 盘符 / NTFS 数据流
  assert.equal(communityDirFor(entry({ dir: "C:/evil" })), null);
  assert.equal(communityDirFor(entry({ dir: "C:\\evil" })), null);
  assert.equal(communityDirFor(entry({ dir: "evil:stream" })), null);
  // 末段本身不合法（以点开头 / 含非法字符）
  assert.equal(communityDirFor(entry({ dir: "plugins/.hidden" })), null);
  assert.equal(communityDirFor(entry({ dir: "plugins/a b" })), null);
  // 空 / 纯空白
  assert.equal(communityDirFor(entry({ dir: "" })), "font-renamer__alice");
  assert.equal(communityDirFor(entry({ dir: "   " })), "font-renamer__alice");
});

// ── 版本比较 ────────────────────────────────────────────────────────────

test("compareVersions compares numerically per segment", () => {
  assert.equal(compareVersions("2.1.7", "2.1.7"), 0);
  assert.ok(compareVersions("2.2.0", "2.1.9") > 0);
  assert.ok(compareVersions("2.1.6", "2.1.10") < 0); // 不是字符串比较
  assert.ok(compareVersions("2.10.0", "2.9.0") > 0);
  assert.ok(compareVersions("2.1", "2.1.0") === 0); // 缺段按 0
});

test("meetsMinAppVersion: null min means no restriction", () => {
  assert.equal(meetsMinAppVersion("2.1.7", null), true);
  assert.equal(meetsMinAppVersion("2.1.7", "2.1.7"), true);
  assert.equal(meetsMinAppVersion("2.1.6", "2.1.7"), false);
  assert.equal(meetsMinAppVersion("3.0.0", "2.1.7"), true);
});

// ── 真实 registry 清单（回归护栏）───────────────────────────────────────
//
// 仓库：FontManager-Workshop（team-lead 搭的测试 registry）。
// 这里把**真实那份 index.json** 喂进解析器 —— 字段对不上、目录名口径变了、
// 清单结构改了，都会在这一条上炸掉，而不是等到用户点「安装」才炸。
//
// 清单本体在另一个 git 仓库里，所以本仓库存一份**快照**
// （`tests/fixtures/workshop-index.json`，内容 = 2026-11-14 那份线上清单）。
// 用快照而不是仓库外的绝对路径：绝对路径换台机器 / 跑 CI 就找不到，
// 测试会「跳过」并显示通过 —— 什么都没验却看着绿（QA 2026-11-15 指出的问题）。
//
// 想顺带验线上那份没变：设 `WORKSHOP_LIVE_INDEX=1` 再跑 npm test，
// 会额外拉一次线上清单做结构比对（需要联网；默认跳过并打醒目告警）。

const FIXTURE_INDEX = fileURLToPath(
  new URL("./fixtures/workshop-index.json", import.meta.url),
);
const LIVE_INDEX =
  "https://raw.githubusercontent.com/706972745/FontManager-Workshop/main/index.json";

test("真实 registry 清单能解析出 官方 5 条 + 社区 2 条", async (t) => {
  const { readFileSync, existsSync } = await import("node:fs");
  if (!existsSync(FIXTURE_INDEX)) {
    t.skip(`找不到清单快照（${FIXTURE_INDEX}），跳过`);
    return;
  }
  const index = parseWorkshopIndexStrict(readFileSync(FIXTURE_INDEX, "utf8"));
  assert.equal(index.entries.length, 7);

  const official = index.entries.filter((e) => e.official);
  const community = index.entries.filter((e) => !e.official);
  assert.equal(official.length, 5);
  assert.equal(community.length, 2);

  // 官方件：release zip 直链 + 体积
  for (const e of official) {
    assert.ok(e.download, `${e.id} 缺下载地址`);
    assert.ok(e.download.startsWith("https://"), `${e.id} 的下载地址不是 https`);
  }

  // 社区件：逐文件清单齐全，目录名取仓库相对路径的最后一段
  for (const e of community) {
    assert.ok(e.files && e.files.length > 0, `${e.id} 没有文件清单`);
    for (const f of e.files) {
      assert.ok(f.path && !f.path.includes("/"), `${e.id} 的文件路径不是插件内相对路径：${f.path}`);
      assert.equal(f.sha256.length, 64, `${e.id}/${f.path} 的 sha256 长度不对`);
      assert.ok(f.url.startsWith("https://"), `${e.id}/${f.path} 的下载地址不是 https`);
    }
    // 清单里必须有 plugin.json，否则装完不会被识别成插件
    assert.ok(
      e.files?.some((f) => f.path === "plugin.json"),
      `${e.id} 的清单里没有 plugin.json`,
    );
    // 目录名：真实 registry 给的是 `plugins/<id>__<author>`
    assert.equal(
      communityDirFor(e),
      `${e.id}__${e.author}`,
      `${e.id} 的安装目录名口径不对`,
    );
  }
});

test("真实 registry 清单：permissions 字段确实存在（B81 的结论）", async (t) => {
  const { readFileSync, existsSync } = await import("node:fs");
  if (!existsSync(FIXTURE_INDEX)) {
    t.skip("找不到清单快照，跳过");
    return;
  }
  const index = parseWorkshopIndexStrict(readFileSync(FIXTURE_INDEX, "utf8"));
  const community = index.entries.filter((e) => !e.official);
  for (const e of community) {
    assert.ok(e.permissions.length > 0, `${e.id} 没有 permissions`);
  }
});

test("线上清单与仓库里的快照一致（默认跳过；设 WORKSHOP_LIVE_INDEX=1 才跑）", async (t) => {
  if (process.env.WORKSHOP_LIVE_INDEX !== "1") {
    console.warn(
      "\n" +
        "  ⚠️  跳过了「线上清单 vs 快照」的比对（要跑请设 WORKSHOP_LIVE_INDEX=1，需要联网）\n" +
        "     快照本身仍在上面两条测试里被逐字段验证 —— 这一条只负责保证快照没过期。\n",
    );
    t.skip("未设 WORKSHOP_LIVE_INDEX=1");
    return;
  }
  const { readFileSync } = await import("node:fs");
  const res = await fetch(LIVE_INDEX);
  assert.equal(res.status, 200, "拉线上清单失败");
  const live = parseWorkshopIndexStrict(await res.text());
  const snapshot = parseWorkshopIndexStrict(readFileSync(FIXTURE_INDEX, "utf8"));
  // 比结构，不比字节：线上清单带 generatedAt 时间戳，字节永远对不上
  const shape = (i: typeof live) =>
    i.entries.map((e) => ({
      id: e.id,
      version: e.version,
      official: e.official,
      files: (e.files ?? []).map((f) => ({ path: f.path, sha256: f.sha256 })),
      dir: e.dir,
    }));
  assert.deepEqual(
    shape(live),
    shape(snapshot),
    "线上清单与快照对不上 —— 请更新 tests/fixtures/workshop-index.json",
  );
});
