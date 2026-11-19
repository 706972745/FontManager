import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 提示条的落点契约（2026-11-19，2.5.2）。
 *
 * 事故：`.toaster` 固定 `top: 54px`，2.5.1 把插件提示也接到这个容器之后，
 * 提示条正好压在顶栏右侧那排按钮（视图切换 / 筛选 / 排序）上 —— 提示还在的
 * 几秒里那排按钮点不动，用户截了图问「这是什么情况」。
 *
 * 修法不是把 54 改成 112（顶栏 flex-wrap，换行后一样压住），而是量出来：
 * `TopBar` 把真实底边写进 `--toast-safe-top`，CSS 只消费。这里钉住四个环节，
 * 少一个链条就断，而且断了以后**界面照常渲染**，只有截图上才能看出来。
 */

const read = (p: string) => readFileSync(p, "utf8");

test("完整界面的提示条消费 --toast-safe-top，而不是写死位置", () => {
  const css = read("src/app.css");
  const rule = css.match(/\.toaster-main\s*\{[^}]*\}/);
  assert.ok(rule, "app.css 里没有 .toaster-main 规则：主界面提示条会退回 54px，继续压住顶栏");
  const body = rule[0];
  assert.match(
    body,
    /top:\s*var\(--toast-safe-top,\s*\d+px\)/,
    "必须 top: var(--toast-safe-top, <兜底值>)：变量缺席时也要有安全落点",
  );
  // 兜底值要落在顶栏下面（标题栏 40 + 顶栏单行 64 ≈ 104），54 是被修掉的那个值
  const fallback = Number(body.match(/--toast-safe-top,\s*(\d+)px/)?.[1] ?? 0);
  assert.ok(fallback >= 112, `兜底值 ${fallback}px 太小，会把提示条重新压到顶栏上`);
});

test("只有主界面那份带 toaster-main，速览窗口保持原位", () => {
  const app = read("src/App.tsx");
  assert.match(app, /<Toaster className="toaster-main" \/>/, "主界面的 Toaster 没带类，修复不会生效");
  const bare = app.match(/<Toaster \/>/g) ?? [];
  assert.equal(bare.length, 1, "速览窗口那份应该保持 <Toaster />（不带类），且只有它一份");
});

test("Toaster 支持 className，且类名拼在基础类之后", () => {
  const toast = read("src/design/primitives/Toast.tsx");
  assert.match(toast, /export function Toaster\(\{ className \}/, "Toaster 必须接受 className 参数");
  assert.match(
    toast,
    /className \? `toaster \$\{className\}` : "toaster"/,
    "className 要拼成 `toaster xxx`，不能覆盖掉基础类（基础类带着 gap / pointer-events）",
  );
});

test("TopBar 把 ref 交给 useToasterSafeTop，并挂在真正的那条 header 上", () => {
  const topbar = read("src/components/TopBar.tsx");
  assert.match(topbar, /useToasterSafeTop\(barRef\)/, "TopBar 没调用 useToasterSafeTop，变量永远不会被写入");
  assert.match(topbar, /<motion\.header\s*\n\s*ref=\{barRef\}/, "ref 必须挂在实际渲染的顶栏元素上");
});

test("hook 量真实底边、写变量、并在卸载时清理", () => {
  const hook = read("src/lib/useToasterSafeTop.ts");
  assert.match(hook, /getBoundingClientRect\(\)\.bottom/, "必须量顶栏真实底边（换行后高度会变）");
  assert.match(
    hook,
    /setProperty\("--toast-safe-top"/,
    "没有写入 --toast-safe-top，CSS 那条规则读不到值",
  );
  assert.match(hook, /removeProperty\("--toast-safe-top"\)/, "顶栏卸载后要清掉变量，别留过期高度");
  assert.match(hook, /new ResizeObserver/, "顶栏换行只变高度，没有 ResizeObserver 跟不住");
});
