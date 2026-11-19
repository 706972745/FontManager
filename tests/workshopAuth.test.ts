import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isTerminalPoll, pollDelayMs } from "../src/workshop/auth.ts";
import { PANEL_LOCALES, panelT } from "../src/workshop/i18n.ts";

/**
 * 插件面板「上传 = 用户登录 GitHub」这条线的回归测试。
 *
 * 2026-11-19 用户口径：**面板不自带令牌，也不收粘贴进来的令牌**，
 * 上传只能来自用户在本机走完一次设备码登录。这里钉三件事：
 *
 * 1. 轮询节奏与终态判断（写错就是「永远转圈」）；
 * 2. 九种语言都有新文案、删掉的文案真的没了（面板没有 check-locales 兜底）；
 * 3. 代码里不再有「匿名代传 / 手动存令牌」那套入口（删干净，别留半条死路）。
 */

// ── ① 轮询节奏 ──────────────────────────────────────────────────────────

test("轮询间隔：秒转毫秒，并夹在 2–60 秒之间", () => {
  assert.equal(pollDelayMs(5), 5000);
  // GitHub 给的 interval 理论上 ≥1；真给了 0/负数也不能变成忙等
  assert.equal(pollDelayMs(0), 2000);
  assert.equal(pollDelayMs(undefined), 5000);
  // 服务端 slow_down 会往上调，但再大也不能让面板看起来像卡死
  assert.equal(pollDelayMs(600), 60000);
});

test("只有 pending / slow_down 不是终态（新状态默认停下来，不会无限转圈）", () => {
  assert.equal(isTerminalPoll("pending"), false);
  assert.equal(isTerminalPoll("slow_down"), false);
  for (const s of ["ok", "expired", "denied", "error", "none"] as const) {
    assert.equal(isTerminalPoll(s), true, `${s} 应该结束本轮登录`);
  }
});

// ── ② 九语文案 ──────────────────────────────────────────────────────────

const REQUIRED = [
  "uploadSignIn",
  "uploadSignOut",
  "uploadSignInHint",
  "uploadDeviceHint",
  "uploadDeviceCopy",
  "uploadDeviceOpen",
  "uploadDeviceWaiting",
  "uploadDeviceCancel",
  "uploadDeviceExpired",
  "uploadDeviceDenied",
  "uploadDeviceFailed",
  "uploadNotConfigured",
];

test("设备码登录的文案九种语言全有（面板不跑 check-locales，这里兜住）", () => {
  for (const loc of PANEL_LOCALES) {
    for (const key of REQUIRED) {
      const text = panelT(loc, key);
      assert.notEqual(text, key, `${loc} 缺文案 ${key}`);
      assert.ok(text.trim().length > 0, `${loc} 的 ${key} 是空串`);
    }
  }
});

test("删掉的匿名/粘令牌文案是真的没了（不是留着回落英文）", () => {
  const gone = [
    "uploadAnon",
    "uploadAnonNote",
    "uploadAnonBadge",
    "uploadAnonNeedAccount",
    "uploadAnonMaintainerOnly",
    "uploadTokenPlaceholder",
    "uploadTokenSave",
    "uploadTokenSteps",
  ];
  for (const loc of PANEL_LOCALES) {
    for (const key of gone) {
      // panelT 找不到 key 时原样回 key —— 这就是「真的没了」的判据
      assert.equal(panelT(loc, key), key, `${loc} 还留着 ${key}`);
    }
  }
});

// ── ③ 代码契约（删干净，别留半条死路）──────────────────────────────────

const read = (p: string) => readFileSync(p, "utf8");
/** 去掉注释再判：注释里提到旧名字是正常的（解释「为什么删掉」） */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("面板不再有任何「匿名代传」或「手动存令牌」的入口", () => {
  const upload = stripComments(read("src/workshop/upload.ts"));
  assert.ok(!/anonymousAuthorFor/.test(upload), "upload.ts 不该再有匿名署名");
  assert.ok(!/MAINTAINER/.test(upload), "upload.ts 不该再有维护者白名单");
  assert.ok(!/TOKEN_NEW_URL|TOKEN_CLASSIC_URL/.test(upload), "不该再引导用户去手动建令牌");

  const api = stripComments(read("src/workshop/api.ts"));
  assert.ok(!/setUploadToken/.test(api), "面板不该能写入令牌（只有设备码登录能）");
  assert.ok(!/clearUploadToken/.test(api), "退出登录走 /api/github/logout");

  const dialog = stripComments(read("src/workshop/UploadDialog.tsx"));
  assert.ok(!/type="password"/.test(dialog), "上传弹窗不该再有令牌输入框");
});

test("主程序侧：/api/upload-token 只能读，不能写", () => {
  const rs = stripComments(read("src-tauri/src/workshop.rs"));
  assert.match(
    rs,
    /\.route\("\/api\/upload-token", get\(api_upload_token\)\)/,
    "上传令牌端点必须是只读的 GET",
  );
  assert.ok(!/api_upload_token_set/.test(rs), "写令牌的端点应该已经删掉");
  assert.match(rs, /\.route\("\/api\/github\/device\/start"/, "缺设备码登录的 start 端点");
  assert.match(rs, /\.route\("\/api\/github\/device\/poll"/, "缺设备码登录的 poll 端点");
});
