"""抓 FontManager 窗口截图（纯 ctypes + zlib，不依赖 PIL / .NET）。

入库位置：tools/shot.py —— 与 tools/shot_next.py 配套（后者 `import shot` 复用这里的
grab / write_png / find_windows / enable_dpi_awareness，两个文件必须放在同一目录）。
原在 _tmp/，会随临时目录清理丢失，故一并入库。

用法： python tools/shot.py <exe> <out.png> [等待秒数]
流程：启动 exe → 找主窗口 → 等渲染 → PrintWindow(PW_RENDERFULLCONTENT)
      → 按客户区裁掉边框 → 写 PNG → 结束进程。

⚠️ 等待秒数默认 18 秒；**别显式传 3 秒** —— 3 秒会拍到「半截未绘制」的页面（后面的
Label 还没画出来，看着像「文案丢了」，实际只是绘制时序），6 秒起才稳定。
本工具只拍**第一屏**，要走多屏用 shot_next.py。
"""
import ctypes
import ctypes.wintypes as wt
import os
import struct
import subprocess
import sys
import time
import zlib

PW_RENDERFULLCONTENT = 0x00000002
SW_RESTORE = 9


class RECT(ctypes.Structure):
    _fields_ = [("left", wt.LONG), ("top", wt.LONG), ("right", wt.LONG), ("bottom", wt.LONG)]


class POINT(ctypes.Structure):
    _fields_ = [("x", wt.LONG), ("y", wt.LONG)]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG),
        ("biPlanes", wt.WORD), ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
        ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", wt.LONG), ("biYPelsPerMeter", wt.LONG),
        ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD),
    ]


user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

WNDENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


def enable_dpi_awareness():
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_AWARE
    except Exception:
        try:
            user32.SetProcessDPIAware()
        except Exception:
            pass


def find_windows(pid):
    found = []

    def cb(hwnd, _):
        p = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        if p.value != pid:
            return True
        if not user32.IsWindowVisible(hwnd):
            return True
        r = RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        w, h = r.right - r.left, r.bottom - r.top
        if w > 400 and h > 300:
            buf = ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(hwnd, buf, 256)
            found.append((hwnd, buf.value, w, h))
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return found


def grab(hwnd):
    wr = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(wr))
    w, h = wr.right - wr.left, wr.bottom - wr.top

    cr = RECT()
    user32.GetClientRect(hwnd, ctypes.byref(cr))
    pt = POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(pt))
    ox = pt.x - wr.left
    oy = pt.y - wr.top
    cw, ch = cr.right - cr.left, cr.bottom - cr.top

    hdc_screen = user32.GetDC(0)
    hdc = gdi32.CreateCompatibleDC(hdc_screen)
    hbmp = gdi32.CreateCompatibleBitmap(hdc_screen, w, h)
    gdi32.SelectObject(hdc, hbmp)
    ok = user32.PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT)

    bmi = BITMAPINFOHEADER()
    bmi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmi.biWidth = w
    bmi.biHeight = -h  # 负数 = 自上而下
    bmi.biPlanes = 1
    bmi.biBitCount = 32
    bmi.biCompression = 0
    buf = ctypes.create_string_buffer(w * h * 4)
    got = gdi32.GetDIBits(hdc, hbmp, 0, h, buf, ctypes.byref(bmi), 0)

    gdi32.DeleteObject(hbmp)
    gdi32.DeleteDC(hdc)
    user32.ReleaseDC(0, hdc_screen)

    if not ok or got == 0:
        raise RuntimeError(f"PrintWindow/GetDIBits 失败 ok={ok} lines={got}")

    rows = []
    stride = w * 4
    for y in range(oy, min(oy + ch, h)):
        start = y * stride + ox * 4
        rows.append(buf.raw[start:start + cw * 4])
    return cw, ch, rows


def write_png(path, w, h, bgra_rows):
    raw = bytearray()
    for row in bgra_rows:
        raw.append(0)  # filter: none
        # BGRA -> RGBA
        px = bytearray(row)
        px[0::4], px[2::4] = px[2::4], px[0::4]
        raw += px

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 6))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main():
    if len(sys.argv) < 3:
        print('用法: python tools/shot.py <exe> <out.png> [等待秒数=18]')
        return 2
    exe, out = sys.argv[1], sys.argv[2]
    wait = float(sys.argv[3]) if len(sys.argv) > 3 else 18.0
    enable_dpi_awareness()

    proc = subprocess.Popen([exe], cwd=os.path.dirname(exe),
                            creationflags=0x00000008 | 0x00000200)  # DETACHED_PROCESS | NEW_PROCESS_GROUP
    print("pid", proc.pid, flush=True)

    hwnd = None
    t0 = time.time()
    while time.time() - t0 < 25:
        time.sleep(0.5)
        wins = find_windows(proc.pid)
        if wins:
            hwnd, title, w, h = wins[0]
            print(f"window hwnd={hwnd} title={title!r} {w}x{h}", flush=True)
            break
    if not hwnd:
        print("!! 没找到窗口")
        proc.terminate()
        return 1

    user32.ShowWindow(hwnd, SW_RESTORE)
    user32.SetForegroundWindow(hwnd)
    time.sleep(wait)

    w, h, rows = grab(hwnd)
    write_png(out, w, h, rows)
    print(f"saved {out} {w}x{h} {os.path.getsize(out)} bytes", flush=True)

    proc.terminate()
    try:
        proc.wait(timeout=8)
    except Exception:
        proc.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
