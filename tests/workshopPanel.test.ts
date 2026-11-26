import { test } from "node:test";
import assert from "node:assert/strict";
import {
  installRequestFor,
  BadRegistryDirError,
  PanelError,
  PanelSessionExpired,
  sessionKey,
} from "../src/workshop/api.ts";
import { isPanelLocale, panelT, pluralCategory } from "../src/workshop/i18n.ts";
import type { WorkshopEntry } from "../src/lib/workshop.ts";

/**
 * 插件中心面板的 i18n 与安装请求拼装（面板是独立入口，但这些纯逻辑照样要能测）。
 */

function entry(over: Partial<WorkshopEntry> = {}): WorkshopEntry {
  return {
    id: "FM-FONT-RENAME",
    name: "批量重命名",
    brief: "按规则批量重命名字体族",
    detail: "详细说明全文",
    author: "alice",
    official: false,
    version: "1.2.0",
    runtime: null,
    minAppVersion: null,
    lang: "zh-CN",
    download: null,
    size: 2048,
    dir: "FM-FONT-RENAME__alice",
    files: [{ path: "main.py", sha256: "aa", url: "https://x/main.py", size: 64 }],
    permissions: ["fonts:read"],
    ...over,
  };
}

test("panelT 走复数规则：英文 one / other", () => {
  assert.equal(panelT("en", "count", { count: 1 }), "1 plugin");
  assert.equal(panelT("en", "count", { count: 5 }), "5 plugins");
});

test("panelT 俄语按 few / many 分档", () => {
  assert.equal(panelT("ru", "count", { count: 1 }), "1 плагин");
  assert.equal(panelT("ru", "count", { count: 3 }), "3 плагина");
  assert.equal(panelT("ru", "count", { count: 7 }), "7 плагинов");
});

test("panelT 中文只有 other 一档", () => {
  assert.equal(panelT("zh-CN", "count", { count: 1 }), "1 个插件");
  assert.equal(panelT("zh-CN", "count", { count: 9 }), "9 个插件");
});

test("panelT 缺失词条回落到英文，再回落到 key", () => {
  assert.equal(panelT("de", "filter.all"), "Alle");
  assert.equal(panelT("de", "no.such.key"), "no.such.key");
});

test("panelT 插值", () => {
  assert.equal(
    panelT("en", "installedToast", { name: "Demo", version: "1.0.0" }),
    "Installed Demo 1.0.0",
  );
});

test("pluralCategory 与语言规则一致", () => {
  assert.equal(pluralCategory("en", 1), "one");
  assert.equal(pluralCategory("en", 2), "other");
  assert.equal(pluralCategory("ru", 2), "few");
  assert.equal(pluralCategory("ja", 5), "other");
});

test("isPanelLocale 只认主程序下发的 9 种语言", () => {
  assert.equal(isPanelLocale("zh-CN"), true);
  assert.equal(isPanelLocale("pt-BR"), true);
  assert.equal(isPanelLocale("zh_CN"), false);
  assert.equal(isPanelLocale(null), false);
});

test("installRequestFor：官方件给 zip 直链，社区件给逐文件清单", () => {
  const official = installRequestFor(
    entry({ official: true, download: "https://github.com/x/y.zip" }),
  );
  assert.equal(official.kind, "official");
  assert.equal(official.url, "https://github.com/x/y.zip");

  const community = installRequestFor(entry());
  assert.equal(community.kind, "community");
  assert.equal(community.dir, "FM-FONT-RENAME__alice");
  assert.equal(community.files?.length, 1);
  assert.equal(community.files?.[0].path, "main.py");
});

test("installRequestFor：没有 dir 时按 <id>__<author> 拼", () => {
  const req = installRequestFor(entry({ dir: null, author: "" }));
  assert.equal(req.dir, "FM-FONT-RENAME__anonymous");
});

test("installRequestFor：清单的 dir 字段不合法时明确失败（不兜底、不静默跳过）", () => {
  // 穿越输入 → 抛独立错误类型，界面据此给本地化的「目录字段不合法」
  assert.throws(
    () => installRequestFor(entry({ dir: "plugins/../evil" })),
    BadRegistryDirError,
  );
  // 末段为空 → 同样拒
  assert.throws(() => installRequestFor(entry({ dir: "plugins/" })), BadRegistryDirError);
  // 盘符 → 同样拒
  assert.throws(() => installRequestFor(entry({ dir: "C:/evil" })), BadRegistryDirError);
  // 正常值不受影响
  assert.equal(installRequestFor(entry({ dir: "plugins/FM-FONT-RENAME__alice" })).dir, "FM-FONT-RENAME__alice");
});

test("sessionKey 在没有查询参数时返回空串（不抛）", () => {
  assert.equal(typeof sessionKey(), "string");
});

test("会话失效是独立错误类型：界面认它就能给本地化文案", () => {
  const err = new PanelSessionExpired();
  assert.ok(err instanceof Error);
  assert.ok(err instanceof PanelSessionExpired);
  // 其它错误不能被误判成会话失效
  assert.equal(new PanelError(400, "sha256 校验失败") instanceof PanelSessionExpired, false);
});

test("PanelError 带 HTTP 状态码与服务端原文", () => {
  const err = new PanelError(400, "sha256 校验失败");
  assert.equal(err.status, 400);
  assert.equal(err.message, "sha256 校验失败");
});

test("九种语言都有 sessionExpired 词条（会话失效要能本地化）", () => {
  for (const locale of ["en", "de", "es", "fr", "ja", "pt-BR", "ru", "zh-CN", "zh-TW"] as const) {
    const text = panelT(locale, "sessionExpired");
    assert.notEqual(text, "sessionExpired", `${locale} 缺 sessionExpired`);
    assert.ok(text.length > 0);
  }
});

test("九种语言都有 filter.* 三个筛选词条", () => {
  for (const locale of ["en", "de", "es", "fr", "ja", "pt-BR", "ru", "zh-CN", "zh-TW"] as const) {
    for (const key of ["filter.all", "filter.official", "filter.community"]) {
      assert.notEqual(panelT(locale, key), key, `${locale} 缺 ${key}`);
    }
  }
});
