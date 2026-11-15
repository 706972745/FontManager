"""抓「插件中心面板」窗口（PrintWindow 兜底）。

为什么不能走 CDP：面板是程序在运行时用 WebviewWindowBuilder 建的独立窗口，
**不继承** `_tauri.local.json` 里那条 `additionalBrowserArgs --remote-debugging-port=9223`。
实测 `/json/list` 里只有主窗口一个 target（`http://tauri.localhost/`），
所以 `shoot-readme.mjs` 的两个 workshop 场景拿不到 target。这里改用 Win32 层兜底：
按窗口标题找面板 HWND → PrintWindow(PW_RENDERFULLCONTENT) → 裁客户区 → 写 PNG。

用法：python tools/shoot/panel_capture.py <pid> <out.png> [窗口标题关键词]
"""
import ctypes
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import shot  # noqa: E402  —— 复用 shot.py 的 grab / write_png / find_windows

user32 = ctypes.windll.user32


def main():
    if len(sys.argv) < 3:
        print("用法: python tools/shoot/panel_capture.py <pid> <out.png> [标题关键词]")
        return 2
    pid = int(sys.argv[1])
    out = sys.argv[2]
    keyword = sys.argv[3] if len(sys.argv) > 3 else "插件中心"

    shot.enable_dpi_awareness()
    hwnd = None
    t0 = time.time()
    while time.time() - t0 < 20:
        wins = shot.find_windows(pid)
        hit = [w for w in wins if keyword in w[1]]
        if hit:
            hwnd, title, w, h = hit[0]
            print(f"找到面板窗口 hwnd={hwnd} title={title!r} {w}x{h}", flush=True)
            break
        time.sleep(0.5)
    if not hwnd:
        print("!! 没找到面板窗口；当时该进程的可见顶层窗口：", shot.find_windows(pid), flush=True)
        return 1

    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    user32.SetForegroundWindow(hwnd)
    time.sleep(1.2)  # WebView2 合成需要一两帧，立刻抓会拿到半张白屏

    w, h, rows = shot.grab(hwnd)
    shot.write_png(out, w, h, rows)
    print(f"已写入 {out}  {w}x{h}  {os.path.getsize(out)} B", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
