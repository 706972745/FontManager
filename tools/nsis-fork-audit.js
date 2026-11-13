// nsis-fork-audit.js —— NSIS 模板溯源与 UI-only 审计（QA 复用工具）
//
// 入库位置：tools/nsis-fork-audit.js（原在 _tmp/，会随临时目录清理丢失，
// 而设计文档 R-08 要求「Tauri 升级时重新提取上游模板与 fork 做 diff」——
// 这个脚本正是那个动作的执行器）。
//
// 用法:
//   node nsis-fork-audit.js <pristine.nsi> <current.nsi> [cli.node]
//
//   pristine = 声称"零改动 fork"的模板，例如：
//              git show 0b4f117:src-tauri/windows/installer.nsi > pristine.nsi
//   current  = 当前自定义模板（src-tauri/windows/installer.nsi）
//   cli.node = Tauri CLI 内嵌模板所在二进制
//              （默认 node_modules/@tauri-apps/cli-win32-x64-msvc/cli.win32-x64-msvc.node）
//
// 判读口径：
//   [溯源] 未命中必须为 0 —— 这是"可以拿 pristine 当上游基线"的唯一凭据；
//   [审计] 被删除/替换的基线行必须逐条落在 UI 白名单
//          （VERSION / 侧栏图 / 目录页 PRE 回调 / FinishPage 文案 / 欢迎页），
//          出现 Section Install / .onInit / un.ConfirmShow / {{#each}} 相关行即判 FAIL。
// 仓库 package.json 是 "type": "module"，.js 按 ESM 解析，所以用 import 而不是 require
// （写 require 会直接抛 ReferenceError: require is not defined）。
import fs from 'node:fs';

const argv = process.argv.slice(2);
const [pristinePath, currentPath, nodePath] = argv;
if (!pristinePath || !currentPath) {
  console.error('用法: node nsis-fork-audit.js <pristine.nsi> <current.nsi> [cli.node]');
  process.exit(2);
}
const cliNode =
  nodePath ||
  'node_modules/@tauri-apps/cli-win32-x64-msvc/cli.win32-x64-msvc.node';

// ── ① 溯源：pristine 的每一行是否都在 CLI 二进制里 ────────────────────────
// 模板以 handlebars 原文嵌在 .node 里（JS 字符串），所以做子串比对；
// .node 里的双引号会被转义成 \"，两种形态都要试一次。
const bin = fs.readFileSync(cliNode, 'latin1');
const pristineLines = fs.readFileSync(pristinePath, 'utf8').split(/\r?\n/);
const miss = [];
pristineLines.forEach((line, i) => {
  if (!line.trim()) return;
  const escaped = line.replace(/"/g, '\\"');
  if (!bin.includes(line) && !bin.includes(escaped)) miss.push(`${i + 1}: ${line}`);
});
console.log(`[溯源] ${pristinePath}`);
console.log(`       行数=${pristineLines.length}  未命中=${miss.length}`);
if (miss.length) {
  console.log(miss.join('\n'));
  console.log('  ❌ pristine 不是上游原文，不能拿它当基线');
} else {
  console.log('  ✅ 逐字命中 CLI 内嵌模板，可以拿它当上游基线');
}

// ── ② UI-only 审计：剥掉纯注释行后再比，剩下的才是真代码改动 ──────────────
// 注意：必须按**出现次数**比（多重集），不能用 includes ——
// `!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive` 在许可页/完成页还有合法实例，
// 用 includes 会把"删掉一处、别处还留着"误判成"没删"。
const strip = (text) =>
  text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/^[ \t]*;.*$/, '')) // 整行注释置空
    .map((l) => l.replace(/[ \t]+$/, '')) // 行尾空白
    .filter((l) => l !== '');
const count = (lines) => {
  const m = new Map();
  for (const l of lines) m.set(l, (m.get(l) || 0) + 1);
  return m;
};
const baseCount = count(strip(fs.readFileSync(pristinePath, 'utf8')));
const curCount = count(strip(fs.readFileSync(currentPath, 'utf8')));
const removed = [];
const added = [];
for (const [line, n] of baseCount) {
  const k = curCount.get(line) || 0;
  for (let i = 0; i < n - k; i++) removed.push(line);
}
for (const [line, n] of curCount) {
  const k = baseCount.get(line) || 0;
  for (let i = 0; i < n - k; i++) added.push(line);
}
console.log(`\n[审计] ${currentPath}`);
console.log(`       被删除/替换的基线行 ${removed.length} 行：`);
removed.forEach((l) => console.log('  < ' + l));
console.log(`       新增行 ${added.length} 行（含 define/函数体，逐条看归属）`);
added.forEach((l) => console.log('  > ' + l));

// ── ③ 红线判定 ───────────────────────────────────────────────────────────
const REDLINE = [/Section Install/, /^Function \.onInit/, /un\.ConfirmShow/, /\{\{#each/, /\{\{\/each\}\}/];
const redHits = removed.filter((l) => REDLINE.some((re) => re.test(l)));
console.log(`\n[红线] 命中受保护区段 ${redHits.length} 处`);
if (redHits.length) {
  redHits.forEach((l) => console.log('  !!! ' + l));
  console.log('  ❌ FAIL：受保护区段被删/改');
  process.exit(1);
} else {
  console.log('  ✅ Section Install / .onInit / un.ConfirmShow / {{#each}} 全部未动');
}
