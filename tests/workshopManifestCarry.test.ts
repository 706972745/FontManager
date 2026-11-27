import test from "node:test";
import assert from "node:assert/strict";
import {
  buildManifest,
  runtimeManifestFields,
  type PickedFile,
  type PluginForm,
} from "../src/workshop/upload.ts";

/**
 * 上传后生成的 registry `plugin.json` 必须**同时**是「市场清单」和「运行时清单」。
 *
 * 背景（2026-11-27 实测）：从插件中心装的社区件，`menus` / `settings` / `hooks` /
 * `requirements` 全丢 —— 因为 registry 那份 plugin.json 是面板重新生成的，以前只写市场字段。
 * 用户装完看到「没有右键菜单、没有齿轮」，会以为是插件坏了（官方件走 release zip 安装，
 * 不受影响，所以这个坑只在社区件上暴露）。
 *
 * 现在口径：市场字段以弹窗表单为准（作者能改简介 / 名字），运行字段以 zip 里的原清单为准。
 */

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

const form = (patch: Partial<PluginForm> = {}): PluginForm => ({
  id: "FM-ADOBE-FONT",
  name: "Adobe 套字器（全家桶）",
  entry: "adobe-font.exe",
  version: "0.3.4",
  apiLevel: 1,
  permissions: ["read:fonts", "write:apply", "read:apps"],
  brief: "一句话简介",
  detail: "详情",
  runtime: null,
  lang: "zh-CN",
  minAppVersion: "",
  ...patch,
});

const withManifest = (manifest: unknown): PickedFile[] => [
  { path: "plugin.json", size: 0, bytes: enc(manifest) },
  { path: "adobe-font.exe", size: 16, bytes: new Uint8Array(16) },
  { path: "README.md", size: 4, bytes: enc("说明") },
];

const fullManifest = {
  id: "FM-ADOBE-FONT",
  name: "原件里的名字",
  version: "0.0.1",
  entry: "adobe-font.exe",
  interpreter: "",
  apiLevel: 1,
  permissions: ["read:fonts"],
  hooks: ["init", "context-menu", "settings"],
  menus: [
    { title: "自动：应用到最近使用的设计软件", on: "family" },
    { title: "双击行为…", on: "plugin" },
    { title: "没写 on 的项" },
  ],
  settings: { title: "Adobe 套字器 · 设置", hook: "settings" },
  summary: "卡片小字",
  description: "完整介绍",
  requirements: {
    runtime: "无（自带 exe）",
    libraries: [],
    system: ["Windows PowerShell 5.1"],
    platforms: ["Windows"],
    note: "靠注册表定位",
  },
};

test("zip 原清单里的运行字段全部搬到 registry 清单里", () => {
  const m = buildManifest(form(), "706972745", withManifest(fullManifest)) as Record<string, any>;
  assert.deepEqual(m.hooks, ["init", "context-menu", "settings"]);
  assert.deepEqual(
    m.menus.map((x: { title: string; on: string }) => x.on),
    ["family", "plugin", "family"], // 没写 on 的项按主程序口径补成 family
  );
  assert.deepEqual(m.settings, { title: "Adobe 套字器 · 设置", hook: "settings" });
  assert.equal(m.requirements.runtime, "无（自带 exe）");
  assert.equal(m.requirements.note, "靠注册表定位");
  assert.deepEqual(m.requirements.platforms, ["Windows"]);
  assert.equal(m.summary, "卡片小字");
  assert.equal(m.description, "完整介绍");
});

test("市场字段以表单为准，运行字段不会把名字 / 版本顶回去", () => {
  const m = buildManifest(form(), "706972745", withManifest(fullManifest)) as Record<string, any>;
  assert.equal(m.name, "Adobe 套字器（全家桶）");
  assert.equal(m.version, "0.3.4");
  assert.equal(m.brief, "一句话简介");
  assert.equal(m.detail, "详情");
  assert.equal(m.author, "706972745");
  assert.equal(m.official, false);
  // 文件清单自动补上 plugin.json 自身
  assert.deepEqual(
    m.files.map((f: { path: string }) => f.path),
    ["README.md", "adobe-font.exe", "plugin.json"],
  );
});

test("解释器与自带运行时路径也一起带上（python / node 插件靠它们启动）", () => {
  const m = buildManifest(
    form({ entry: "main.py", version: "1.0.0" }),
    "alice",
    [
      { path: "plugin.json", size: 0, bytes: enc({ interpreter: "python", interpreterPath: "runtime/python.exe" }) },
      { path: "main.py", size: 8, bytes: new Uint8Array(8) },
    ],
  ) as Record<string, any>;
  assert.equal(m.interpreter, "python");
  assert.equal(m.interpreterPath, "runtime/python.exe");
});

test("菜单里的脏数据只丢那一条，不影响整份清单", () => {
  const m = buildManifest(
    form(),
    "alice",
    withManifest({
      menus: [
        { title: "好的", on: "family" },
        { title: "", on: "family" }, // 空标题
        { title: "挂点写错", on: "toolbar" }, // 非法 on
        { on: "plugin" }, // 没标题
        "字符串不是对象",
        null,
      ],
    }),
  ) as Record<string, any>;
  assert.deepEqual(m.menus, [{ title: "好的", on: "family" }]);
});

test("原清单坏了 / 没有清单文件：不抛错，市场字段照常生成", () => {
  const broken: PickedFile[] = [
    { path: "plugin.json", size: 0, bytes: enc("{ 这不是 JSON") },
    { path: "main.js", size: 4, bytes: new Uint8Array(4) },
  ];
  assert.deepEqual(runtimeManifestFields(broken), {});
  const m = buildManifest(form({ entry: "main.js", runtime: "node" }), "alice", broken) as Record<string, any>;
  assert.equal(m.id, "FM-ADOBE-FONT");
  assert.equal(m.entry, "main.js");

  const noManifest: PickedFile[] = [{ path: "main.js", size: 4, bytes: new Uint8Array(4) }];
  assert.deepEqual(runtimeManifestFields(noManifest), {});
});

test("settings 只写了 hook 也能补出标题，hook 缺省是 settings", () => {
  const fields = runtimeManifestFields(
    withManifest({ settings: { title: "", hook: "panel" } }),
  ) as Record<string, any>;
  assert.deepEqual(fields.settings, { title: "设置", hook: "panel" });
});
