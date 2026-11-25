import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirNameOf } from "../src/workshop/upload.ts";

/**
 * 下架（2026-11-25 用户报「仓库里的插件并没有删除」）。
 *
 * 根因：`index.json` 的 `dir` 是**仓库相对路径** `plugins/<id>__<作者>`，下架代码却把它
 * 直接塞进 `plugins/${dir}/`，拼成 `plugins/plugins/...` —— 一条 blob 都匹配不上，
 * 于是插件明明还在仓库里，面板却报「仓库里已经没有这个插件目录了」。
 *
 * 这里钉两件事：① 归一化只取最后一段且拒绝越界；② 删除路径与面板入口都必须走它。
 */

const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

test("dirNameOf：仓库相对路径只取最后一段", () => {
  assert.equal(dirNameOf("plugins/com.iieozo.adobe-font__helloooooseff"), "com.iieozo.adobe-font__helloooooseff");
  assert.equal(dirNameOf("plugins/font-renamer__alice"), "font-renamer__alice");
  assert.equal(dirNameOf("plugins/my.plugin__alice"), "my.plugin__alice");
  // 裸目录名（面板自己拼的那种）原样保留
  assert.equal(dirNameOf("font-renamer__alice"), "font-renamer__alice");
  assert.equal(dirNameOf("  plugins/a__b  "), "a__b", "前后空白要容忍");
});

test("dirNameOf：越界 / 非法输入一律 null（与 Rust 的 dir_name_of 同口径）", () => {
  assert.equal(dirNameOf("plugins/../evil"), null);
  assert.equal(dirNameOf("../evil"), null);
  assert.equal(dirNameOf("plugins/./evil"), null);
  assert.equal(dirNameOf(".."), null);
  assert.equal(dirNameOf("."), null);
  assert.equal(dirNameOf("plugins\\..\\evil"), null);
  assert.equal(dirNameOf("plugins\\evil"), null);
  assert.equal(dirNameOf("C:/evil"), null);
  assert.equal(dirNameOf("evil:stream"), null);
  assert.equal(dirNameOf("plugins/.hidden"), null);
  assert.equal(dirNameOf("plugins/"), null, "末段为空 → null，不回落成 plugins");
  assert.equal(dirNameOf(""), null);
  assert.equal(dirNameOf("   "), null);
  assert.equal(dirNameOf("plugins/a b"), null);
});

test("两个下架入口都先用 dirNameOf 归一化，不再直接拿 dirs 拼路径", () => {
  const src = read("src/workshop/upload.ts");
  assert.match(src, /function removeTargets\(/, "缺少归一化入口");
  assert.match(src, /dirNameOf\(d\)/);
  // 直推与 PR 两条路都必须用归一化后的 names 去匹配 blob
  const matches = src.match(/names\.some\(\(d\) => e\.path\.startsWith\(`plugins\/\$\{d\}\/`\)\)/g) ?? [];
  assert.equal(matches.length, 2, "直推 / PR 两条路都要按目录名匹配");
  assert.equal(
    /dirs\.some\(\(d\) => e\.path\.startsWith/.test(src),
    false,
    "还有一处拿原始 dirs 拼 `plugins/${dir}/` —— 会拼出 plugins/plugins/…",
  );
});

test("面板交给下架的目录来自 communityDirFor（末段），不是 registry 的整条路径", () => {
  const src = read("src/workshop/UploadDialog.tsx");
  assert.match(src, /communityDirFor\(e\)/);
  assert.equal(/dir: e\.dir!/.test(src), false, "不能再把 registry 的 dir 原样传给下架");
});
