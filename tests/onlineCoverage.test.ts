import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expectationFromCatalogue,
  expectationFromFiles,
  familyCoverage,
  filesToDownload,
  parentDir,
} from "../src/lib/onlineCoverage.ts";
import type { FontFace } from "../src/lib/ipc.ts";

function face(
  family: string,
  opts: {
    style?: string;
    weight?: number;
    italic?: boolean;
    variable?: boolean;
    axes?: { tag: string; min: number; default: number; max: number }[];
    postscriptName?: string | null;
    source?: FontFace["source"];
    path?: string;
  } = {},
): FontFace {
  return {
    id: `${family}-${opts.style ?? "Regular"}#0`,
    path: opts.path ?? `C:/fonts/${family}/${family}.ttf`,
    previewPath: null,
    faceIndex: 0,
    family,
    style: opts.style ?? "Regular",
    postscriptName: opts.postscriptName ?? null,
    localizedNames: [],
    foundry: null,
    license: null,
    licenseUrl: null,
    copyright: null,
    format: "ttf",
    isVariable: opts.variable ?? false,
    axes: opts.axes ?? [],
    weight: opts.weight ?? 400,
    italic: opts.italic ?? false,
    monospaced: false,
    classification: "sans",
    scripts: [],
    features: [],
    glyphCount: 100,
    fileSize: 1000,
    source: opts.source ?? "managed",
    deactivatable: true,
    active: true,
    addedAt: null,
  };
}

const WGHT = { tag: "wght", min: 100, max: 900, default: 400 };

test("目录里标记为可变字体时每个样式只期望一个文件", () => {
  const exp = expectationFromCatalogue([100, 400, 900], ["normal", "italic"], { variable: true });
  assert.equal(exp.length, 2);
  const faces = [
    face("Lora", { style: "Regular", weight: 400, variable: true, axes: [WGHT] }),
    face("Lora", { style: "Italic", weight: 400, italic: true, variable: true, axes: [WGHT] }),
  ];
  assert.equal(familyCoverage(faces, exp, true).state, "complete");
});

test("目录里的字重与样式做笛卡尔积生成期望集合", () => {
  const exp = expectationFromCatalogue([400, 700], ["normal", "italic"]);
  assert.deepEqual(
    exp.map((e) => `${e.style}:${e.weight}`),
    ["normal:400", "normal:700", "italic:400", "italic:700"],
  );
});

test("详情文件列表按 斜体+字重 去重", () => {
  const exp = expectationFromFiles([
    { style: "normal", weight: 400, postScriptName: "Lora-Regular" },
    { style: "normal", weight: 400, postScriptName: "Lora-Regular-dup" },
    { style: "italic", weight: 700, postScriptName: "Lora-BoldItalic" },
  ]);
  assert.equal(exp.length, 2);
  assert.deepEqual(exp.map((e) => `${e.style}:${e.weight}`), ["normal:400", "italic:700"]);
});

test("静态字面齐全且有版权文件 → complete", () => {
  const faces = [
    face("Lora", { style: "Regular", weight: 400 }),
    face("Lora", { style: "Bold", weight: 700 }),
    face("Lora", { style: "Italic", weight: 400, italic: true }),
    face("Lora", { style: "Bold Italic", weight: 700, italic: true }),
  ];
  const cov = familyCoverage(faces, expectationFromCatalogue([400, 700], ["normal", "italic"]), true);
  assert.equal(cov.state, "complete");
  assert.equal(cov.covered, 4);
  assert.equal(cov.missing, 0);
});

test("缺一个字重 → partial，并给出缺失数量", () => {
  const faces = [
    face("Lora", { style: "Regular", weight: 400 }),
    face("Lora", { style: "Italic", weight: 400, italic: true }),
    face("Lora", { style: "Bold Italic", weight: 700, italic: true }),
  ];
  const cov = familyCoverage(faces, expectationFromCatalogue([400, 700], ["normal", "italic"]), true);
  assert.equal(cov.state, "partial");
  assert.equal(cov.missing, 1);
});

test("字重齐全但没有版权文件 → partial", () => {
  const faces = [face("Lora", { style: "Regular", weight: 400 })];
  const cov = familyCoverage(faces, expectationFromCatalogue([400], ["normal"]), false);
  assert.equal(cov.state, "partial");
  assert.equal(cov.hasLicense, false);
  assert.equal(cov.missing, 0);
});

test("可变字体一个文件覆盖全部字重", () => {
  const faces = [
    face("Lora", { style: "Regular", weight: 400, variable: true, axes: [WGHT] }),
    face("Lora", { style: "Italic", weight: 400, italic: true, variable: true, axes: [WGHT] }),
  ];
  const cov = familyCoverage(
    faces,
    expectationFromCatalogue([100, 200, 300, 400, 500, 600, 700, 800, 900], ["normal", "italic"]),
    true,
  );
  assert.equal(cov.state, "complete");
  assert.equal(cov.covered, 18);
});

test("可变字体的字重轴范围之外不算覆盖", () => {
  const faces = [
    face("Lora", {
      style: "Regular",
      weight: 400,
      variable: true,
      axes: [{ tag: "wght", min: 400, max: 700, default: 400 }],
    }),
  ];
  const cov = familyCoverage(faces, expectationFromCatalogue([400, 900], ["normal"]), true);
  assert.equal(cov.state, "partial");
  assert.equal(cov.covered, 1);
});

test("postScriptName 能救回字重解析不一致的情况", () => {
  const faces = [face("Lora", { style: "Regular", weight: 500, postscriptName: "Lora-Bold" })];
  const cov = familyCoverage(
    faces,
    [{ style: "normal", weight: 700, postScriptName: "Lora-Bold" }],
    true,
  );
  assert.equal(cov.state, "complete");
});

test("字库里没有该字族 → none", () => {
  const cov = familyCoverage([], expectationFromCatalogue([400], ["normal"]), false);
  assert.equal(cov.state, "none");
  assert.equal(cov.removable, false);
});

test("系统字体不可删除", () => {
  const cov = familyCoverage(
    [face("Arial", { source: "system" })],
    expectationFromCatalogue([400], ["normal"]),
    false,
  );
  assert.equal(cov.state, "partial");
  assert.equal(cov.removable, false);
});

test("补全缺失时只挑字库里还没有的文件", () => {
  const files = [
    { filename: "Lora-Regular.ttf", style: "normal", weight: 400, postScriptName: "Lora-Regular" },
    { filename: "Lora-Bold.ttf", style: "normal", weight: 700, postScriptName: "Lora-Bold" },
    { filename: "Lora-Italic.ttf", style: "italic", weight: 400, postScriptName: "Lora-Italic" },
  ];
  const faces = [
    face("Lora", { style: "Regular", weight: 400, postscriptName: "Lora-Regular" }),
    face("Lora", { style: "Italic", weight: 400, italic: true, postscriptName: "Lora-Italic" }),
  ];
  assert.deepEqual(filesToDownload(files, faces), ["Lora-Bold.ttf"]);
});

test("字库里一个都没有时全部要下", () => {
  const files = [
    { filename: "A.ttf", style: "normal", weight: 400 },
    { filename: "B.ttf", style: "normal", weight: 700 },
  ];
  assert.deepEqual(filesToDownload(files, []), ["A.ttf", "B.ttf"]);
});

test("可变字体已覆盖字重轴时不再补下静态文件", () => {
  const files = [
    { filename: "Lora[wght].ttf", style: "normal", weight: 400 },
    { filename: "Lora-Italic[wght].ttf", style: "italic", weight: 400 },
  ];
  const faces = [face("Lora", { style: "Regular", weight: 400, variable: true, axes: [WGHT] })];
  assert.deepEqual(filesToDownload(files, faces), ["Lora-Italic[wght].ttf"]);
});

test("同一文件名只下一次", () => {
  const files = [
    { filename: "Lora.ttc", style: "normal", weight: 400 },
    { filename: "Lora.ttc", style: "normal", weight: 700 },
  ];
  assert.deepEqual(filesToDownload(files, []), ["Lora.ttc"]);
});

test("parentDir 同时支持正反斜杠", () => {
  assert.equal(parentDir("C:\\fonts\\lora\\Lora.ttf"), "C:\\fonts\\lora");
  assert.equal(parentDir("/home/u/fonts/Lora.ttf"), "/home/u/fonts");
  assert.equal(parentDir("Lora.ttf"), "");
});
