// 面板 i18n 自检：确认面板用到的每个 t("key") 在 9 份字典里都有。
// 用法：node tools/check-panel-i18n.mjs
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const workshopDir = path.join(root, "src/workshop");
const i18nPath = path.join(workshopDir, "i18n.ts");

// 扫**整个 src/workshop 的 .tsx**，不是只扫 App.tsx ——
// 弹窗、导出组件拆成独立文件之后，只扫一个文件会把它们的键误判成「死键」。
const appSrc = fs
  .readdirSync(workshopDir)
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => fs.readFileSync(path.join(workshopDir, f), "utf8"))
  .join("\n");
const i18nSrc = fs.readFileSync(i18nPath, "utf8");

// 1. 收集用到的键
const used = new Set();
for (const m of appSrc.matchAll(/\bt\(\s*"([A-Za-z0-9_.]+)"/g)) used.add(m[1]);
// 模板字面量拼出来的键（如 t(`filter.${k}`)）：先只记前缀，
// 等字典切出来以后再决定要不要补 all/official/community ——
// **不能见到 `xxx.` 就往这三个上补**：`t(`perm.${p}`)` 的前缀是 perm，
// 补出来的 perm.all 根本不存在，检查会误报缺键（2026-11-15 踩过）。
const templatePrefixes = new Set();
for (const m of appSrc.matchAll(/\bt\(\s*`([A-Za-z0-9_]+)\./g)) templatePrefixes.add(m[1]);
// 复数键单独算（count / updatedMinutes / updatedHours / updatedDays）
const PLURAL_KEYS = ["count", "updatedMinutes", "updatedHours", "updatedDays"];

// 2. 按大括号配平切出每份字典
const dicts = {};
const dictRe = /const (\w+): Dict = \{/g;
let dm;
while ((dm = dictRe.exec(i18nSrc)) !== null) {
  const name = dm[1];
  let i = i18nSrc.indexOf("{", dm.index) + 1;
  const start = i;
  let depth = 1;
  while (i < i18nSrc.length && depth > 0) {
    const c = i18nSrc[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  const body = i18nSrc.slice(start, i);
  const keys = new Set();
  for (const km of body.matchAll(/"([A-Za-z0-9_.]+)"\s*:/g)) keys.add(km[1]);
  dicts[name] = keys;
}

const names = Object.keys(dicts);
console.log(`字典份数：${names.length}（${names.join(", ")}）`);

// 模板前缀 → 只补字典里**真的有**的那几个键（filter 这类「状态筛选」用 all/official/community）
for (const prefix of templatePrefixes) {
  for (const key of ["all", "official", "community"]) {
    if (dicts.en?.has(`${prefix}.${key}`)) used.add(`${prefix}.${key}`);
  }
}

let failed = false;
for (const [name, keys] of Object.entries(dicts)) {
  const missing = [];
  for (const key of used) {
    if (PLURAL_KEYS.includes(key)) {
      // 复数键：至少要有 _other，且英语必须有 _one
      if (!keys.has(`${key}_other`)) missing.push(`${key}_other`);
      if (name === "en" && !keys.has(`${key}_one`)) missing.push(`${key}_one`);
    } else if (!keys.has(key)) {
      missing.push(key);
    }
  }
  if (missing.length) {
    failed = true;
    console.log(`  ✗ ${name} 缺：${missing.join(", ")}`);
  }
}

// 3. 反向：字典里有没有谁都没用的键（死键）
//
// 先补三类**拼出来的**键 —— 静态扫描看不见它们：
//   t(`perm.${p}`)         权限说明，键随插件清单的 permissions 变化
//   t(`tour${n}Title`)     导览第 n 步
//   t(i.key)               上传校验的错误文案（键由 upload.ts 的 Issue 决定）
// 按 en 字典里实际存在的键补进 used：漏翻某条仍会在上面的「缺键」检查里暴露，
// 拼错的键则会在下面的死键检查里冒出来。
for (const key of dicts.en) {
  if (key.startsWith("perm.") || key.startsWith("uploadErr") || /^tour\d+(Title|Body)$/.test(key)) {
    used.add(key);
  }
}
const allUsed = new Set(used);
for (const key of PLURAL_KEYS) {
  for (const suffix of ["_one", "_few", "_many", "_other"]) allUsed.add(key + suffix);
}
const enKeys = [...dicts.en].filter((k) => !allUsed.has(k));
if (enKeys.length) {
  console.log(`  ! 英语字典里有没被 App.tsx 用的键（可能是死键）：${enKeys.join(", ")}`);
}

if (failed) {
  console.log("FAIL：面板 i18n 有缺键");
  process.exit(1);
}
console.log(`OK：${used.size} 个键在全部 ${names.length} 份字典里都齐`);
