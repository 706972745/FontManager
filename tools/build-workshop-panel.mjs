/**
 * 打包「插件中心面板」（插件中心 M1，v3）。
 *
 * 输入：vite 构建产出的 `dist/workshop.html` + 它真正用到的那几个 chunk。
 * 输出：`workshop-panel.zip`（含 workshop.html 与 assets/），另打印 sha256 / 体积 / 内部结构。
 *
 * 为什么只打包「用到的」那几个 chunk：vite 的多入口构建会把公共依赖（react 等）
 * 拆成共享 chunk，主程序与面板都会引用它们。把整个 dist/ 塞进 zip 会把主程序的
 * 产物也带进去 —— 面板就变成了半个主程序，独立更新的意义就没了。
 *
 * 用法：`node tools/build-workshop-panel.mjs`（构建前先跑 `npm run build`）
 * 输出目录可用环境变量覆盖：`WORKSHOP_PANEL_OUT`。
 */
import { createHash } from "crypto";
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "fs";
import { deflateRawSync } from "zlib";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const outDir = process.env.WORKSHOP_PANEL_OUT ?? "E:/Users/87557/文档/wordbuddy/软件迭代/_tmp/workshop-panel-out";
const outZip = join(outDir, "workshop-panel.zip");

/** 收集 workshop.html 引用到的所有 chunk（含它们 import 的共享 chunk） */
function collectAssets() {
  const html = readFileSync(join(dist, "workshop.html"), "utf8");
  const queue = [];
  const seen = new Set();
  const push = (rel) => {
    const clean = rel.replace(/^\//, "").replace(/^\.\//, "");
    if (!clean.startsWith("assets/")) return;
    if (seen.has(clean)) return;
    seen.add(clean);
    queue.push(clean);
  };
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) push(m[1]);
  // 顺着 import 关系把共享 chunk 也带上
  while (queue.length > 0) {
    const cur = queue.shift();
    let text;
    try {
      text = readFileSync(join(dist, cur), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(/["'](?:\.\/|assets\/)([^"']+\.(?:js|css))["']/g)) {
      // chunk 里的相对引用（"./x-xxx.js"）与绝对引用（"assets/x-xxx.js"）
      // 都归一到 dist 下的 assets/ 路径
      push(`assets/${m[1]}`);
    }
  }
  return [...seen].sort();
}

// ── 极简 ZIP 写入器（store + deflate；不引第三方依赖）─────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date（固定值：产物要可复现）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

// ── 主流程 ────────────────────────────────────────────────────────────
if (!statSync(join(dist, "workshop.html"), { throwIfNoEntry: false })) {
  throw new Error("dist/workshop.html 不存在 —— 先跑 `npm run build`");
}
const assets = collectAssets();
const entries = [
  { name: "workshop.html", data: readFileSync(join(dist, "workshop.html")) },
  ...assets.map((rel) => ({ name: rel, data: readFileSync(join(dist, rel)) })),
];
const zip = writeZip(entries);
mkdirSync(outDir, { recursive: true });
writeFileSync(outZip, zip);

const sha = createHash("sha256").update(zip).digest("hex");
console.log(`输出：${outZip}`);
console.log(`体积：${zip.length} 字节`);
console.log(`sha256：${sha}`);
console.log("内部结构：");
for (const e of entries) console.log(`  ${e.name}（${e.data.length} 字节）`);
