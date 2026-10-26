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
