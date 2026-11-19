import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 面板宿主的**行为契约**（2026-11-19 用户口径）。
 *
 * 背景：插件中心原本是独立原生窗口，且「失焦即藏」。用户提了三条：
 * 1. 取消失焦消失；
 * 2. 点多次只显示一个（已打开就唤出，不重建）；
 * 3. 干脆别开新窗口，直接在软件窗口里按设置面板的尺寸/位置打开；
 * 4. 同一套遮罩层开放给插件做自己的设置界面，一个插件只能有一个。
 *
 * 这四条都是「改一处、别的地方跟着歪」的类型（尺寸写两套、入口各写一份
 * 打开逻辑、单例只在命令层判断……），所以钉成测试：谁把它们拆散了，这里先红。
 *
 * 扫源码而不是渲染组件：这些不变量一半在 TSX、一半在 Rust/CSP 里，
 * 单测跑起来不需要真实 WebView（真机 GUI 自动化在这台多屏机上坐标不可信）。
 */
const read = (p: string) => readFileSync(p, "utf8");

test("插件中心与插件设置界面共用同一个遮罩层，且尺寸完全复用 .settings-panel", () => {
  const src = read("src/components/PanelHost.tsx");
  // 只借壳、不另写尺寸：写死 900/760 就会出现「设置面板改了、插件中心没跟」
  assert.match(src, /className="settings-panel panel-embed"/);
  assert.doesNotMatch(src, /900px|760px/, "尺寸必须来自 .settings-panel，不许在这里写死");
  // 两类面板都在这个文件里渲染 —— 共用一个 state，天然单例
  assert.match(src, /kind: "workshop"/);
  assert.match(src, /kind: "plugin"/);
});

test("单例：同一来源重复请求返回同一个 state（不重建 iframe）", () => {
  const src = read("src/components/PanelHost.tsx");
  // 插件中心：地址没变就原样返回
  assert.match(
    src,
    /if \(cur\?\.kind === "workshop" && cur\.src === src\) return cur;/,
    "插件中心重复点击必须只唤出，不能重新加载 iframe",
  );
  // 插件：同 pid + 同地址原样返回
  assert.match(
    src,
    /if \(cur\?\.kind === "plugin" && cur\.pid === pid && cur\.src === url\) return cur;/,
    "同一插件重复 open-url 必须幂等（一个插件只能有一个设置界面）",
  );
});

test("插件设置界面由宿主转发的事件驱动（插件侧协议不变）", () => {
  const src = read("src/components/PanelHost.tsx");
  assert.match(src, /listen<PluginPanelPayload>\("plugin-panel:open"/);
  // 必须带 pid：单例判定按插件 id，不按窗口标题/地址前缀
  assert.match(src, /cur\.pid === pid/);
  // 内嵌页要能写剪贴板（GitHub 设备码那一步会复制码）
  assert.match(src, /allow="clipboard-write; clipboard-read"/);
});

test("两个入口都只发事件，不再各自开窗口", () => {
  for (const f of ["src/components/Titlebar.tsx", "src/components/SettingsOverlay.tsx"]) {
    const src = read(f);
    assert.match(src, /new CustomEvent\(OPEN_WORKSHOP_EVENT\)/, `${f} 应只 dispatch 事件`);
    assert.doesNotMatch(src, /workshopOpenPanel\s*\(/, `${f} 不该再直接开原生窗口`);
  }
});

test("CSP 放行回环 iframe（漏了这条，内嵌会被静默拦掉）", () => {
  const conf = read("src-tauri/tauri.conf.json");
  assert.match(conf, /frame-src http:\/\/127\.0\.0\.1:\*/);
  assert.match(conf, /frame-src[^;]*http:\/\/localhost:\*/);
});

test("插件中心窗口不再「失焦即藏」，且地址命令已注册", () => {
  const rs = read("src-tauri/src/workshop.rs");
  const fn = rs.slice(
    rs.indexOf("pub fn workshop_open_panel"),
    rs.indexOf("fn panel_theme_str"),
  );
  assert.ok(fn.length > 500, "没找到 workshop_open_panel 函数体");
  assert.match(fn, /\bfalse,\s*\n\s*\);/m, "close_on_blur 必须是 false（点别处不再消失）");
  assert.doesNotMatch(fn, /\btrue,\s*\n\s*\);/m, "这里不该再传 true");
  assert.match(rs, /pub fn workshop_panel_url/);

  const lib = read("src-tauri/src/lib.rs");
  assert.match(lib, /workshop::workshop_panel_url,/);
});
