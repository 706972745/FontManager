import { test } from "node:test";
import assert from "node:assert/strict";
import { familyMatches, fileNameOf, searchTokens } from "../src/lib/familySearch.ts";

/**
 * 字体族搜索（用户 2026-11-01：「有些都搜索不到」）。
 *
 * 旧的匹配只覆盖族名 / 标签 / 格式 / 厂商 / 备注 / 授权 / 本地化名，所以：
 *   - 搜 `semibold` 找不到任何东西（字重只在 face.style 上）
 *   - 搜 `HelveticaNeueLTPro-Bd` 找不到（PostScript 名没进索引）
 *   - 搜 `msyh` 找不到（文件名没进索引）
 *   - 搜「中文」「衬线」「连字」找不到（只是 i18n 文案，字体数据里是 han/serif/liga）
 */

const fam = (over: Partial<Parameters<typeof familyMatches>[0]> = {}) => ({
  name: "Helvetica Neue LT Pro",
  tags: [],
  formats: ["ttf"],
  foundry: null,
  license: null,
  copyright: null,
  scripts: ["latin"],
  features: [],
  classification: "sans",
  faces: [
    {
      style: "Regular",
      postscriptName: "HelveticaNeueLTPro-Roman",
      path: "C:\\lib\\Helvetica\\HelveticaNeueLTPro-Roman.ttf",
    },
  ],
  ...over,
});

const hit = (f: ReturnType<typeof fam>, q: string, labels = {}) =>
  familyMatches(f, searchTokens(q), labels);

test("族名：大小写不敏感，子串命中", () => {
  assert.equal(hit(fam(), "helvetica"), true);
  assert.equal(hit(fam(), "NEUE"), true);
  assert.equal(hit(fam(), "zzz"), false);
});

test("字重样式名能搜到（旧实现的最大漏项）", () => {
  const f = fam({
    faces: [
      { style: "Semibold Italic", postscriptName: "X-SemiboldItalic", path: "C:/l/x.ttf" },
    ],
  });
  assert.equal(hit(f, "semibold"), true);
  assert.equal(hit(f, "italic"), true);
});

test("PostScript 名与文件名能搜到", () => {
  const f = fam({
    faces: [
      { style: "Regular", postscriptName: "HelveticaNeueLTPro-Roman", path: "C:/l/HelveticaNeue.ttf" },
    ],
  });
  assert.equal(hit(f, "ltpro-roman"), true);
  assert.equal(hit(f, "HelveticaNeue"), true);
});

test("本地化名：拼音族名也能用中文名找到", () => {
  const f = fam({
    name: "zihunchuangzhonghei",
    faces: [
      {
        style: "Regular",
        postscriptName: "HYc4gf",
        path: "C:/l/HYc4gf.ttf",
        localizedNames: [{ name: "字魂创中黑(商用需授权)" }],
      },
    ],
  });
  assert.equal(hit(f, "字魂创中黑"), true);
});

test("语言 / 分类 / 特性：编码与本地化文案都能命中", () => {
  const f = fam({
    name: "Noto Sans CJK",
    scripts: ["han", "latin"],
    classification: "sans",
    features: ["liga"],
  });
  const labels = {
    script: { han: "中文", latin: "拉丁文" },
    classification: { sans: "无衬线" },
    feature: { liga: "连字" },
  };
  assert.equal(hit(f, "han", labels), true);
  assert.equal(hit(f, "中文", labels), true);
  assert.equal(hit(f, "无衬线", labels), true);
  assert.equal(hit(f, "连字", labels), true);
  // 没给 labels 时不能崩，也不能误命中
  assert.equal(hit(f, "中文"), false);
});

test("多关键词 = AND，且可以跨字段", () => {
  const f = fam({
    faces: [
      { style: "Bold", postscriptName: "Noto-Bold", path: "C:/l/noto.ttf" },
    ],
    scripts: ["han"],
    classification: "sans",
  });
  const labels = { script: { han: "中文" } };
  assert.equal(hit(f, "bold 中文", labels), true);
  assert.equal(hit(f, "bold 日文", labels), false);
  // 反序词序也能出结果（旧实现要求整串连续出现）
  assert.equal(hit(f, "neue helvetica"), true);
});

/**
 * OBS-1（2026-11-01 测试报告，低危观察项）：「衬线」不能命中「无衬线」。
 *
 * 标签本地化名以前按子串匹配，而「无衬线」包含「衬线」、「自由连字」包含「连字」、
 * 英文「Discretionary ligatures」包含「Ligatures」——搜一个分类会把它的反面
 * 和邻居一并拖出来（实测搜「衬线」= 1172 族，其中 713 个是无衬线）。
 * 规则：查询词正好等于某个标签全名时只按全等匹配；打部分词时仍走子串。
 */
test("OBS-1：标签全名精确匹配，「衬线」不再蹭「无衬线」", () => {
  const labels = {
    script: { han: "中文", cjk: "中日韩" },
    classification: { sans: "无衬线", serif: "衬线" },
    feature: { liga: "连字", dlig: "自由连字" },
  };
  const sans = fam({ classification: "sans" });
  const serif = fam({ classification: "serif" });
  const dlig = fam({ features: ["dlig"], classification: "serif" });
  const liga = fam({ features: ["liga"], classification: "serif" });

  // 全名精确命中，且不拖邻居
  assert.equal(hit(serif, "衬线", labels), true);
  assert.equal(hit(sans, "衬线", labels), false);
  assert.equal(hit(sans, "无衬线", labels), true);
  assert.equal(hit(liga, "连字", labels), true);
  assert.equal(hit(dlig, "连字", labels), false);
  assert.equal(hit(dlig, "自由连字", labels), true);

  // 查询词不是任何标签的全名（用户在打部分词）→ 仍按子串，保留宽容度
  assert.equal(hit(sans, "衬", labels), true);
  assert.equal(hit(sans, "无", labels), true);

  // 编码匹配不受影响：serif 命中 serif，不会命中 sans
  assert.equal(hit(serif, "serif", labels), true);
  assert.equal(hit(sans, "serif", labels), false);

  // 英文标签同样是子串关系（Ligatures ⊂ Discretionary ligatures），一起修
  const en = {
    classification: { sans: "Sans", serif: "Serif" },
    feature: { liga: "Ligatures", dlig: "Discretionary ligatures" },
  };
  assert.equal(hit(liga, "ligatures", en), true);
  assert.equal(hit(dlig, "ligatures", en), false);
  assert.equal(hit(dlig, "discretionary", en), true);
});

test("空查询 = 全部通过；单个空格不算关键词", () => {
  assert.equal(hit(fam(), ""), true);
  assert.equal(hit(fam(), "   "), true);
  assert.deepEqual(searchTokens("  a  b "), ["a", "b"]);
});

test("fileNameOf 兼容 Windows 反斜杠与正斜杠", () => {
  assert.equal(fileNameOf("C:\\Windows\\Fonts\\msyh.ttc"), "msyh.ttc");
  assert.equal(fileNameOf("E:/lib/a/b/c.otf"), "c.otf");
  assert.equal(fileNameOf("noext"), "noext");
});
