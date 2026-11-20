"""把设计给的 5 个 Illustrator SVG 渲染成 FontManager 全套图标（PNG + 七帧 ICO）。

职责：一条命令从 `--src` 目录下的 `资源 2、3、4、5、16.svg` 重跑出仓库里所有图标产物 ——
`docs/icons/`（五套母版 + 两张预览）、`src-tauri/icons/`、`src-tauri/assets/`、
`public/`。换设计稿时只重跑本脚本，不要手改产物。

为什么走无头 Edge：这台机器上 PIL / ImageMagick / Inkscape 都装不出**透明底**的
SVG 位图（PIL 根本不解 SVG，其它路径要么丢渐变要么压白底）。Edge 的
`--headless=new --default-background-color=00000000` 是唯一验证过既保留渐变、
又保留 alpha 的路径，所以 SVG → 位图这一段固定交给它。

硬约束（改脚本前先读）：
1. ICO 必须 7 帧 16/24/32/48/64/128/256，每帧 PNG 压缩、32bpp —— 手写 ICO 容器，
   不用 PIL 的 `save(sizes=...)`（那会插 BMP 帧，且帧序不可控），
   `src-tauri/src/file_assoc.rs` 与 `library_marker.rs` 的单测按 7 帧断言。
2. 除应用图标外，四枚裁掉透明边后**长边 = 0.82 × 画布**再居中 —— 这条口径决定
   图标在资源管理器里看起来的大小与旧版一致，别省。
   应用图标自带白色圆角底板，满版直接缩放，不做裁剪。
3. 输出 PNG 一律 RGBA 透明底；应用图标自带的白色底板属于设计，不算白底。
4. 16/24/32 三档额外用 Edge 在目标像素尺寸原生栅格化一版（矢量直接落在小尺寸上，
   比从 1024 master 降采样更锐），与降采样版按拉普拉斯锐度取高者；
   实测三档都是原生版胜出，见 `_pick_small`。判定标准：16px 下字母不糊成一团。

用法：
    python tools/make-icons.py                      # 用默认设计稿目录
    python tools/make-icons.py --src "D:/设计/SVG"   # 换设计稿目录
    python tools/make-icons.py --sheet             # 顺带出 docs/icons 的两张预览图
"""

from __future__ import annotations

import argparse
import io
import shutil
import struct
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

REPO = Path(__file__).resolve().parent.parent
DEFAULT_SRC = Path(r"E:/Users/87557/Desktop/工作快捷目录/SVG")
WORK = REPO / "_tmp" / "icon-render"

# 母版画布：足够大，往下缩任何档位都还有余量（512 档也是从这里降，不是放大）。
MASTER = 1024
# 非满版图标的长边占画布比例。旧版实测「高度 0.801 + 水平居中」，新图比例不同，
# 统一成「长边 0.82」这一条口径，四条边看起来才一样大。
FILL = 0.82
# 判透明边的 alpha 阈值：抗锯齿边缘会留下 alpha 1~5 的碎点，不设阈值 bbox 会略大。
ALPHA_FLOOR = 8
ICO_FRAMES = (16, 24, 32, 48, 64, 128, 256)
# 这三档画小图，原生栅格化与降采样都试，取更锐的
SMALL_TIERS = (16, 24, 32)

EDGE_CANDIDATES = (
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
)


@dataclass
class Design:
    """一枚图标的设计稿 → 产物落位。

    key      `docs/icons/<key>/` 目录名（历史约定，别改：文档里的图片链接按它拼）
    source   源 SVG 文件名（设计给的「资源 N.svg」）
    label    预览图上的中文名
    full_bleed  自带底板、满版不裁剪（只有应用图标是 True）
    """

    key: str
    source: str
    label: str
    full_bleed: bool = False
    pngs: dict[int, list[Path]] = field(default_factory=dict)


DESIGNS: tuple[Design, ...] = (
    # 应用图标：exe / 任务栏 / 安装器 / 关于页。自带白色圆角底板，满版。
    Design(key="main", source="资源 16.svg", label="软件图标", full_bleed=True),
    # 快照导出 .S-FontManager
    Design(key="snapshot", source="资源 3.svg", label="快照导出 .S"),
    # 导出包 · 含字体 .P-FontManager
    Design(key="pack", source="资源 4.svg", label="导出包 .P"),
    # 仅数据 .D-FontManager。目录名叫 library 是历史约定（旧版这枚叫「字体库数据」），
    # 改目录名会让 docs/图标规范.md 与交付板的 <img> 链接全断，所以保持不变。
    Design(key="library", source="资源 5.svg", label="仅数据 .D"),
    # 字体库文件夹标记（资源管理器里库根目录的图标）
    Design(key="folder", source="资源 2.svg", label="字体库文件夹"),
)

BY_KEY = {d.key: d for d in DESIGNS}


def find_edge() -> str:
    for p in EDGE_CANDIDATES:
        if Path(p).is_file():
            return p
    raise SystemExit("找不到 msedge.exe，改 EDGE_CANDIDATES 再跑")


# ─────────────────────────── 渲染 ───────────────────────────


def wrapper_svg(art_name: str, canvas: int, k: float, tx: float, ty: float, css_size: int) -> str:
    """生成一层定位壳：把 `art_name` 这张 SVG 摆到 `canvas` 见方的画布上。

    为什么套壳而不是直接截 SVG：源文件 viewBox 比例各异（240×208.57 的横向、
    190.2×240 的竖向），直接丢进正方形视口会被拉变形。壳里用 <image> 的
    preserveAspectRatio="xMidYMid meet" 保住比例，再用外层 <g> 做归一化变换
    （放大 k 倍、中心平移到画布正中），这样同一份壳既能出 1024 master，
    也能按目标像素尺寸原生栅格化。

    ⚠️ 根 svg 的宽高必须写**具体像素**（= 视口尺寸），不能写 `100%`：独立 SVG 文档
    里根元素的百分比宽度不按视口解析，实测会得到一张被推向右下角、右下被裁掉的图
    （bbox 从 446 开始而不是 0）。这个坑排查过一次，别再改回百分比。
    """
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" '
        'xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'viewBox="0 0 {canvas} {canvas}" width="{css_size}" height="{css_size}">'
        f'<g transform="translate({tx:.4f},{ty:.4f}) scale({k:.6f})">'
        f'<image x="0" y="0" width="{canvas}" height="{canvas}" '
        f'preserveAspectRatio="xMidYMid meet" xlink:href="{art_name}"/>'
        "</g></svg>"
    )


def render(edge: str, svg: Path, out: Path, css_size: int, dsf: int) -> Image.Image:
    """用无头 Edge 把 svg 截成 out（css_size×dsf 见方），返回 RGBA 图。"""
    cmd = [
        edge,
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        f"--force-device-scale-factor={dsf}",
        f"--window-size={css_size},{css_size}",
        "--default-background-color=00000000",
        f"--screenshot={out}",
        svg.resolve().as_uri(),
    ]
    subprocess.run(cmd, check=True, capture_output=True, timeout=240)
    if not out.is_file() or out.stat().st_size == 0:
        raise RuntimeError(f"Edge 没写出 {out}")
    img = Image.open(out)
    want = css_size * dsf
    if img.size != (want, want):
        raise RuntimeError(f"{out.name} 尺寸 {img.size}，期望 {want}×{want}")
    return img.convert("RGBA")


def alpha_bbox(img: Image.Image) -> tuple[int, int, int, int]:
    """按 alpha 通道裁掉透明边。阈值过滤掉抗锯齿留下的微弱像素。"""
    mask = img.split()[3].point(lambda a: 255 if a > ALPHA_FLOOR else 0)
    box = mask.getbbox()
    if box is None:
        raise RuntimeError("整张图都是透明的，SVG 没渲染出来")
    return box


@dataclass
class Norm:
    """归一化参数：最终坐标 x' = k*x + tx（在母版 1024 坐标系里算出来的）。"""

    k: float
    tx: float
    ty: float


NORMS: dict[str, Norm] = {}


def shell_for(design: Design, css_size: int) -> Path:
    """按目标 CSS 尺寸生成定位壳文件（根 svg 宽高 = css_size）。

    每个尺寸一份壳，是因为根 svg 的宽高必须等于视口像素（见 wrapper_svg 里的坑），
    同一份壳没法同时服务 256 与 16 两个视口。
    """
    n = NORMS[design.key]
    shell = WORK / design.key / f"shell{css_size}.svg"
    shell.write_text(
        wrapper_svg("art.svg", MASTER, n.k, n.tx, n.ty, css_size), encoding="utf-8"
    )
    return shell


def build_design(edge: str, design: Design, src: Path) -> Image.Image:
    """渲染一枚图标，返回 1024 的归一化 master（顺带把归一化参数存进 NORMS）。

    两遍：第一遍原样渲染量 alpha bbox，第二遍带归一化变换重渲染 ——
    重渲染而不是拆像素缩放，是为了让 1024 这一版也是矢量直出的清晰度。
    """
    d = WORK / design.key
    d.mkdir(parents=True, exist_ok=True)
    shutil.copy(src / design.source, d / "art.svg")

    master_css = MASTER // 4  # 4 倍缩放后正好 1024，够 512 档和 256 档用
    raw_shell = d / "raw.svg"
    raw_shell.write_text(
        wrapper_svg("art.svg", MASTER, 1.0, 0.0, 0.0, master_css), encoding="utf-8"
    )
    raw = render(edge, raw_shell, d / "raw.png", master_css, 4)

    if design.full_bleed:
        # 自带底板：整张画布就是图标，不裁剪、不改位置
        norm = Norm(1.0, 0.0, 0.0)
    else:
        x0, y0, x1, y1 = alpha_bbox(raw)
        long_side = max(x1 - x0, y1 - y0)
        k = FILL * MASTER / long_side
        cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        norm = Norm(k, MASTER / 2.0 - k * cx, MASTER / 2.0 - k * cy)
    NORMS[design.key] = norm

    master = render(edge, shell_for(design, master_css), d / "master.png", master_css, 4)
    if not design.full_bleed:
        # 归一化后长边应恰好落在 0.82 画布内、四边留白对称，否则就是算式或壳写错了
        bx0, by0, bx1, by1 = alpha_bbox(master)
        assert bx0 > 0 and by0 > 0 and bx1 < MASTER and by1 < MASTER, (
            f"{design.key} 归一化后仍触边：{bx0},{by0},{bx1},{by1}"
        )
    return master


def sharpness(img: Image.Image) -> float:
    """拉普拉斯锐度：不透明区域里二阶差分绝对值的均值，越大越锐。

    只用来在「16/24/32 原生栅格化」与「1024 降采样」之间挑一版，
    不做绝对质量判断（肉眼最终以 docs/icons/preview-小尺寸可读性.png 为准）。
    """
    gray = img.convert("LA")
    lap = gray.split()[0].filter(
        ImageFilter.Kernel((3, 3), (0, -1, 0, -1, 4, -1, 0, -1, 0), scale=1, offset=0)
    )
    alpha = list(gray.split()[1].getdata())
    vals = list(lap.getdata())
    picked = [v for v, a in zip(vals, alpha) if a > 96]
    return sum(picked) / len(picked) if picked else 0.0


def _pick_small(
    edge: str, design: Design, master: Image.Image, size: int
) -> tuple[Image.Image, str]:
    """16/24/32 三档：原生栅格化 vs 降采样，取更锐的一版。

    降采样版从 1024 master 缩下来线条会更柔（16px 下手写小字容易糊成灰条）；
    原生版让 Edge 按目标像素直接栅格化矢量，笔画落在整像素上更实。
    两者都算一遍锐度，脚本会打印分数，方便下次换图后复核结论是否还成立。
    """
    down = master.resize((size, size), Image.LANCZOS)
    native = render(edge, shell_for(design, size), WORK / design.key / f"n{size}.png", size, 1)
    s_down, s_native = sharpness(down), sharpness(native)
    if s_native >= s_down:
        print(f"    {design.key} {size}px: 原生 {s_native:.1f} >= 降采样 {s_down:.1f} → 用原生")
        return native, "native"
    print(f"    {design.key} {size}px: 原生 {s_native:.1f} < 降采样 {s_down:.1f} → 用降采样")
    return down, "downscaled"


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def write_ico(path: Path, frames: list[tuple[int, Image.Image]]) -> None:
    """手写 ICO 容器：ICONDIR + 每帧 16 字节入口 + PNG 数据。

    PIL 的 `save(sizes=...)` 不保证帧序、还会塞未压缩 BMP 帧，所以自己拼。
    每帧仍是 PNG（32bpp），与旧文件格式一致 —— 单测只数帧数、看最后一帧宽度。
    """
    payload = [(size, png_bytes(img)) for size, img in frames]
    head = struct.pack("<HHH", 0, 1, len(payload))  # reserved / type=icon / count
    entries = b""
    body = b""
    offset = 6 + 16 * len(payload)
    for size, data in payload:
        # 256 在 ICO 里用 0 表示（字段只有一个字节）
        dim = 0 if size >= 256 else size
        entries += struct.pack(
            "<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset + len(body)
        )
        body += data
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(head + entries + body)


def save_png(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, format="PNG", optimize=True)


# ─────────────────────────── 产物落位 ───────────────────────────

# 每枚图标在仓库里的所有拷贝点：(相对路径, 期望尺寸)。
# docs/icons 的七档由 ICO_FRAMES 统一出，这里只列散装 PNG 与 ICO。
COPIES: dict[str, tuple[tuple[str, int], ...]] = {
    "main": (
        ("src-tauri/icons/icon.png", 512),
        ("src-tauri/icons/32x32.png", 32),
        ("src-tauri/icons/64x64.png", 64),
        ("src-tauri/icons/128x128.png", 128),
        ("src-tauri/icons/128x128@2x.png", 256),
        # UWP / appx 尺寸档（桌面安装包不读，保持一致以免商店包还是旧图）
        ("src-tauri/icons/Square30x30Logo.png", 30),
        ("src-tauri/icons/Square44x44Logo.png", 44),
        ("src-tauri/icons/Square71x71Logo.png", 71),
        ("src-tauri/icons/Square89x89Logo.png", 89),
        ("src-tauri/icons/Square107x107Logo.png", 107),
        ("src-tauri/icons/Square142x142Logo.png", 142),
        ("src-tauri/icons/Square150x150Logo.png", 150),
        ("src-tauri/icons/Square284x284Logo.png", 284),
        ("src-tauri/icons/Square310x310Logo.png", 310),
        ("src-tauri/icons/StoreLogo.png", 50),
        # 前端
        ("public/favicon.png", 32),
        ("public/icon.png", 64),
        ("public/icon-512.png", 512),
        ("public/splash-icon.png", 256),
    ),
    "snapshot": (
        ("src-tauri/assets/snapshot-icon.ico", 0),  # 0 = ICO
        ("public/icons/icon-snapshot.png", 64),
    ),
    "pack": (
        ("src-tauri/assets/pack-icon.ico", 0),
        ("public/icons/icon-export-pack.png", 64),
    ),
    "library": (
        ("src-tauri/assets/data-icon.ico", 0),
        ("public/icons/icon-export-data.png", 64),
    ),
    "folder": (
        ("src-tauri/icons/library-folder.ico", 0),
        ("public/icons/icon-folder.png", 64),
    ),
}

ICO_COPIES: dict[str, tuple[str, ...]] = {
    "main": ("src-tauri/icons/icon.ico",),
    "snapshot": ("src-tauri/assets/snapshot-icon.ico",),
    "pack": ("src-tauri/assets/pack-icon.ico",),
    "library": ("src-tauri/assets/data-icon.ico",),
    "folder": ("src-tauri/icons/library-folder.ico",),
}


def write_icns(path: Path, master: Image.Image) -> None:
    """写 macOS 的 .icns（ic07=128 / ic08=256 / ic09=512，都是 PNG 块）。

    Tauri 打包 macOS 读它；内容必须跟着主图标换，否则 mac 上还是旧图。
    格式：'icns' + 总长（大端）+ 若干 (4 字节类型 + 4 字节块长 + PNG)。
    """
    blocks = b""
    for tag, size in (("ic07", 128), ("ic08", 256), ("ic09", 512)):
        data = png_bytes(master.resize((size, size), Image.LANCZOS))
        blocks += tag.encode("ascii") + struct.pack(">I", len(data) + 8) + data
    path.write_bytes(b"icns" + struct.pack(">I", len(blocks) + 8) + blocks)


# ─────────────────────────── 预览图 ───────────────────────────


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for name in ("msyh.ttc", "msyhbd.ttc", "simhei.ttf", "arial.ttf"):
        p = Path("C:/Windows/Fonts") / name
        if p.is_file():
            try:
                return ImageFont.truetype(str(p), size)
            except OSError:
                continue
    return ImageFont.load_default()


def checkerboard(w: int, h: int, cell: int = 8) -> Image.Image:
    """透明底的对照棋盘：用来证明 PNG 没有白底/黑底矩形。"""
    img = Image.new("RGBA", (w, h), (255, 255, 255, 255))
    d = ImageDraw.Draw(img)
    for y in range(0, h, cell):
        for x in range(0, w, cell):
            if (x // cell + y // cell) % 2:
                d.rectangle([x, y, x + cell - 1, y + cell - 1], fill=(224, 224, 226, 255))
    return img


def sheet_transparent(out: Path, fonts: dict[str, Image.Image]) -> None:
    """五枚并排 + 棋盘底：一眼看出透明边留得对不对。"""
    cell_w, art_h, pad, top, bottom = 300, 256, 18, 56, 40
    w = pad + len(DESIGNS) * cell_w
    h = top + art_h + bottom
    sheet = checkerboard(w, h)
    d = ImageDraw.Draw(sheet)
    title, label = load_font(20), load_font(14)
    d.text((pad, 16), "FontManager 图标 · 规范化透明版（棋盘底 = 透明区域）", font=title, fill=(24, 24, 26))
    for i, design in enumerate(DESIGNS):
        art = fonts[design.key]
        x = pad + i * cell_w + (cell_w - pad - art.width) // 2
        sheet.alpha_composite(art, (x, top))
        d.text((pad + i * cell_w + 6, top + art_h + 8), design.label, font=label, fill=(60, 60, 64))
    save_png(sheet, out)
    print(f"  {out.relative_to(REPO)} {sheet.width}×{sheet.height}")


def sheet_sizes(out: Path, sizes: dict[str, dict[int, Image.Image]]) -> None:
    """尺寸阶梯：每行一枚，256 → 16 逐档按**真实像素**贴，不缩放。

    16px 那格是不是糊成一团，只能看真尺寸，放大看不出问题。
    """
    ladder = (256, 128, 64, 48, 32, 24, 16)
    pad, row_h, label_w, top = 20, 272, 150, 58
    w = pad * 2 + label_w + sum(s + 24 for s in ladder)
    h = top + row_h * len(DESIGNS) + pad
    sheet = Image.new("RGBA", (w, h), (246, 246, 248, 255))
    d = ImageDraw.Draw(sheet)
    d.text((pad, 16), "FontManager 图标 · 小尺寸可读性（按真实像素排列，未缩放）",
           font=load_font(20), fill=(24, 24, 26))
    head = load_font(12)
    for row, design in enumerate(DESIGNS):
        y = top + row * row_h
        d.text((pad, y + 6), design.label, font=load_font(15), fill=(24, 24, 26))
        x = pad + label_w
        for size in ladder:
            art = sizes[design.key][size]
            d.rectangle([x - 2, y + 24, x + size + 1, y + 27 + size], outline=(210, 210, 214))
            sheet.alpha_composite(art, (x, y + 26))
            d.text((x, y + 30 + size), f"{size}", font=head, fill=(90, 90, 96))
            x += size + 24
            if size == 256:
                # 256 那格太高，单独占一行高度，后面的档位挂在它右边靠上
                pass
    save_png(sheet, out)
    print(f"  {out.relative_to(REPO)} {sheet.width}×{sheet.height}")


# ─────────────────────────── 校验 ───────────────────────────


def verify_icos() -> int:
    """自检：5 个 ICO 的帧数 / 尺寸 / 是否 PNG / 是否带 alpha。"""
    bad = 0
    for key, paths in ICO_COPIES.items():
        for rel in paths:
            b = (REPO / rel).read_bytes()
            if b[:4] != b"\x00\x00\x01\x00":
                print(f"  !! {rel} 不是 ICO")
                bad += 1
                continue
            count = struct.unpack("<H", b[4:6])[0]
            dims = []
            for i in range(count):
                o = 6 + i * 16
                w, h, _cc, _r, _pl, bc, size, off = struct.unpack("<BBBBHHII", b[o : o + 16])
                is_png = b[off : off + 8] == b"\x89PNG\r\n\x1a\n"
                frame = Image.open(io.BytesIO(b[off : off + size]))
                has_alpha = frame.mode == "RGBA" or "transparency" in frame.info
                dims.append((w or 256, is_png, bc, has_alpha))
            ok = count == 7 and [d[0] for d in dims] == list(ICO_FRAMES) and all(
                d[1] and d[2] == 32 and d[3] for d in dims
            )
            flag = "OK " if ok else "!! "
            print(f"  {flag}{rel}: {count} 帧 " + " ".join(f"{d[0]}" for d in dims)
                  + ("" if ok else f"  PNG={[d[1] for d in dims]} bpp={[d[2] for d in dims]}"))
            bad += 0 if ok else 1
    return bad


# ─────────────────────────── 主流程 ───────────────────────────


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="从设计稿 SVG 重跑 FontManager 全套图标")
    ap.add_argument("--src", type=Path, default=DEFAULT_SRC, help="设计稿目录（含 资源 2、3、4、5、16.svg）")
    ap.add_argument("--sheet", action="store_true", help="顺带重出 docs/icons 的两张预览图")
    ap.add_argument("--only", default="", help="只跑某几枚（逗号分隔的 key）")
    ap.add_argument("--jobs", type=int, default=4, help="并发渲染数")
    args = ap.parse_args(argv)

    edge = find_edge()
    if not args.src.is_dir():
        raise SystemExit(f"设计稿目录不存在：{args.src}")
    todo = [d for d in DESIGNS if not args.only or d.key in args.only.split(",")]
    for d in todo:
        if not (args.src / d.source).is_file():
            raise SystemExit(f"缺设计稿：{args.src / d.source}")

    WORK.mkdir(parents=True, exist_ok=True)
    print(f"Edge: {edge}\n设计稿: {args.src}\n母版画布: {MASTER}，非满版长边系数: {FILL}\n")

    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        masters: dict[str, Image.Image] = {}
        # 先并发渲染 master（每枚两遍 Edge），再逐枚出尺寸档：
        # 小尺寸档的选择依赖 master，串行起来日志更好读，且总体耗时差别不大。
        futures = {pool.submit(build_design, edge, d, args.src): d for d in todo}
        for fut, d in futures.items():
            masters[d.key] = fut.result()
            print(f"  master {d.key}: {d.source}")

    sizes: dict[str, dict[int, Image.Image]] = {}
    for design in todo:
        master = masters[design.key]
        got: dict[int, Image.Image] = {}
        for size in ICO_FRAMES:
            if size in SMALL_TIERS:
                got[size], _how = _pick_small(edge, design, master, size)
            else:
                got[size] = master.resize((size, size), Image.LANCZOS)
        sizes[design.key] = got

        # docs/icons/<key>/ 的七档 + ico
        for size in ICO_FRAMES:
            save_png(got[size], REPO / "docs" / "icons" / design.key / f"{design.key}_{size}.png")
        write_ico(
            REPO / "docs" / "icons" / design.key / f"{design.key}.ico",
            [(s, got[s]) for s in ICO_FRAMES],
        )
        # 仓库各处的拷贝
        for rel, want in COPIES[design.key]:
            if want == 0:
                continue
            save_png(master.resize((want, want), Image.LANCZOS), REPO / rel)
        for rel in ICO_COPIES[design.key]:
            write_ico(REPO / rel, [(s, got[s]) for s in ICO_FRAMES])
        if design.key == "main":
            write_icns(REPO / "src-tauri/icons/icon.icns", master)
        print(f"  {design.key}: docs/icons/{design.key}/ 七档 + ico，拷贝 "
              f"{len(COPIES[design.key]) + len(ICO_COPIES[design.key])} 处")

    if args.sheet:
        print("预览图：")
        sheet_transparent(REPO / "docs/icons/preview-规范化透明版.png",
                          {k: v[256] for k, v in sizes.items() if 256 in v})
        sheet_sizes(REPO / "docs/icons/preview-小尺寸可读性.png", sizes)

    print("自检（ICO 帧数 / PNG 帧 / 32bpp / alpha）：")
    bad = verify_icos()
    print("自检结果：", "全通过" if bad == 0 else f"{bad} 处不合格")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
