import { test } from "node:test";
import assert from "node:assert/strict";
import { faceFullName, faceStyleLabel } from "../src/lib/faceName.ts";
import type { FontFace } from "../src/lib/ipc.ts";

/** 只关心名字相关字段：其余字段对这两个函数没有影响，用不到就别造 */
const face = (over: Partial<FontFace>): FontFace =>
  ({
    id: "f1",
    path: "/fonts/SourceSerif4-Bold.otf",
    family: "Source Serif 4",
    style: "Bold",
    postscriptName: "SourceSerif4-Bold",
    ...over,
  }) as FontFace;

test("全名 = 族名 + 空格 + 样式（右键菜单「复制名字」的拼法）", () => {
  assert.equal(faceFullName("Source Serif 4", face({})), "Source Serif 4 Bold");
});

test("样式为空 → 只剩族名，不留尾随空格", () => {
  assert.equal(faceFullName("Source Serif 4", face({ style: "" })), "Source Serif 4");
  assert.equal(faceFullName("Source Serif 4", face({ style: "   " })), "Source Serif 4");
});

test("族名与样式都为空 → 退回 PostScript 名", () => {
  assert.equal(faceFullName("", face({ style: "" })), "SourceSerif4-Bold");
  assert.equal(faceFullName("   ", face({ style: "  " })), "SourceSerif4-Bold");
});

test("连 PostScript 名都没有 → 退回文件名（正反斜杠都认）", () => {
  const posix = face({ style: "", postscriptName: null, path: "/fonts/OTF/Bold.otf" });
  assert.equal(faceFullName("", posix), "Bold.otf");
  const win = face({ style: "", postscriptName: null, path: "C:\\fonts\\OTF\\Bold otf.ttf" });
  assert.equal(faceFullName("", win), "Bold otf.ttf");
});

test("什么都没有 → 兜一个占位符，绝不返回空串（菜单标题总得有东西）", () => {
  assert.equal(faceFullName("", face({ style: "", postscriptName: null, path: "/" })), "—");
});

test("样式名显示：去掉首尾空格，空则退 PostScript 名，再空则 Regular", () => {
  assert.equal(faceStyleLabel(face({ style: "  Bold Italic  " })), "Bold Italic");
  assert.equal(faceStyleLabel(face({ style: "   ", postscriptName: "X-Bold" })), "X-Bold");
  assert.equal(faceStyleLabel(face({ style: "", postscriptName: null })), "Regular");
});

test("全名与样式名共用一个来源：字重行显示的名字是复制串的后半段", () => {
  const f = face({ style: "Light Italic" });
  assert.equal(faceFullName("Source Serif 4", f), `Source Serif 4 ${faceStyleLabel(f)}`);
});

/* ─── 2026-11-12 QA 补充：退回链里「运行时真的缺字段」那几档 ────────────────
   上面的用例都用 null / "" 表达「没有」。运行时的字库里这两种更常见：
   字段整个是 `undefined`（老快照 / JSON 里根本没这个键）、或者路径里没有分隔符。
   老写法 `` `${family.name} ${face.style}` `` 在 `style === undefined` 时会把
   字面量 "undefined" 拼进剪贴板 —— 抽象成 faceFullName 之后才有机会挡住。 */

test("样式是 undefined（不是空串）→ 只留族名，不许把 \"undefined\" 拼进去", () => {
  const f = face({ style: undefined });
  assert.equal(faceFullName("Source Serif 4", f), "Source Serif 4");
  assert.doesNotMatch(faceFullName("Source Serif 4", f), /undefined/);
  // 显示侧同样不能漏出 "undefined"
  assert.equal(faceStyleLabel(face({ style: undefined, postscriptName: "X-Bold" })), "X-Bold");
});

test("PostScript 名是 undefined（不是 null）→ 继续退到文件名", () => {
  const f = face({ style: undefined, postscriptName: undefined, path: "C:\\fonts\\A B.ttf" });
  assert.equal(faceFullName("", f), "A B.ttf");
});

test("路径里没有分隔符 → 整串就是文件名", () => {
  const f = face({ style: "", postscriptName: null, path: "Bold.otf" });
  assert.equal(faceFullName("", f), "Bold.otf");
});

test("路径是 undefined → 最后兜到占位符，不抛异常", () => {
  const f = face({ style: "", postscriptName: null, path: undefined });
  assert.equal(faceFullName("", f), "—");
});

test("族名和样式都正常时，全名以族名开头（剪贴板串能被族名索引到）", () => {
  const f = face({ style: "Medium Italic" });
  assert.ok(faceFullName("Noto Sans", f).startsWith("Noto Sans"));
});
