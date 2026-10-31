import { test } from "node:test";
import assert from "node:assert/strict";
import { listChars } from "../src/lib/listChars.ts";

const DEFAULT = "Hello IIEOzo";
const fam = (name: string, styles: string[]) => ({
  name,
  faces: styles.map((s) => ({ style: s })),
});

test("默认示例文字：示例文字 / 族名 / style 名 / Aa 全都要在", () => {
  const chars = listChars(fam("思源黑体", ["Regular", "Bold"]), DEFAULT, DEFAULT);
  assert.ok(chars);
  for (const ch of "HeloIEOz") assert.ok(chars.includes(ch), `缺 ${ch}`);
  for (const ch of "思源黑体") assert.ok(chars.includes(ch), `缺 ${ch}`);
  for (const ch of "RegularBd") assert.ok(chars.includes(ch), `缺 ${ch}`);
  assert.ok(chars.includes("A") && chars.includes("a"));
});

test("示例文字为空时用族名渲染，字符集仍要含族名", () => {
  // 卡片里 `const text = sampleText.trim() || family.name` —— 空输入时渲染的是族名
  const chars = listChars(fam("方正兰亭黑", ["Regular"]), "", DEFAULT);
  assert.ok(chars);
  for (const ch of "方正兰亭黑") assert.ok(chars.includes(ch));
});

test("自定义示例文字照常走子集（2026-11-01 起，不再整条回退）", () => {
  // 旧规则是「自定义就 return null」，后果是用户一改示例文字这条优化就永久关掉，
  // 而且没有任何提示（用户把默认 Hello IIEOzo 改成 Hello IIEOzoa 就踩到了）。
  const chars = listChars(fam("A", ["Regular"]), "Hello IIEOzoa", DEFAULT);
  assert.ok(chars, "自定义文字也要走子集");
  for (const ch of "Hello IIEOzoa") assert.ok(chars.includes(ch), `缺 ${ch}`);
});

test("自定义示例文字过长时回退（整段句子不是预览用途）", () => {
  const long = "永".repeat(33);
  assert.equal(listChars(fam("A", ["Regular"]), long, DEFAULT), null);
  // 边界：正好 32 个字符仍然走子集
  assert.ok(listChars(fam("A", ["Regular"]), "永".repeat(32), DEFAULT));
});

test("默认文字带首尾空格仍算默认", () => {
  const chars = listChars(fam("A", ["Regular"]), `  ${DEFAULT}  `, DEFAULT);
  assert.ok(chars);
  assert.ok(chars.includes("H"));
});

test("去重并排序：同一字符只出现一次", () => {
  // 族名连写 4 个 a，加上 "Aa" 里的 a，去重后只应剩 1 个
  const chars = listChars(fam("aaaa", ["Regular"]), DEFAULT, DEFAULT);
  assert.ok(chars);
  const a = [...chars].filter((c) => c === "a").length;
  assert.equal(a, 1);
  // 排序后的顺序稳定，前后端 hash 才能对上
  assert.equal(chars, [...chars].sort().join(""));
});

test("family 为 null 时返回 null（列表还没就绪）", () => {
  assert.equal(listChars(null, DEFAULT, DEFAULT), null);
  assert.equal(listChars(undefined, DEFAULT, DEFAULT), null);
});

test("style 为空 / 缺失时不炸", () => {
  const chars = listChars({ name: "X", faces: [{ style: null }, {}] }, DEFAULT, DEFAULT);
  assert.ok(chars);
  assert.ok(chars.includes("X"));
});

test("所有语言的名字都要收进来（速览的族名按界面语言取，可能是另一串）", () => {
  // 速览里族名是用该字体渲染的，displayFamilyName 会按界面语言挑一条：
  // 只放 family.name 的话，中文界面下这串中文就不在子集里 → 族名回退系统字体。
  const chars = listChars(
    {
      name: "Constantia",
      faces: [
        {
          style: "Regular",
          localizedNames: [
            { lang: "en", name: "Constantia" },
            { lang: "zh-Hans", name: "康斯坦蒂亚" },
            { lang: "ja", name: "コンスタンティア" },
          ],
        },
      ],
    },
    DEFAULT,
    DEFAULT,
  );
  assert.ok(chars);
  for (const ch of "康斯坦蒂亚") assert.ok(chars.includes(ch), `缺中文名 ${ch}`);
  for (const ch of "コンスタンティア") assert.ok(chars.includes(ch), `缺日文名 ${ch}`);
});

test("style 为空时字重行会退到 PostScript 名，也要覆盖", () => {
  const chars = listChars(
    { name: "X", faces: [{ style: null, postscriptName: "Xy-BoldIt" }] },
    DEFAULT,
    DEFAULT,
  );
  assert.ok(chars);
  for (const ch of "Xy-BoldIt") assert.ok(chars.includes(ch), `缺 ${ch}`);
});
