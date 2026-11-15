/**
 * 极简 PNG 编解码 —— 只为「README 截图流水线」服务，零依赖（只用 node:zlib）。
 *
 * 为什么需要自己编解码：
 *   1. 主窗口是 `transparent: true`，`Page.captureScreenshot` 交回来的 PNG 在
 *      圆角外侧带 **alpha = 0**。GitHub 的 README 在浅色 / 深色主题下都可能被看，
 *      留透明就会在黑底上露出一圈「缺角」的方块。这里统一把 alpha 拍到纯色底上，
 *      输出的 PNG **完全不含透明通道**（colorType = 2，RGB）。
 *   2. 有的图（如 `libraries.png`）历史上就是「设置面板里那一块」的局部图。
 *      CDP 的 clip 参数在 deviceScaleFactor 下语义容易踩坑（到底乘不乘 dsf 各版本不一），
 *      所以在 Node 侧裁剪：先整屏抓，再按 CSS 像素 × dsf 裁——结果完全可控。
 *
 * 支持范围（够用即止，不做通用库）：
 *   - 位深 8、非隔行、colorType 0（灰度）/ 2（RGB）/ 6（RGBA）；
 *   - 滤波 0~4（含 Paeth）。
 * 遇到不支持的类型直接抛错，不要静默产出错图。
 */
import zlib from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 解出来的图像：RGBA8888，行优先，无 padding。 */
export class Img {
  /**
   * @param {number} width
   * @param {number} height
   * @param {Uint8Array} data RGBA8888，长度 = width * height * 4
   */
  constructor(width, height, data) {
    this.width = width;
    this.height = height;
    this.data = data;
  }
}

/**
 * 解码 PNG。
 * @param {Buffer|Uint8Array} buf
 * @returns {Img}
 */
export function decodePng(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 8 || !b.subarray(0, 8).equals(SIG)) {
    throw new Error("不是 PNG：文件头签名不匹配");
  }
  let off = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString("latin1", off + 4, off + 8);
    const body = b.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === "IHDR") {
      ihdr = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        compression: body[10],
        filter: body[11],
        interlace: body[12],
      };
    } else if (type === "PLTE") {
      palette = Buffer.from(body);
    } else if (type === "tRNS") {
      trns = Buffer.from(body);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
  }
  if (!ihdr) throw new Error("PNG 缺少 IHDR");
  const { width, height, bitDepth, colorType, interlace } = ihdr;
  if (bitDepth !== 8) throw new Error(`暂不支持 bitDepth=${bitDepth} 的 PNG`);
  if (interlace !== 0) throw new Error("暂不支持隔行（interlace=1）PNG");
  if (colorType !== 0 && colorType !== 2 && colorType !== 6) {
    throw new Error(`暂不支持 colorType=${colorType} 的 PNG（只支持 0/2/6）`);
  }
  if (idat.length === 0) throw new Error("PNG 缺少 IDAT");

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : 4;
  const stride = width * channels;
  const expect = (stride + 1) * height;
  if (raw.length < expect) {
    throw new Error(`PNG 数据长度不足：${raw.length} < ${expect}`);
  }

  const px = new Uint8Array(stride * height);
  const bpp = channels;
  let prev = new Uint8Array(stride); // 第一行的「上一行」全是 0
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = px.subarray(y * stride, (y + 1) * stride);
    switch (filter) {
      case 0:
        out.set(line);
        break;
      case 1: // Sub
        for (let i = 0; i < stride; i++) {
          out[i] = (line[i] + (i >= bpp ? out[i - bpp] : 0)) & 0xff;
        }
        break;
      case 2: // Up
        for (let i = 0; i < stride; i++) out[i] = (line[i] + prev[i]) & 0xff;
        break;
      case 3: // Average
        for (let i = 0; i < stride; i++) {
          const left = i >= bpp ? out[i - bpp] : 0;
          out[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
        }
        break;
      case 4: // Paeth
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? out[i - bpp] : 0;
          const bb = prev[i];
          const c = i >= bpp ? prev[i - bpp] : 0;
          out[i] = (line[i] + paeth(a, bb, c)) & 0xff;
        }
        break;
      default:
        throw new Error(`未知的 PNG 滤波类型 ${filter}（第 ${y} 行）`);
    }
    prev = out;
  }

  // 统一成 RGBA
  const rgba = new Uint8Array(width * height * 4);
  if (colorType === 6) {
    rgba.set(px);
  } else if (colorType === 2) {
    for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
      rgba[j] = px[i];
      rgba[j + 1] = px[i + 1];
      rgba[j + 2] = px[i + 2];
      rgba[j + 3] = 255;
    }
  } else {
    const transparent = trns && trns.length >= 2 ? trns.readUInt16BE(0) : -1;
    for (let i = 0, j = 0; i < px.length; i++, j += 4) {
      rgba[j] = px[i];
      rgba[j + 1] = px[i];
      rgba[j + 2] = px[i];
      rgba[j + 3] = px[i] === transparent ? 0 : 255;
    }
  }
  return new Img(width, height, rgba);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 把 alpha 拍到纯色底上（源图 alpha 已按覆盖关系混合）。
 * @param {Img} img
 * @param {[number, number, number]} bg 底色 RGB
 * @returns {Img} 新的、alpha 全为 255 的图
 */
export function flatten(img, bg = [255, 255, 255]) {
  const out = new Uint8Array(img.data.length);
  const [br, bgc, bb] = bg;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 255) {
      out[i] = d[i];
      out[i + 1] = d[i + 1];
      out[i + 2] = d[i + 2];
    } else if (a === 0) {
      out[i] = br;
      out[i + 1] = bgc;
      out[i + 2] = bb;
    } else {
      const k = a / 255;
      out[i] = Math.round(d[i] * k + br * (1 - k));
      out[i + 1] = Math.round(d[i + 1] * k + bgc * (1 - k));
      out[i + 2] = Math.round(d[i + 2] * k + bb * (1 - k));
    }
    out[i + 3] = 255;
  }
  return new Img(img.width, img.height, out);
}

/**
 * 裁剪（坐标已换算成像素）。越界自动夹到图内，允许裁出 0 面积以外的空图会抛错。
 * @param {Img} img
 * @param {{x:number,y:number,width:number,height:number}} rect
 */
export function crop(img, rect) {
  const x = clampInt(Math.round(rect.x), 0, img.width);
  const y = clampInt(Math.round(rect.y), 0, img.height);
  const w = clampInt(Math.round(rect.width), 1, img.width - x);
  const h = clampInt(Math.round(rect.height), 1, img.height - y);
  if (w <= 0 || h <= 0) throw new Error("裁剪区域为空");
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const src = ((y + row) * img.width + x) * 4;
    out.set(img.data.subarray(src, src + w * 4), row * w * 4);
  }
  return new Img(w, h, out);
}

function clampInt(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 编码成 PNG。默认输出 RGB（colorType 2），**不带透明通道**。
 * @param {Img} img
 * @param {{colorType?: 2|6, level?: number}} [opts]
 * @returns {Buffer}
 */
export function encodePng(img, opts = {}) {
  const colorType = opts.colorType ?? 2;
  const level = opts.level ?? 9;
  const channels = colorType === 6 ? 4 : 3;
  const stride = img.width * channels;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    const dst = y * (stride + 1) + 1;
    if (channels === 4) {
      raw.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), dst);
    } else {
      for (let x = 0; x < img.width; x++) {
        const s = (y * img.width + x) * 4;
        const d = dst + x * 3;
        raw[d] = img.data[s];
        raw[d + 1] = img.data[s + 1];
        raw[d + 2] = img.data[s + 2];
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * CRC32：Node 22.15+ 的 zlib.crc32 有就用，没有就自己算（两条路径结果一致）。
 * @param {Buffer} buf
 * @returns {number} 无符号 32 位
 */
const crc32 =
  typeof zlib.crc32 === "function"
    ? (buf) => zlib.crc32(buf) >>> 0
    : (buf) => crc32Table(buf);

/** zlib.crc32 在 Node 22 里可能还没导出，自己算一份兜底 */
let crcTable = null;
function crc32Table(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 采样统计：用来兜住「抓了一张全透明的空图」这类静默失败。
 * 只抽样（每 ~997 字节取一个像素），够判断「是不是一片纯色」。
 * @param {Img} img
 */
export function imageStats(img) {
  const step = 4 * 997;
  const seen = new Set();
  let n = 0;
  let sum = 0;
  for (let i = 0; i < img.data.length; i += step) {
    n++;
    const r = img.data[i];
    const g = img.data[i + 1];
    const b = img.data[i + 2];
    sum += (r + g + b) / 3;
    if (seen.size < 64) seen.add((r << 16) | (g << 8) | b);
  }
  return { samples: n, distinct: seen.size, meanLuma: n ? sum / n : 0 };
}

/**
 * 自检：编码 → 解码 → 逐像素比对，并确认输出不带 alpha。
 * 供 `node tools/shoot-readme.mjs --dry-run` 调用（不启动应用也能验证 PNG 链路）。
 */
export function selfTest() {
  const w = 37;
  const h = 21;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = (x * 7) & 0xff;
      data[i + 1] = (y * 11) & 0xff;
      data[i + 2] = (x * y * 3) & 0xff;
      // 特意留一圈透明，验证 flatten
      data[i + 3] = x < 2 || y < 2 ? 0 : 255;
    }
  }
  const src = new Img(w, h, data);
  const flat = flatten(src, [255, 255, 255]);
  for (let i = 3; i < flat.data.length; i += 4) {
    if (flat.data[i] !== 255) throw new Error("flatten 后仍存在半透明像素");
  }
  if (flat.data[0] !== 255 || flat.data[1] !== 255 || flat.data[2] !== 255) {
    throw new Error("flatten 没有把透明像素填成底色");
  }
  const buf = encodePng(flat);
  const back = decodePng(buf);
  if (back.width !== w || back.height !== h) throw new Error("PNG 尺寸往返不一致");
  for (let i = 0; i < flat.data.length; i += 4) {
    if (
      back.data[i] !== flat.data[i] ||
      back.data[i + 1] !== flat.data[i + 1] ||
      back.data[i + 2] !== flat.data[i + 2]
    ) {
      throw new Error(`PNG 往返像素不一致 @${i / 4}: ${back.data[i]},${back.data[i + 1]},${back.data[i + 2]}`);
    }
  }
  const cut = crop(back, { x: 5, y: 3, width: 10, height: 8 });
  if (cut.width !== 10 || cut.height !== 8) throw new Error("crop 尺寸不对");
  const cutBuf = decodePng(encodePng(cut));
  const si = (3 * w + 5) * 4;
  if (cutBuf.data[0] !== flat.data[si] || cutBuf.data[1] !== flat.data[si + 1]) {
    throw new Error("crop 起点像素不对");
  }
  return { bytes: buf.length, width: w, height: h };
}
