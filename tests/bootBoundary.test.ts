import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 启动兜底必须真的挂在根上，而且必须做两件事。
 *
 * 事故（2026-11-19，2.4.4）：渲染期一个 TypeError 就把整棵 React 树卸载了，
 * 前端不再调 `splash_done`，用户对着启动页干等，日志里一个字都没有。
 * 兜底页的价值全在「挂上 + 会调 splash_done + 会写日志」这三点，
 * 少一条就又回到「无声消失」。这里扫源码守住，不跑渲染（单测环境没有 DOM）。
 */

const read = (p: string) => readFileSync(p, "utf8");
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

test("main.tsx 把 App 包在 BootErrorBoundary 里", () => {
  const src = code(read("src/main.tsx"));
  assert.match(src, /import \{ BootErrorBoundary/, "main.tsx 没引入兜底组件");
  assert.match(
    src,
    /<BootErrorBoundary>[\s\S]*<App \/>[\s\S]*<\/BootErrorBoundary>/,
    "App 没有被 BootErrorBoundary 包住 —— 渲染异常会再次变成白屏",
  );
});

test("兜底组件必须结束启动页并写日志", () => {
  const src = code(read("src/design/primitives/BootErrorBoundary.tsx"));
  assert.match(src, /static getDerivedStateFromError/, "缺 getDerivedStateFromError：React 不会切到兜底 UI");
  assert.match(src, /componentDidCatch/, "缺 componentDidCatch：异常不会被记录");
  assert.match(src, /ipc\.splashDone\(\)/, "没调 splashDone：主界面没了它启动页会一直等着");
  assert.match(src, /ipc\s*\.logFrontend\(|ipc\.logFrontend\(/, "没写日志：下次再出事仍然无从查起");
});

test("window 级兜底只记日志、不抢启动页", () => {
  const src = code(read("src/main.tsx"));
  const handlers = src.slice(src.indexOf("window.addEventListener(\"error\""));
  assert.ok(handlers.length > 0, "main.tsx 没有 window 级错误监听");
  assert.doesNotMatch(
    handlers.slice(0, handlers.indexOf("ReactDOM.createRoot")),
    /unblockSplash/,
    "window 级监听不该结束启动页：那类错误通常不影响 React 树继续跑",
  );
});
