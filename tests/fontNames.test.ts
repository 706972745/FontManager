import { test } from "node:test";
import assert from "node:assert/strict";
import {
  englishFamilyName,
  extraFamilyNames,
  languageLabel,
  otherFamilyNames,
  shortName,
} from "../src/lib/fontNames.ts";
import type { Family } from "../src/state/fontStore.ts";
import type { FontFace } from "../src/lib/ipc.ts";

function face(family: string, names: { lang: string; name: string }[], style = "Regular"): FontFace {
  return {
    id: `${family}#0`,
    path: `C:/fonts/${family}.ttf`,
    previewPath: null,
    faceIndex: 0,
    family,
    style,
    postscriptName: null,
    localizedNames: names,
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
    glyphCount: 100,
    fileSize: 1000,
    source: "user",
    deactivatable: true,
    active: true,
    addedAt: null,
  };
}

function family(name: string, faces: FontFace[]): Family {
  return { name, faces } as unknown as Family;
}

test("英文名与中文名同时存在时，英文名单独取出", () => {
  const f = family(
    "思源黑体",
    [face("思源黑体", [
      { lang: "en", name: "Source Han Sans" },
      { lang: "zh-Hans", name: "思源黑体" },
      { lang: "ja", name: "源ノ角ゴシック" },
    ])],
  );
  assert.equal(englishFamilyName(f), "Source Han Sans");
  assert.deepEqual(
    otherFamilyNames(f).map((n) => `${n.lang}:${n.name}`),
    ["ja:源ノ角ゴシック"],
  );
});

test("没有英文名时 englishFamilyName 返回 null", () => {
  const f = family("思源黑体", [face("思源黑体", [{ lang: "zh-Hans", name: "思源黑体" }])]);
  assert.equal(englishFamilyName(f), null);
  assert.deepEqual(otherFamilyNames(f), []);
});

test("与列表显示名相同的项不重复出现", () => {
  const f = family("Lora", [face("Lora", [{ lang: "en", name: "lora" }])]);
  assert.deepEqual(extraFamilyNames(f), []);
});

test("多个字面里的名字去重，英文优先排在最前", () => {
  const f = family("ノト セリフ", [
    face("ノト セリフ", [{ lang: "ja", name: "Noto Serif JP" }], "Bold"),
    face("ノト セリフ", [
      { lang: "ja", name: "Noto Serif JP" },
      { lang: "en", name: "Noto Serif" },
      { lang: "ko", name: "Noto Serif KR" },
    ]),
  ]);
  const names = extraFamilyNames(f).map((n) => `${n.lang}:${n.name}`);
  assert.deepEqual(names, ["en:Noto Serif", "ja:Noto Serif JP", "ko:Noto Serif KR"]);
});

test("没有 localizedNames 字段时不报错", () => {
  const bare = { ...face("Inter", []), localizedNames: undefined } as FontFace;
  assert.deepEqual(extraFamilyNames(family("Inter", [bare])), []);
});

test("语言标签回退与名称截断", () => {
  assert.equal(languageLabel("en", "zh-CN"), "英语");
  assert.equal(languageLabel("not-a-lang", "zh-CN"), "not-a-lang");
  assert.equal(shortName("short"), "short");
  assert.equal(shortName("x".repeat(40), 10).length, 10);
});
