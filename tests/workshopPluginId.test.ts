import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isPluginId, parseWorkshopIndex, PLUGIN_ID_MAX } from "../src/lib/workshop.ts";
import { MAX_NAME, validatePlugin, type PickedFile, type PluginForm } from "../src/workshop/upload.ts";

/**
 * 插件 ID 统一成 `FM-XXX-XXX`（2026-11-26 用户口径）。
 *
 * 目的不是好看，是**跨软件共用一个插件库**：`FM` 前缀一眼分清是谁的插件，
 * 别的软件用自己的前缀，同一个 registry 里不会互相抢名字。所以这条规则是闸门：
 *
 * - 上传：不是 `FM-XXX-XXX` 一律不允许提交（本地就拦，不等 CI）；
 * - 插件中心：不符合的条目不显示（官方件一样，所以官方插件也全部改名）；
 * - 前缀 `FM` **必须大写**；两段各自是任意字母数字，大小写随意、长度不限（≤ 总长上限）。
 */

const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

test("isPluginId：FM-XXX-XXX 的各种合法写法都放行", () => {
  for (const id of [
    "FM-ADOBE-FONT",
    "FM-FONT-SYNC",
    "FM-001-abc",
    "FM-A-B",
    "FM-AbC-dEf123",
    "FM-9-9",
  ]) {
    assert.equal(isPluginId(id), true, `${id} 应当合法`);
  }
  // 前后空白不算内容（表单里手滑带空格不该算错）
  assert.equal(isPluginId("  FM-ADOBE-FONT  "), true);
});

test("isPluginId：旧命名与各种走样写法全部拒绝", () => {
  for (const id of [
    "font-renamer", // 老命名
    "com.iieozo.adobe-font", // 反向域名式
    "fm-abc-def", // 前缀必须大写
    "Fm-abc-def",
    "FM-ABC", // 只有一段
    "FM-A-B-C", // 多了一段
    "FM--AB", // 空段
    "FM-AB-", // 尾段为空
    "FM-AB_C-D", // 下划线不在字母数字里
    "FM-AB C-D", // 空格
    "FM-AB-CD/EF", // 路径分隔符
    "FM-AB\n-CD", // 段内有换行
    "",
  ]) {
    assert.equal(isPluginId(id), false, `${JSON.stringify(id)} 应当被拒`);
  }
});

test("isPluginId：整串长度有上限（目录名不能无限长）", () => {
  assert.equal(PLUGIN_ID_MAX, 40);
  // FM- + a*16 + - + b*20 = 40，边界内
  const edge = `FM-${"a".repeat(16)}-${"b".repeat(20)}`;
  assert.equal(edge.length, 40);
  assert.equal(isPluginId(edge), true);
  // 再多一个字符就越界
  const over = `FM-${"a".repeat(16)}-${"b".repeat(21)}`;
  assert.equal(over.length, 41);
  assert.equal(isPluginId(over), false);
});

test("清单解析：只留 FM 前缀的条目（官方 / 社区同一条闸）", () => {
  const idx = parseWorkshopIndex({
    official: [
      { id: "FM-FONT-SYNC", name: "字体同步" },
      { id: "font-sync", name: "老官方件" },
    ],
    plugins: [
      { id: "FM-ACME-RENAME", name: "批量重命名" },
      { id: "font-renamer", name: "老社区件" },
      { id: "fm-lower-case", name: "小写前缀" },
    ],
  });
  assert.deepEqual(
    idx.entries.map((e) => e.id),
    ["FM-FONT-SYNC", "FM-ACME-RENAME"],
    "非 FM- 的条目连解析都不该出来",
  );
});

test("上传校验：不是 FM-XXX-XXX 直接报错（本地就拦住，不等到 CI）", () => {
  const files: PickedFile[] = [{ path: "main.js", size: 8, bytes: new Uint8Array(8) }];
  const form = (id: string): PluginForm => ({
    id,
    name: "演示",
    entry: "main.js",
    version: "1.0.0",
    apiLevel: 1,
    permissions: [],
    brief: "简介",
    detail: "",
    runtime: "node",
    lang: "zh-CN",
    minAppVersion: "",
  });
  const idIssue = (id: string) =>
    validatePlugin(form(id), files).find((i) => i.key === "uploadErrId");

  assert.equal(idIssue("FM-ACME-RENAME"), undefined, "合规 id 不报错");
  const bad = idIssue("com.acme.renamer");
  assert.ok(bad, "老命名必须报错");
  assert.equal(bad.level, "error", "是 error，不能只是 warn");
  assert.equal(bad.vars?.max, PLUGIN_ID_MAX, "提示里带上总长上限");
});

test("名称上限 25 字（2026-11-26 由 15 放宽）", () => {
  assert.equal(MAX_NAME, 25);
});

test("上传弹窗：提交前就把 ID 规范说清楚，并给出样例占位", () => {
  const dlg = read("src/workshop/UploadDialog.tsx");
  assert.match(dlg, /uploadIdRule/, "顶部要有 ID 规范提示");
  assert.match(dlg, /placeholder="FM-ADOBE-FONT"/, "id 输入框的样例要写成 FM 形式");
  const css = read("src/workshop/panel.css");
  assert.match(css, /\.ws-up-idrule\s*\{/, "提示条要有自己的样式（不只是灰字）");
});

test("ID 文案九套语言齐全，且都写明 FM 前缀", () => {
  const i18n = read("src/workshop/i18n.ts");
  for (const key of ["uploadIdRule", "uploadErrId", "fIdTip", "fId"]) {
    assert.equal((i18n.match(new RegExp(`"${key}"`, "g")) ?? []).length, 9, `${key} 要有九套语言`);
  }
  // 每条 uploadIdRule 都必须出现 FM-XXX-XXX 字样（避免翻译漏掉硬规则）
  const rules = i18n.match(/"uploadIdRule": "[^"\n]*"/g) ?? [];
  assert.equal(rules.length, 9);
  for (const r of rules) assert.ok(r.includes("FM-XXX-XXX"), `规范文案里没写 FM-XXX-XXX：${r}`);
});
