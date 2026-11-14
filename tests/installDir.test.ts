import test from "node:test";
import assert from "node:assert/strict";
import { normalizeInstallDir } from "../src/lib/installDir.ts";

/**
 * 安装界面「浏览…」选的目录必须落到 `<所选目录>\FontManager`
 * （用户 2026-11-14：不能把程序文件摊在用户选的那个文件夹里，也不该让安装目录
 * 变成「新建文件夹」这种名字）。
 */

test("普通目录：后面接一层 FontManager", () => {
  assert.equal(
    normalizeInstallDir("E:\\Users\\87557\\Desktop\\新建文件夹"),
    "E:\\Users\\87557\\Desktop\\新建文件夹\\FontManager",
  );
});

test("已经叫 FontManager 的不再套第二层（大小写不敏感）", () => {
  assert.equal(normalizeInstallDir("D:\\Users\\87557\\fontmanager"), "D:\\Users\\87557\\fontmanager");
  assert.equal(normalizeInstallDir("D:\\Apps\\FontManager"), "D:\\Apps\\FontManager");
  assert.equal(normalizeInstallDir("D:\\Apps\\FONTMANAGER"), "D:\\Apps\\FONTMANAGER");
});

test("尾部斜杠：先削掉再接", () => {
  assert.equal(normalizeInstallDir("D:\\Apps\\"), "D:\\Apps\\FontManager");
  assert.equal(normalizeInstallDir("D:\\Apps\\FontManager\\"), "D:\\Apps\\FontManager");
});

test("盘符根：E: 与 E:\\ 都接到 E:\\FontManager", () => {
  assert.equal(normalizeInstallDir("E:"), "E:\\FontManager");
  assert.equal(normalizeInstallDir("E:\\"), "E:\\FontManager");
});

test("UNC 路径：共享名后面接一层", () => {
  assert.equal(normalizeInstallDir("\\\\nas\\fonts"), "\\\\nas\\fonts\\FontManager");
});

test("空输入原样退回（调用方会忽略）", () => {
  assert.equal(normalizeInstallDir(""), "");
  assert.equal(normalizeInstallDir("   "), "");
});
