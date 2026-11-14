// check-silent-paths.mjs —— 安装器「静默路径」护栏
//
// 为什么要这个脚本（2026-11-14，2.1.7 E-1/E-2 的复盘）：
//   `update.rs` 用 `Start-Process -Wait -PassThru` 跑安装包 `/S`，唯一的判据是
//   `ExitCode -eq 0`。而 NSIS 的 `MessageBox` 在 `/S` 下**照常弹窗并阻塞** ——
//   一旦走到那种分支，进程永远不退出，用户看到的是「更新装到一半没反应」。
//   同类问题还有：`Abort` / `Quit` 的退出码依赖模板默认值（裸 Abort 实测退 2，
//   但那是未文档化的实现细节），哪天默认值变了就变成「报成功但没装好」。
//
// 判据分两档：
//   [FAIL] 在「/S 会执行的区段」（Section*、.onInit、.onInstSuccess/Failed、
//          un.onInit、un.onUninstSuccess/Failed）里出现 MessageBox，且**不在**
//          `${If} ${Silent}` 的 `${Else}` 分支 → 静默安装必挂死。
//   [WARN] 同区段里的 Abort / Quit 前 5 行没有 SetErrorLevel → 退出码不可控。
//          以及页面回调（Function）里的 MessageBox —— /S 下页面回调不执行，
//          只影响 GUI 路径，属于"将来重构可能变活"的防御性代码。
//
// 用法：
//   node tools/check-silent-paths.mjs [installer.nsi] [--strict]
//   --strict 把 WARN 也当失败（发版前建议加）
//
// 豁免：在需要豁免的那一行末尾写 `; check-silent-paths:ignore <理由>`。
//
// 已知局限（写清楚，别当它是形式化验证）：
//   ① 只做行级状态机，不展开 `!include` 与 `!insertmacro`；
//   ② `${ElseIf}` 一律按"可能执行"处理（宁可误报，不可漏报）；
//   ③ 自定义页面函数名不可推断，非白名单 Function 里的 MessageBox 只报 WARN。

import fs from 'node:fs';

const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const filePath =
  argv.find((a) => !a.startsWith('--')) || 'src-tauri/windows/installer.nsi';

if (!fs.existsSync(filePath)) {
  console.error(`找不到文件：${filePath}`);
  process.exit(2);
}

const SILENT_RUNNABLE_FUNCS = new Set([
  '.onInit',
  '.onInstSuccess',
  '.onInstFailed',
  'un.onInit',
  'un.onUninstSuccess',
  'un.onUninstFailed',
]);

const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

/** 当前所在的区段：Section 一律算 /S 执行；Function 看白名单 */
let scope = { kind: 'top', name: '(顶层)', silentRunnable: false };
/** 条件块栈（**所有** `${If}` 都入栈，否则 `${EndIf}` 会把 silent 帧弹歪）：
 *  { silent: boolean, elseBranch: boolean }  —— silent 只对 `${If} ${Silent}` 为真 */
const ifStack = [];
/** 预处理条件嵌套（!if / !ifdef / !else / !endif），只用来标注，不参与判定 */
let preprocDepth = 0;

const fails = [];
const warns = [];
let messageBoxCount = 0;
let exitCount = 0;

const IGNORE_RE = /check-silent-paths:ignore\b\s*(.*)$/;
const ignored = (line) => IGNORE_RE.test(line);
const ignoreReason = (line) => {
  const m = line.match(IGNORE_RE);
  return m && m[1] ? m[1].trim() : '(未写理由)';
};

/** 从栈顶往下找最近的 silent 帧：它在 else 分支 = 当前处于"非静默"代码里 */
const inSilentElse = () => {
  for (let k = ifStack.length - 1; k >= 0; k--) {
    if (ifStack[k].silent) return ifStack[k].elseBranch;
  }
  return false;
};
const where = (i) =>
  `行 ${i + 1}（${scope.kind === 'section' ? 'Section' : scope.kind === 'function' ? 'Function' : '顶层'} ${scope.name}）`;

for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  const line = raw.trim();
  const code = line.replace(/;.*$/, '').trim(); // 去掉行尾注释后再判语法
  if (!code) continue;

  // ── 预处理 ───────────────────────────────────────────────────────────
  if (/^!if(n?def)?\b/i.test(code)) preprocDepth++;
  else if (/^!else\b/i.test(code)) {
    /* 同一层，不改变深度 */
  } else if (/^!endif\b/i.test(code)) preprocDepth = Math.max(0, preprocDepth - 1);

  // ── 区段进出 ─────────────────────────────────────────────────────────
  const sec = code.match(/^Section(?:End)?\b(.*)$/i);
  if (/^SectionEnd\b/i.test(code)) {
    scope = { kind: 'top', name: '(顶层)', silentRunnable: false };
  } else if (sec && !/^SectionEnd\b/i.test(code)) {
    const label = sec[1].replace(/^\/o\s+/i, '').replace(/^"|"$/g, '').trim();
    scope = {
      kind: 'section',
      name: label || '(未命名)',
      silentRunnable: true,
    };
  }

  const fn = code.match(/^Function\s+(\S+)/i);
  if (fn) {
    const name = fn[1];
    scope = {
      kind: 'function',
      name,
      silentRunnable: SILENT_RUNNABLE_FUNCS.has(name),
    };
  }
  if (/^FunctionEnd\b/i.test(code)) {
    scope = { kind: 'top', name: '(顶层)', silentRunnable: false };
  }

  // ── 条件块跟踪（所有 ${If} 都入栈，只有 ${If} ${Silent} 打 silent 标记）────
  if (/\$\{IfNot\}\s*\$\{Silent\}/.test(code)) {
    // IfNot Silent 的 then 分支 = 非静默，等价于 Silent 的 else
    ifStack.push({ silent: true, elseBranch: true });
    continue;
  }
  if (/^\$\{If(n|Not)?\}/.test(code)) {
    ifStack.push({
      silent: /\$\{If\}\s*\$\{Silent\}/.test(code),
      elseBranch: false,
    });
    continue;
  }
  if (/^\$\{ElseIf\}/.test(code)) {
    if (ifStack.length) ifStack[ifStack.length - 1].elseBranch = false;
    continue;
  }
  if (/^\$\{Else\}/.test(code)) {
    if (ifStack.length) ifStack[ifStack.length - 1].elseBranch = true;
    continue;
  }
  if (/^\$\{EndIf\}/.test(code)) {
    ifStack.pop();
    continue;
  }

  // ── 规则 1：MessageBox ───────────────────────────────────────────────
  if (/^MessageBox\b/i.test(code) || /\bMessageBox\s+MB_/i.test(code)) {
    messageBoxCount++;
    if (ignored(line)) {
      warns.push(`[忽略] ${where(i)} MessageBox —— 理由：${ignoreReason(line)}`);
      continue;
    }
    if (inSilentElse()) continue; // 已正确分流到非静默分支
    if (scope.silentRunnable) {
      fails.push(
        `${where(i)} MessageBox 在 /S 会执行的区段内，且不在 \${If} \${Silent} 的 \${Else} 分支\n` +
          `        → 静默安装会弹窗阻塞，update.rs 永久挂死。改法见 docs/修复说明-2.1.7 §E-2`,
      );
    } else if (scope.kind === 'function') {
      warns.push(
        `${where(i)} MessageBox 位于 Function（/S 下页面回调不执行，仅影响 GUI 路径）；` +
          `若将来把这段挪进 Section/.onInit，必须改成 \${If} \${Silent} 分流`,
      );
    } else {
      warns.push(`${where(i)} MessageBox 在顶层 —— 无法判定是否参与 /S，请人工确认`);
    }
  }

  // ── 规则 2：Abort / Quit 的退出码 ────────────────────────────────────
  const exitCall = code.match(/^(Abort|Quit)\b/i);
  if (exitCall && scope.silentRunnable) {
    exitCount++;
    if (ignored(line)) continue;
    const back = lines
      .slice(Math.max(0, i - 5), i)
      .map((l) => l.replace(/;.*$/, ''))
      .some((l) => /SetErrorLevel\b/i.test(l));
    if (!back) {
      const inPreproc = preprocDepth > 0 ? '（位于 !if 预处理块内，当前构建可能不参与编译）' : '';
      warns.push(
        `${where(i)} ${exitCall[1]} 前 5 行没有 SetErrorLevel → 退出码依赖 NSIS 默认值${inPreproc}；` +
          `显式写 0 或 1（成功路径在 .onInstSuccess 里置 0）`,
      );
    }
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────
const rel = filePath.replace(/\\/g, '/');
console.log(`安装器静默路径检查 —— ${rel}`);
console.log(
  `扫描：${lines.length} 行 · MessageBox ${messageBoxCount} 处 · ` +
    `/S 区段内 Abort/Quit ${exitCount} 处 · 预处理嵌套深度残留 ${preprocDepth}`,
);

for (const f of fails) console.log(`\n[FAIL] ${f}`);
for (const w of warns) console.log(`\n[WARN] ${w}`);

const failCount = fails.length;
const warnCount = warns.filter((w) => !w.startsWith('[忽略]')).length;
console.log(
  `\n结果：FAIL ${failCount} · WARN ${warnCount} · ` +
    `${failCount === 0 && (!strict || warnCount === 0) ? 'PASS' : 'FAIL'}`,
);

if (failCount > 0) process.exit(1);
if (strict && warnCount > 0) process.exit(1);
process.exit(0);
