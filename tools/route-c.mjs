#!/usr/bin/env node
/**
 * 路线 C 构建开关（安装器/卸载器界面由主程序画，规格书 §9.5 / PRD §9.7）。
 *
 * 为什么要有这个脚本：开关就是 installer.nsi 里的一行宏定义 ——
 *
 *     ;!define ZFM_ROUTE_C      ← 关闭（等于 2.1.6 老路径，只用于 A/B 对比体积）
 *     !define ZFM_ROUTE_C       ← 开启（2.1.7 起的发版状态）
 *
 * **2.1.7 起默认开启**：安装器/卸载器界面就是主程序画的那套，不再退回原生页面。
 * 想量"路线 C 到底让包大了多少"时才临时 off 一次，量完记得 on 回来。
 * 早先 < 2.1.7 的约定相反（默认 off + `--assert-off` 护栏），2.1.7 发版时翻过来了。
 *
 * 早先的实现是「旁边放个 zfm-route-c.on 标记文件，用 !if /FileExists 探测」，
 * 但 tauri 打包前会把模板渲染到 `rust-target/release/nsis/x64/installer.nsi`，
 * 那时 `${__FILEDIR__}` 指向临时目录 → 标记文件永远探测不到 → 开关恒为假。
 * 2026-11-14 实测：开与关两次打出来的包字节完全相同（6,583,851 B）。
 *
 * 用法：
 *   node tools/route-c.mjs status     # on / off
 *   node tools/route-c.mjs on
 *   node tools/route-c.mjs off
 *
 * CI 用 `--assert-on` 钉住发版状态（2.1.7 起）：谁误把路线 C 关掉提交，CI 当场红。
 * `--assert-off` 还留着，给将来"要不要退回老路径"的对比分支用。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const NSI = join(here, "..", "src-tauri", "windows", "installer.nsi");

const OFF = ";!define ZFM_ROUTE_C";
const ON = "!define ZFM_ROUTE_C";

const read = () => readFileSync(NSI, "utf8");

/** 只认行首的那一行，避免误伤注释正文里的同名字样 */
function findSwitch(text) {
  const lines = text.split("\n");
  const hits = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t === OFF || t === ON) hits.push({ i, on: t === ON });
  });
  return hits;
}

function main() {
  const cmd = process.argv[2] ?? "status";
  const text = read();
  const hits = findSwitch(text);

  if (hits.length !== 1) {
    console.error(
      `[route-c] installer.nsi 里应恰好有 1 行开关（"${OFF}" 或 "${ON}"），实际 ${hits.length} 行。` +
        `\n  请检查是否被手工改过，或注释正文里出现了行首同名字样。`,
    );
    process.exit(2);
  }

  const cur = hits[0].on ? "on" : "off";

  if (cmd === "status") {
    console.log(cur);
    return;
  }
  if (cmd === "--assert-off" || cmd === "--assert-on") {
    const want = cmd === "--assert-on" ? "on" : "off";
    if (cur !== want) {
      console.error(
        `[route-c] 期望开关为 ${want}，实际是 ${cur}。\n` +
          `  修正：node tools/route-c.mjs ${want}`,
      );
      process.exit(1);
    }
    console.log(cur);
    return;
  }
  if (cmd !== "on" && cmd !== "off") {
    console.error(`[route-c] 未知参数：${cmd}（可用：status / on / off / --assert-on / --assert-off）`);
    process.exit(2);
  }
  if (cur === cmd) {
    console.log(`${cmd}（已经是这个状态，未改动）`);
    return;
  }

  const lines = text.split("\n");
  lines[hits[0].i] = cmd === "on" ? ON : OFF;
  // 保留原文件的换行风格：不额外加 BOM，不统一行尾
  writeFileSync(NSI, lines.join("\n"), "utf8");
  console.log(`${cmd}`);
}

main();
