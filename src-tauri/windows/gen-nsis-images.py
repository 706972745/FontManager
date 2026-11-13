#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 NSIS 安装器用的两张 BMP（纯标准库，不需要 PIL / numpy，也不联网）。

用法（在任意目录下都可以跑，路径都相对本文件解析）：

    python src-tauri/windows/gen-nsis-images.py           # 重新生成两张 BMP
    python src-tauri/windows/gen-nsis-images.py --check   # 只校验已有 BMP 的格式

产物（提交进仓库；**构建时不跑这个脚本**，它只是让图可以重新生成）：

    src-tauri/windows/sidebar.bmp   164×314 24bit  —— 欢迎页/完成页左侧那一列
    src-tauri/windows/header.bmp    150×57  24bit  —— 内页顶部横条（本版不启用，见下）

为什么要自己手写 BMP：
  1. MUI_WELCOMEFINISHPAGE_BITMAP 的**默认值**就是 NSIS 自带的蓝色 win.bmp，
     置空会编译期 !error（Pages/Welcome.nsh:26）—— 「不放图」的结果不是没有图，
     而是「还是那张蓝的」，用户抱怨的正是它。所以必须给一张自己的。
  2. 本机三个 python 环境都没有 PIL/numpy，PowerShell 的 Add-Type(System.Drawing)
     又被安全策略拦着。手写 BMP 是最小可行路径：54 字节文件头 + 逐行 BGR + 4 字节对齐。
  3. 产物必须能重新生成，不能只留二进制 —— 否则以后想微调颜色只能去求人。

为什么图上只有「白底 + 一根细线 + 一个单色图标」，没有字：
  · 图里的文字没法本地化（中文/英文两套图 = 两倍维护）；
  · 欢迎页那张图在 125%/150% DPI 下会被系统按比例缩放，细笔画文字最先糊；
  · 用户原话是「也不必一定非得有图片」，要的是质感不是内容。

图标怎么来的：
  icons/icon.png 是 512×512 RGBA（透明底 + 白色字形）。直接贴到白底上等于看不见，
  所以先算「墨量」（= 1 - 合成到白底后的亮度），做**面积平均**降采样（不是最近邻 ——
  最近邻会让图标边缘出现锯齿和残点），再按墨量把颜色从白过渡到近黑。
"""

import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ICON_PNG = os.path.join(HERE, os.pardir, "icons", "icon.png")
SIDEBAR_BMP = os.path.join(HERE, "sidebar.bmp")
HEADER_BMP = os.path.join(HERE, "header.bmp")

# ── 配色（与主程序同一套黑白灰，别再引入第二种颜色）──────────────────────
WHITE = (255, 255, 255)
INK = (28, 28, 36)        # #1c1c24，主文字色
HAIRLINE = (233, 233, 240)  # #e9e9f0，一根极浅的分隔线


# ══════════════════════════════════════════════════════════════════════
# PNG 解码（只支持本项目实际用到的那一种：8bit RGBA、非隔行）
# ══════════════════════════════════════════════════════════════════════
def read_png_rgba(path):
    """解出 (宽, 高, bytearray RGBA)。支持 PNG 的全部 5 种行过滤器。"""
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path} 不是 PNG")
    pos = 8
    width = height = depth = color_type = interlace = 0
    idat = bytearray()
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        kind = data[pos + 4 : pos + 8]
        chunk = data[pos + 8 : pos + 8 + length]
        if kind == b"IHDR":
            width, height, depth, color_type, _comp, _filt, interlace = struct.unpack(
                ">IIBBBBB", chunk
            )
        elif kind == b"IDAT":
            idat += chunk
        elif kind == b"IEND":
            break
        pos += 12 + length
    if (depth, color_type, interlace) != (8, 6, 0):
        raise SystemExit(
            f"{path}: 只支持 8bit RGBA 非隔行 PNG（实际 depth={depth} "
            f"colortype={color_type} interlace={interlace}）"
        )

    raw = zlib.decompress(bytes(idat))
    bpp = 4
    stride = width * bpp
    out = bytearray()
    prev = bytearray(stride)
    i = 0
    for _y in range(height):
        ftype = raw[i]
        i += 1
        line = bytearray(raw[i : i + stride])
        i += stride
        if ftype == 1:  # Sub
            for x in range(bpp, stride):
                line[x] = (line[x] + line[x - bpp]) & 0xFF
        elif ftype == 2:  # Up
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 0xFF
        elif ftype == 3:  # Average
            for x in range(stride):
                left = line[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + ((left + prev[x]) >> 1)) & 0xFF
        elif ftype == 4:  # Paeth
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                b = prev[x]
                c = prev[x - bpp] if x >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pred) & 0xFF
        elif ftype != 0:
            raise SystemExit(f"{path}: 未知的行过滤器 {ftype}")
        out += line
        prev = line
    return width, height, out


def ink_mask(width, height, rgba):
    """把图标变成「墨量」矩阵（0.0 = 纯白，1.0 = 纯黑）。

    先按 alpha 合成到白底（透明的地方就是白），再取亮度补值 ——
    这样图标里原本是白色的笔画会自然变成「空白」，黑的部分变成墨，
    在白纸上就是一个干净的单色标记，不需要我们猜哪一层是形状。
    """
    mask = [0.0] * (width * height)
    for idx in range(width * height):
        o = idx * 4
        r, g, b, a = rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]
        af = a / 255.0
        r = r * af + 255.0 * (1.0 - af)
        g = g * af + 255.0 * (1.0 - af)
        b = b * af + 255.0 * (1.0 - af)
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        mask[idx] = (255.0 - lum) / 255.0
    return mask


def downscale_mask(mask, width, height, out_w, out_h):
    """面积平均降采样（每个目标像素覆盖的源像素取平均）。

    为什么不用最近邻：图标是细笔画，最近邻会丢像素、边缘出锯齿和残点，
    在 164px 宽的侧栏上非常明显。
    """
    out = [0.0] * (out_w * out_h)
    for ty in range(out_h):
        y0 = int(ty * height / out_h)
        y1 = int((ty + 1) * height / out_h)
        if y1 <= y0:
            y1 = y0 + 1
        if y1 > height:
            y1 = height
        for tx in range(out_w):
            x0 = int(tx * width / out_w)
            x1 = int((tx + 1) * width / out_w)
            if x1 <= x0:
                x1 = x0 + 1
            if x1 > width:
                x1 = width
            total = 0.0
            count = 0
            for y in range(y0, y1):
                row = y * width
                for x in range(x0, x1):
                    total += mask[row + x]
                    count += 1
            out[ty * out_w + tx] = total / count if count else 0.0
    return out


def blend(base, ink, amount):
    """按墨量把 base 往 ink 色上压（amount 已经 clamp 到 0..1）。"""
    amount = 0.0 if amount < 0.0 else (1.0 if amount > 1.0 else amount)
    return (
        int(round(base[0] + (ink[0] - base[0]) * amount)),
        int(round(base[1] + (ink[1] - base[1]) * amount)),
        int(round(base[2] + (ink[2] - base[2]) * amount)),
    )


# ══════════════════════════════════════════════════════════════════════
# 画布
# ══════════════════════════════════════════════════════════════════════
class Canvas:
    """一块 RGB 画布，坐标原点在左上角（写 BMP 时再翻成自下而上）。"""

    def __init__(self, width, height, color=WHITE):
        self.w = width
        self.h = height
        self.px = [color] * (width * height)

    def set(self, x, y, color):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.px[y * self.w + x] = color

    def stamp_mask(self, mask, mw, mh, left, top):
        for y in range(mh):
            for x in range(mw):
                amount = mask[y * mw + x]
                if amount <= 0.0:
                    continue
                self.set(left + x, top + y, blend(WHITE, INK, amount))

    def vline(self, x, color):
        for y in range(self.h):
            self.set(x, y, color)

    def hline(self, y, color):
        for x in range(self.w):
            self.set(x, y, color)


def write_bmp(path, canvas):
    """写 24bit 未压缩 BMP，自下而上、每行 4 字节对齐。

    NSIS 在编译期用 !pragma verifyloadimage 校验图片，32bit / 带压缩 / 尺寸不符
    都会当场报错 —— 这正是我们要的：错在构建期，而不是装机时才看到一张糊图。
    """
    width, height = canvas.w, canvas.h
    row_raw = width * 3
    padding = (4 - row_raw % 4) % 4
    pixel_bytes = (row_raw + padding) * height
    header = struct.pack(
        "<2sIHHI",
        b"BM",
        14 + 40 + pixel_bytes,
        0,
        0,
        14 + 40,
    )
    info = struct.pack(
        "<IiiHHIIiiII",
        40,
        width,
        height,  # 正数 = 自下而上
        1,
        24,
        0,  # BI_RGB，未压缩
        pixel_bytes,
        2835,
        2835,
        0,
        0,
    )
    body = bytearray()
    for y in range(height - 1, -1, -1):
        row = canvas.px[y * width : (y + 1) * width]
        for r, g, b in row:
            body += bytes((b, g, r))  # BMP 是 BGR
        body += b"\x00" * padding
    with open(path, "wb") as f:
        f.write(header + info + bytes(body))


def load_icon_mask(box):
    """读 icon.png 并缩到 box×box 的墨量矩阵。"""
    w, h, rgba = read_png_rgba(ICON_PNG)
    mask = ink_mask(w, h, rgba)
    return downscale_mask(mask, w, h, box, box), box


def build_sidebar():
    """164×314：白底 + 居中单色图标 + 右边缘一根细线。

    尺寸是 MUI 写死的（欢迎页/完成页左侧那一列的宽度就是 164，高度 314），
    给别的尺寸会被 FitControl 拉伸，图标就糊了。
    """
    sidebar_mask, box = load_icon_mask(96)
    canvas = Canvas(164, 314)
    canvas.stamp_mask(sidebar_mask, box, box, (164 - box) // 2, (314 - box) // 2)
    # 细线只画在最右一列：内容是纯白，不画这根线的话侧栏和正文会糊成一片。
    canvas.vline(163, HAIRLINE)
    return canvas


def build_header():
    """150×57：白底 + 左下角小图标 + 底部一根细线（本版未启用，见 ADR-D6 的 P2）。"""
    header_mask, box = load_icon_mask(28)
    canvas = Canvas(150, 57)
    canvas.stamp_mask(header_mask, box, box, 12, (57 - box) // 2)
    canvas.hline(56, HAIRLINE)
    return canvas


# ══════════════════════════════════════════════════════════════════════
# 校验
# ══════════════════════════════════════════════════════════════════════
def verify(path, want_w, want_h):
    """校验：尺寸、位深 24、未压缩、无 alpha 通道、文件大小自洽。"""
    data = open(path, "rb").read()
    if data[:2] != b"BM":
        raise SystemExit(f"{path}: 不是 BMP")
    file_size = struct.unpack("<I", data[2:6])[0]
    (info_size,) = struct.unpack("<I", data[14:18])
    width, height = struct.unpack("<ii", data[18:26])
    planes, depth = struct.unpack("<HH", data[26:30])
    (compression,) = struct.unpack("<I", data[30:34])
    (pixel_bytes,) = struct.unpack("<I", data[34:38])
    row_raw = width * 3
    padding = (4 - row_raw % 4) % 4
    expect_pixels = (row_raw + padding) * height
    checks = [
        ("尺寸", (width, abs(height)), (want_w, want_h)),
        ("位深", depth, 24),
        ("planes", planes, 1),
        ("压缩", compression, 0),
        ("info 头长度", info_size, 40),
        ("像素字节数", pixel_bytes, expect_pixels),
        ("文件总长", file_size, len(data)),
        ("有无 alpha 通道", depth == 32, False),
        ("像素数据完整性", len(data) - (14 + 40), expect_pixels),
    ]
    bad = [(name, got, want) for name, got, want in checks if got != want]
    print(
        f"{os.path.basename(path):12s} {width}x{abs(height)} {depth}bpp "
        f"compression={compression} bytes={len(data)} "
        f"{'OK' if not bad else 'FAIL'}"
    )
    for name, got, want in bad:
        print(f"  ✗ {name}: 实际 {got}，期望 {want}")
    return not bad


def main(argv):
    if "--check" in argv:
        ok = verify(SIDEBAR_BMP, 164, 314) and verify(HEADER_BMP, 150, 57)
        return 0 if ok else 1
    write_bmp(SIDEBAR_BMP, build_sidebar())
    write_bmp(HEADER_BMP, build_header())
    ok = verify(SIDEBAR_BMP, 164, 314) and verify(HEADER_BMP, 150, 57)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
