import { test } from "node:test";
import assert from "node:assert/strict";
import { familyCopyrightClass, leadFace } from "../src/lib/license.ts";
import type { FontFace } from "../src/lib/ipc.ts";

const face = (style: string, extra: Partial<FontFace> = {}) =>
  ({ style, license: null, copyrightClass: null, ...extra }) as unknown as FontFace;

test("代表字面：Regular 优先，没有 Regular 就用第一个", () => {
  const italic = face("Italic");
  const regular = face("Regular");
  assert.equal(leadFace([italic, regular]), regular);
  assert.equal(leadFace([italic]), italic);
  assert.equal(leadFace([]), undefined);
});

test("版权看代表字面：Regular 是 OFL 就算商用免费（哪怕别的字面没信息）", () => {
  const faces = [face("Italic"), face("Regular", { license: "SIL Open Font License 1.1" })];
  assert.equal(familyCopyrightClass(faces), "free_commercial");
});

test("回归：Regular 没版权、别的字面有 —— 与徽标同口径，不再判成商用免费", () => {
  // 这正是「勾了商用免费却筛出标着未知的卡」的根因：
  // 聚合字段取的是「第一个非空字面」，徽标取的是 Regular，两者给出不同分类
  const faces = [
    face("Italic", { license: "Free for personal use only" }),
    face("Regular"),
  ];
  assert.equal(familyCopyrightClass(faces), "unknown");
  // 换成 Regular 有「个人免费」信息时，两边都该是 free_personal
  assert.equal(
    familyCopyrightClass([
      face("Italic", { license: "SIL Open Font License 1.1" }),
      face("Regular", { license: "Free for personal use only" }),
    ]),
    "free_personal",
  );
});

test("手动设置优先于字体自带信息", () => {
  const faces = [face("Regular", { license: "SIL Open Font License 1.1" })];
  assert.equal(familyCopyrightClass(faces, "paid"), "paid");
  assert.equal(familyCopyrightClass(faces, "timelimited"), "timelimited");
  // 设成「未知」也要生效（不能被自带信息盖回去）
  assert.equal(familyCopyrightClass(faces, "unknown"), "unknown");
  // 空 / 无效值 = 跟随自动判定
  assert.equal(familyCopyrightClass(faces, ""), "free_commercial");
  assert.equal(familyCopyrightClass(faces, null), "free_commercial");
});

test("目录备注（字面 copyrightClass）作兜底", () => {
  const faces = [face("Regular", { copyrightClass: "free_commercial" })];
  assert.equal(familyCopyrightClass(faces), "free_commercial");
});

test("空字面列表不会崩，按未知处理", () => {
  assert.equal(familyCopyrightClass([]), "unknown");
});
