import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFaceIndex,
  entryFromFace,
  entryPaths,
  faceKey,
  migrateEntry,
  missingEntries,
  resolveEntry,
  systemBackedEntries,
} from "../src/lib/snapshotKey.ts";
import type { FontFace } from "../src/lib/ipc.ts";

/** 造一个字体对象；path 用来模拟“不同电脑上字体库路径不同” */
function face(over: Partial<FontFace>): FontFace {
  return {
    id: over.path ?? "",
    path: "",
    previewPath: null,
    faceIndex: 0,
    family: "Inter",
    style: "Regular",
    postscriptName: "Inter-Regular",
    foundry: null,
    license: null,
    licenseUrl: null,
    copyright: null,
    format: "ttf",
    isVariable: false,
    axes: [],
    weight: 400,
    italic: false,
    monospaced: false,
    classification: "sans",
    scripts: [],
    features: [],
    glyphCount: 0,
    fileSize: 0,
    source: "managed",
    deactivatable: true,
    active: true,
    addedAt: null,
    ...over,
  } as FontFace;
}

test("faceKey 不含任何目录信息", () => {
  const a = face({ path: "D:\\字体库\\Inter\\Inter-Regular.ttf" });
  const b = face({ path: "E:\\Users\\someone\\Fonts\\Inter-Regular.ttf" });
  assert.equal(faceKey(a), "ps:inter-regular");
  assert.equal(faceKey(a), faceKey(b));
  assert.ok(!faceKey(a).includes("\\") && !faceKey(a).includes("/"));
});

test("faceKey 在没有 postScriptName 时回退到字族+样式", () => {
  const f = face({ postscriptName: null, family: "Source Han", style: "Bold", weight: 700 });
  assert.equal(faceKey(f), "fam:source han|bold|700|0|0");
});

test("快照条目不含路径字段", () => {
  const e = entryFromFace(face({ path: "C:\\Windows\\Fonts\\inter.ttf", source: "system" }));
  assert.deepEqual(e, { key: "ps:inter-regular", family: "Inter", style: "Regular", system: true });
  assert.ok(!("path" in e));
});

test("换一台电脑（字体库路径不同）仍能按 key 对上号", () => {
  const snapEntry = entryFromFace(face({ path: "D:\\字体库\\Inter-Regular.ttf" }));
  // 另一台电脑：字体放在完全不同的目录
  const other = [face({ path: "E:\\Fonts\\Inter\\Inter-Regular.ttf" })];
  const resolved = resolveEntry(snapEntry, buildFaceIndex(other));
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].path, "E:\\Fonts\\Inter\\Inter-Regular.ttf");
});

test("key 失效时回退到 字族+样式 匹配", () => {
  const snapEntry = entryFromFace(face({ path: "D:\\a\\Inter-Regular.ttf" }));
  // 同名字体但 PS 名变了（不同版本）
  const other = [face({ path: "E:\\b\\Inter-Regular.ttf", postscriptName: "Inter-Regular-v2" })];
  const resolved = resolveEntry(snapEntry, buildFaceIndex(other));
  assert.equal(resolved.length, 1);
});

test("本机没有该字体时判定为缺失", () => {
  const snapEntry = entryFromFace(face({ path: "D:\\字体库\\OnlyHere.ttf", family: "OnlyHere", postscriptName: "OnlyHere-Regular" }));
  const other = [face({ path: "E:\\Fonts\\Inter-Regular.ttf" })];
  assert.equal(missingEntries([snapEntry], buildFaceIndex(other)).length, 1);
});

test("旧版绝对路径条目可迁移成可移植 key", () => {
  const local = [face({ path: "D:\\字体库\\Inter-Regular.ttf" })];
  const migrated = migrateEntry(
    { key: "", path: "D:\\字体库\\Inter-Regular.ttf", family: "Inter", style: "Regular", system: false },
    buildFaceIndex(local),
  );
  assert.equal(migrated.key, "ps:inter-regular");
  assert.equal(migrated.path, undefined);
});

test("旧版路径已失效时，用文件名唯一匹配兜底", () => {
  const local = [face({ path: "E:\\Fonts\\Inter-Regular.ttf" })];
  const migrated = migrateEntry(
    { key: "", path: "D:\\另一个库\\Inter-Regular.ttf", family: "", style: "", system: false },
    buildFaceIndex(local),
  );
  assert.equal(migrated.key, "ps:inter-regular");
});

test("快照条目解析为路径时会去重（系统与字体库同名同一字体）", () => {
  const fonts = [
    face({ path: "C:\\Windows\\Fonts\\inter.ttf", source: "system" }),
    face({ path: "E:\\Fonts\\inter.ttf" }),
  ];
  const entries = [entryFromFace(fonts[0]), entryFromFace(fonts[1])];
  const paths = entryPaths(entries, buildFaceIndex(fonts));
  assert.deepEqual(paths, ["C:\\Windows\\Fonts\\inter.ttf", "E:\\Fonts\\inter.ttf"]);
});

// ---- 0.9.9-1：byFamily 兜底只在无歧义时使用 ----

test("byFamily 兜底：字族只有 1 个字体时可以用", () => {
  // key 和 style 都不匹配，但字族下只有 1 个字体 → 兜底成功
  const snapEntry = { key: "ps:nonexistent", family: "RareFont", style: "Unknown", system: false };
  const fonts = [face({ family: "RareFont", style: "Regular", postscriptName: "RareFont-Regular" })];
  const resolved = resolveEntry(snapEntry, buildFaceIndex(fonts));
  assert.equal(resolved.length, 1);
});

test("byFamily 兜底：字族有多个字体时不再整族返回", () => {
  // 这是关键：以前会把整族 3 个字重都算进来，现在宁可标缺失也不误启用
  const snapEntry = { key: "ps:nonexistent", family: "MultiFont", style: "Unknown", system: false };
  const fonts = [
    face({ family: "MultiFont", style: "Regular", postscriptName: "MultiFont-Regular" }),
    face({ family: "MultiFont", style: "Bold", postscriptName: "MultiFont-Bold", weight: 700 }),
    face({ family: "MultiFont", style: "Italic", postscriptName: "MultiFont-Italic", italic: true }),
  ];
  const resolved = resolveEntry(snapEntry, buildFaceIndex(fonts));
  assert.equal(resolved.length, 0, "多字重字族兜底应返回空（标为缺失），而不是整族启用");
});

test("byFamilyStyle 匹配时返回所有同样式字体（不受兜底改动影响）", () => {
  // key 不匹配但 family+style 匹配 → 正常返回（这个路径不受影响）
  const snapEntry = { key: "ps:old-name", family: "TestFont", style: "Regular", system: false };
  const fonts = [
    face({ family: "TestFont", style: "Regular", postscriptName: "TestFont-Regular-v2" }),
    face({ family: "TestFont", style: "Bold", postscriptName: "TestFont-Bold-v2", weight: 700 }),
  ];
  const resolved = resolveEntry(snapEntry, buildFaceIndex(fonts));
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].style, "Regular");
});

test("entryPaths 不再把整族字重放大进来", () => {
  // 快照里只有 1 条 Regular，但字族有 3 个字重且 key 不匹配
  const snapEntry = { key: "ps:nonexistent", family: "BigFamily", style: "Regular", system: false };
  const fonts = [
    face({ family: "BigFamily", style: "Regular", postscriptName: "BigFamily-Regular-v2", path: "A.ttf" }),
    face({ family: "BigFamily", style: "Bold", postscriptName: "BigFamily-Bold-v2", weight: 700, path: "B.ttf" }),
    face({ family: "BigFamily", style: "Italic", postscriptName: "BigFamily-Italic-v2", italic: true, path: "C.ttf" }),
  ];
  const index = buildFaceIndex(fonts);
  const paths = entryPaths([snapEntry], index);
  // family+style 能匹配到 Regular，所以 1 条；不会把 Bold/Italic 也拉进来
  assert.equal(paths.length, 1);
  assert.equal(paths[0], "A.ttf");
});

// ---- 快照栏「系统字体」：只要解析到系统那一份就算（见 snapshotKey.ts 里的口径说明） ----

test("systemBackedEntries：同名字体库里也有一份时，仍然算系统字体", () => {
  const sys = face({ path: "C:/Windows/Fonts/arial.ttf", postscriptName: "ArialMT", source: "system" });
  const own = face({ path: "E:/Fonts/arial.ttf", postscriptName: "ArialMT", source: "managed" });
  const entry = { key: "ps:arialmt", family: "Arial", style: "Regular", system: true };
  const index = buildFaceIndex([sys, own]);
  // 2026-10-31 改口径：原来是「全是 system 才算」，导致一个全系统字体抓来的快照只显示「1 个系统字体」。
  // 现在按 some：命中里有系统那一份就算 —— 它才是「应用快照时动不了的那部分」。
  assert.equal(systemBackedEntries([entry], index).length, 1, "命中系统那一份 → 算");
});

test("systemBackedEntries：只有系统那一份时算", () => {
  const sys = face({ path: "C:/Windows/Fonts/msgothic.ttc", postscriptName: "MS-Gothic", source: "system" });
  const entry = { key: "ps:ms-gothic", family: "MS Gothic", style: "Regular", system: true };
  const index = buildFaceIndex([sys]);
  assert.equal(systemBackedEntries([entry], index).length, 1);
});

test("systemBackedEntries：只有库内副本时不算", () => {
  const own = face({ path: "E:/Fonts/arial.ttf", postscriptName: "ArialMT", source: "managed" });
  const entry = { key: "ps:arialmt", family: "Arial", style: "Regular", system: true };
  assert.equal(systemBackedEntries([entry], buildFaceIndex([own])).length, 0, "没有系统那一份 → 不算");
});

test("systemBackedEntries：解析不到的条目不计数", () => {
  const entry = { key: "ps:ghost", family: "Ghost", style: "Regular", system: true };
  assert.equal(systemBackedEntries([entry], buildFaceIndex([])).length, 0);
});
