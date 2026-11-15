#!/usr/bin/env node
/**
 * 拍「插件中心面板」窗口（CDP 点入口 + Win32 PrintWindow 抓窗口）。
 *
 * 背景：`shoot-readme.mjs` 的两个 workshop 场景拿不到面板的 CDP target ——
 * 面板是运行时建的独立 WebviewWindow，不继承 `_tauri.local.json` 的调试参数。
 * 所以这里分工：**主窗口用 CDP 点按钮**（不写死坐标），**面板本体用 PrintWindow**。
 *
 * 用法：
 *   node tools/shoot/shot-panel.mjs --exe <带 9223 的 exe> --out <png> [--upload]
 *   --upload  额外点一次「上传插件」按钮，拍上传弹窗（需要面板已经渲染完）
 *
 * 前置：`src-tauri/_tmp/shoot-target/release/data` 里已装面板（workshop.html +
 * prefs.workshopInstalled=true），否则标题栏入口不渲染。
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { attach, waitForDevtools } from "./cdp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const exe = arg("--exe", path.join(repo, "src-tauri", "_tmp", "shoot-target", "release", "fontmanager.exe"));
const out = arg("--out", path.join(repo, "_tmp", "readme-shots", "workshop.png"));
const wantUpload = process.argv.includes("--upload");
const port = Number(arg("--port", "9223"));

if (!fs.existsSync(exe)) throw new Error(`exe 不存在：${exe}`);
fs.mkdirSync(path.dirname(out), { recursive: true });

const child = spawn(exe, [], {
  cwd: path.dirname(exe),
  stdio: "ignore",
  windowsHide: false,
});
console.log(`已启动 ${exe}（pid ${child.pid}）`);

let cdp;
try {
  await waitForDevtools(port, { timeoutMs: 90000 });
  cdp = await attach({ port, label: "main", timeoutMs: 20000 });
  await cdp.waitFor("#root", { timeoutMs: 30000, what: "主窗口 #root" });
  await delay(2500); // 字体库扫描 + 面板入口判定

  const btn = '[data-hint="side.pluginCenter"]';
  if (!(await cdp.exists(btn))) {
    throw new Error("标题栏没有插件中心入口 —— 隔离数据根里没装面板？");
  }
  await cdp.click(btn, { what: "标题栏插件中心入口" });
  console.log("已点插件中心入口，等面板窗口出现…");
  await delay(3500);

  // 面板没有 CDP：用 Win32 按标题找窗口。上传弹窗用 SendInput 太脆，
  // 这里改成直接给面板窗口发一个回车前的准备（见下方 python 侧的 --upload 说明）。
  const py = path.join(here, "panel_capture.py");
  const r = spawnSync("python", [py, String(child.pid), out], { encoding: "utf8" });
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  if (r.status !== 0) throw new Error(`PrintWindow 抓图失败（exit ${r.status}）`);
  console.log(`✅ ${out}  ${fs.statSync(out).size} B`);

  if (wantUpload) {
    // 上传弹窗：CDP 够不到面板，改用 Win32 键盘事件太不可靠（历史踩坑）。
    // 这里明确报错，让调用方知道这张图要走人工/GUI 自动化，而不是悄悄拍一张错图。
    throw new Error("--upload 暂不支持：面板窗口无 CDP target，键盘事件会打给别的窗口；请人工拍或先给面板窗口单独开调试端口");
  }
} finally {
  try { cdp?.close(); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
  await delay(600);
}
