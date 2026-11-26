import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_NAME, validatePlugin, type PickedFile, type PluginForm } from "../src/workshop/upload.ts";

/**
 * 上传面板的交互与「上传前先规范好」这一批改动。
 *
 * 两条主线：
 * 1. **名称上限 25 字**（原来只校验非空）：超过就不允许提交，而不是等 CI 打回。（2026-11-26 由 15 放宽 —— 15 位对「Adobe 套字器（批量）」这类中文名太紧。）
 *    按字符数算，中文 / emoji 一个字就是一个字。
 * 2. **提交后留在面板**：草稿转「已提交 #N」、表单空出来、内联提示条说清
 *    「还要等维护者合并」。以前成功后是草稿原样留着 + 全屏浮层，容易重复开 PR。
 */

const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

const form = (patch: Partial<PluginForm> = {}): PluginForm => ({
  id: "FM-ACME-RENAME",
  name: "字体重命名",
  entry: "main.js",
  version: "1.0.0",
  apiLevel: 1,
  permissions: ["read:fonts"],
  brief: "一句话简介",
  detail: "详情",
  runtime: "node",
  lang: "zh-CN",
  minAppVersion: "",
  ...patch,
});

const files: PickedFile[] = [{ path: "main.js", size: 8, bytes: new Uint8Array(8) }];

const has = (issues: { key: string }[], key: string) => issues.some((i) => i.key === key);
const nameIssue = (name: string) =>
  validatePlugin(form({ name }), files).find((i) => i.key === "uploadErrNameLong");

test("名称 ≤ 25 字放行，26 字拦住并带上限值", () => {
  assert.equal(MAX_NAME, 25);
  assert.equal(nameIssue("字".repeat(25)), undefined, "25 字应当通过");
  const over = nameIssue("字".repeat(26));
  assert.ok(over, "26 字必须报错");
  assert.equal(over.level, "error", "是 error，不是 warn —— 否则照样能提交");
  assert.equal(over.vars?.max, 25);
});

test("名称按字符数算：中文与 emoji 一个字算一个", () => {
  assert.equal(nameIssue("😀".repeat(25)), undefined, "25 个 emoji 应当通过");
  assert.ok(nameIssue("😀".repeat(26)), "26 个 emoji 必须报错（按 UTF-16 长度算会误判成 52）");
  assert.equal(nameIssue("字".repeat(24) + "😀"), undefined, "混排 25 字通过");
});

test("名称首尾空格不计入，纯空格仍算空", () => {
  assert.equal(nameIssue("  " + "字".repeat(25) + "  "), undefined, "trim 后 25 字应通过");
  assert.ok(has(validatePlugin(form({ name: "   " }), files), "uploadErrName"), "纯空格 = 空");
});

test("提交成功后：草稿转「已提交」、表单空出来、不再重复提交", () => {
  const dlg = read("src/workshop/UploadDialog.tsx");

  // 只对未提交的草稿校验/计数/提交
  assert.match(dlg, /const pending = useMemo\(\(\) => drafts\.filter\(\(d\) => !d\.submitted\), \[drafts\]\)/);
  assert.match(dlg, /const ready = pending\.length > 0/, "ready 不能把已提交的算进去");
  assert.match(dlg, /const batch = pending;/, "提交的是未提交的那一批");

  // 成功后写 submitted、清 activeKey、弹内联条
  assert.match(dlg, /submitted: \{ prNumber: out\.prNumber, prUrl: out\.prUrl \}/);
  assert.match(dlg, /setActiveKey\(null\)/, "提交完表单要空出来给下一个插件");
  assert.match(dlg, /setBanner\(\{ prUrl: out\.prUrl, prNumber: out\.prNumber \}\)/);

  // 已提交的行不可编辑、右侧按钮改成「打开请求」
  assert.match(dlg, /onClick=\{\(\) => !done && setActiveKey\(d\.key\)\}/);
  assert.match(dlg, /disabled=\{!!done\}/);
  assert.match(dlg, /uploadSubmittedTag/);

  // 旧的全屏成功浮层必须已经删掉（它挡住了表单，人也不被告知要等合并）
  assert.equal(/\{result && \(/.test(dlg), false, "全屏成功浮层应已移除");
  assert.equal(/setResult\(/.test(dlg), false, "setResult 应已移除");
});

test("补上的提醒：等维护者合并 / 未勾规则 / 署名", () => {
  const dlg = read("src/workshop/UploadDialog.tsx");
  assert.match(dlg, /uploadPendingMerge/, "要说明「上传要等合并、下架是自动的」");
  assert.match(dlg, /uploadNeedAgree/, "按钮为什么是灰的要说出来");
  assert.match(dlg, /uploadSuccessInline/, "成功提示要带 PR 号和下一步");
  assert.match(dlg, /uploadSignAs/, "表单要显示署名");

  // Esc 关闭（分等级退：确认弹窗 → 提示条 → 弹窗）
  assert.match(dlg, /e\.key !== "Escape" \|\| phase !== null/);
  assert.match(dlg, /addEventListener\("keydown", onKey\)/);

  const i18n = read("src/workshop/i18n.ts");
  for (const key of [
    "uploadErrNameLong",
    "uploadSuccessInline",
    "uploadPendingMerge",
    "uploadNeedAgree",
    "uploadSubmittedTag",
    "uploadSubmittedHint",
    "uploadSignAs",
  ]) {
    assert.equal((i18n.match(new RegExp(`"${key}"`, "g")) ?? []).length, 9, `${key} 要九套语言`);
  }
});
