import { test } from "node:test";
import assert from "node:assert/strict";
import {
  displayFamilyName,
  englishFamilyName,
  extraFamilyNames,
  languageLabel,
  languagePriority,
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

test("显示名优先用界面语言的本地化名（没有才回退默认名）", () => {
  const zh = family("Noto Serif", [
    {
      ...face("Noto Serif", [
        { lang: "en", name: "Noto Serif" },
        { lang: "zh-Hans", name: "思源宋体" },
        { lang: "ja", name: "Noto Serif JP" },
      ]),
    },
  ]);
  // 简体界面 → 中文名
  assert.equal(displayFamilyName(zh, "zh-CN"), "思源宋体");
  // 日文界面 → 日文名
  assert.equal(displayFamilyName(zh, "ja"), "Noto Serif JP");
  // 英文界面 → 回退默认名
  assert.equal(displayFamilyName(zh, "en"), "Noto Serif");

  // 繁体界面优先繁体名
  const trad = family("Noto Serif TC", [
    {
      ...face("Noto Serif TC", [
        { lang: "en", name: "Noto Serif TC" },
        { lang: "zh-Hant", name: "思源宋體" },
        { lang: "zh-Hans", name: "思源宋体" },
      ]),
    },
  ]);
  assert.equal(displayFamilyName(trad, "zh-TW"), "思源宋體");
  assert.equal(displayFamilyName(trad, "zh-CN"), "思源宋体");

  // 完全没有该语言名字 → 原样返回
  const onlyEn = family("Inter", [
    { ...face("Inter", [{ lang: "en", name: "Inter" }]) },
  ]);
  assert.equal(displayFamilyName(onlyEn, "zh-CN"), "Inter");

  assert.deepEqual(languagePriority("zh-TW"), ["zh-hant", "zh-tw", "zh-hk", "zh"]);
});
