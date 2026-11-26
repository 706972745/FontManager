import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 「已经下架了，插件中心还显示它，刷新也没用」（2026-11-25 真机）。
 *
 * 三个独立原因叠在一起，少修一个都会复现：
 *
 * 1. **数据源本身就旧**：下架只是删了目录，`index.json` 要等仓库里的聚合脚本
 *    重算（实测 10 秒到 2 分半）。这中间清单里确实还有它 —— 面板无从知道它没了。
 * 2. **刷新拿不到新清单**：raw.githubusercontent.com 给 `cache-control: max-age=300`，
 *    WebView2 缓存 5 分钟；只加 `cache: "no-cache"` 是协商缓存，命中 ETag 仍返回旧体。
 * 3. **首屏只认 1 分钟 TTL**：点开面板时如果缓存未过期就直接用缓存，根本不去网络。
 *
 * 对策（都在这里钉死）：提交成功就本地藏掉 + 轮询确认；`fresh` 走 `?v=<ts>` + `no-store`；
 * 每次打开都 stale-while-revalidate；「X 分钟前更新」在 1 分钟内显示「刚刚更新」，
 * 让刷新按钮有可见反馈。
 */

const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

test("强制刷新：URL 加时间戳 + 协商缓存（中间代理只认请求头）", () => {
  const api = read("src/workshop/api.ts");
  assert.match(api, /\?v=\$\{Date\.now\(\)\}/, "fresh 要改变 URL，绕过浏览器/CDN 那层 5 分钟缓存");
  // 只看代码，不看注释（注释里正好在解释这两者的区别）
  const code = api
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .join("\n");
  assert.match(code, /cache: "no-cache"/, "要发 Cache-Control: no-cache 给中间代理");
  assert.equal(
    /cache: "no-store"/.test(code),
    false,
    "no-store 不会写请求头，hosts 指向本地加速器时反而拿到旧清单",
  );
  assert.match(api, /fresh\?: boolean/, "调用方要有显式的 fresh 口子");
});

test("打开面板总是回源（缓存只负责首帧不白屏）", () => {
  const app = read("src/workshop/App.tsx");
  assert.match(app, /if \(hit\) void load\(true\)/, "有缓存也要在后台强拉一次");
  assert.equal(
    /Date\.now\(\) - hit\.fetchedAt < CACHE_TTL_MS\) \{/.test(app.split("const hit = cache ?? persistedCache();").pop()!.slice(0, 400)),
    false,
    "首屏 effect 里不能再按 TTL 提前返回",
  );
  assert.match(app, /fetchIndexText\(\{ fresh: force \}\)/, "load(force) 要把 fresh 传给网络层");
});

test("下架成功即本地隐藏，并落盘（重开面板不复现）", () => {
  const app = read("src/workshop/App.tsx");
  // 目录按 id 过滤
  assert.match(app, /entries\.filter\(\(e\) => removed\[e\.id\] === undefined\)/, "中心列表要滤掉已下架条目");
  assert.match(app, /removed\[detailId\] !== undefined/, "详情层也要跟着关掉");
  // 落盘 + TTL
  assert.match(app, /REMOVED_KEY = "fontmanager\.workshop\.removed\.v1"/);
  assert.match(app, /REMOVED_TTL_MS = 30 \* 60_000/, "标记要有过期时间，不能永久藏");
  assert.match(app, /saveRemoved\(next\)/, "markRemoved 必须写盘");
  assert.match(app, /setDetailId\(\(cur\) => \(cur === id \? null : cur\)\)/, "藏掉条目时要顺带关详情");
});

test("确认下架：以目录探测为准，宽限期只放回「其实还在」的", () => {
  const app = read("src/workshop/App.tsx");
  // 探测：404 = 没了
  assert.match(app, /probePluginDir\(dir\)/, "要用目录探测做权威判定");
  assert.match(app, /confirmed\.add\(id\)/, "确认没了的保持隐藏，不再反复探");
  assert.match(app, /window\.setInterval\(\(\) => void probe\(\), 8_000\)/, "8 秒一轮");
  // 清单也继续强拉（聚合跑完后自然消失）
  assert.match(
    app,
    /window\.setInterval\(\(\) => \{\s*if \(alive\) void load\(true\);\s*\}, 20_000\)/,
    "清单每 20 秒强拉一次",
  );
  // 宽限期：只放回目录仍在的
  const tail = app.slice(app.indexOf("const giveUp = window.setTimeout"));
  // 1600 = 从 `const giveUp` 起算够不够看完整段（这段后来又加了「再问一次 API」的二次确认）
  assert.match(tail.slice(0, 1600), /stillThere/, "宽限期要区分「还在」与「已删」");
  assert.match(tail.slice(0, 1600), /180_000/, "最多盯 3 分钟");
  assert.match(tail.slice(0, 1600), /if \(!\(await probePluginDir\(dir\)\)\) stillThere\.push\(id\)/, "200 = 还在 → 放回来");

  // 探测实现：不能只看 index.json
  const api = read("src/workshop/api.ts");
  assert.match(api, /plugins\/\$\{dir\}\/plugin\.json\?probe=/, "探目录要打具体文件，随机查询串防缓存");
  assert.match(api, /res\.status === 404\) return true/, "404 才算真的没了");
});

test("上传弹窗：两条成功路径都要回调 onRemoved，待生效优先看父组件的 removedIds", () => {
  const dlg = read("src/workshop/UploadDialog.tsx");
  const fn = dlg.slice(dlg.indexOf("const removeOne"), dlg.indexOf("const author"));
  assert.equal((fn.match(/onRemoved\(id\)/g) ?? []).length, 2, "直推与 issue 两条路都要立刻隐藏");
  assert.match(fn, /\[isMaintainer, login, onRemoved, t, token\]/, "onRemoved 要进依赖数组");
  assert.match(dlg, /deleted\.includes\(dir\) \|\| removedIds\.includes\(e\.id\)/, "父组件已确认的也算待生效");
  assert.match(dlg, /void removeOne\(target\.id, target\.dir, target\.name, target\.allowAny\)/, "确认弹窗要把 id 传下去");
});

test("文案：待生效标签与「刚刚更新」九套语言齐全", () => {
  const i18n = read("src/workshop/i18n.ts");
  assert.equal((i18n.match(/"uploadDeletePendingTag"/g) ?? []).length, 9);
  assert.equal((i18n.match(/"updatedJustNow"/g) ?? []).length, 9);
  // 45 秒内说「刚刚」，否则「1 分钟前更新」会让刷新看起来毫无作用
  const app = read("src/workshop/App.tsx");
  assert.match(app, /if \(secs < 45\) return panelT\(locale, "updatedJustNow"\)/);
});
