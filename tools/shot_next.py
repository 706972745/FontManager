"""抓安装器「下一页」的截图（shot.py 的变体，逐屏目视验收安装器的执行器）。

入库位置：tools/shot_next.py（原在 _tmp/，会随临时目录清理丢失；设计文档 R-08 要求
「安装器改动必须目视验收」，这个脚本正是那个动作的执行器 —— 与 tools/nsis-fork-audit.js
（模板溯源/红线审计）配套，一个管「渲染出来的东西对不对」，一个管「模板改没改过界」）。
依赖：同目录的 tools/shot.py（grab / write_png / find_windows / enable_dpi_awareness 都从它复用）。

用法：
    python tools/shot_next.py <setup.exe> <out.png> [等待秒数=6] [按几次回车=1]

三个必须知道的坑（都是实测踩出来的）：
  ① **等待时间用 6 秒（默认值），别显式传 3 秒**：3 秒会拍到「半截未绘制」的页面 ——
     后面的 Label 还没画出来，看着像「文案丢了」，实际只是绘制时序。6 秒连拍两次结果才稳定。
  ② **steps=2 只点一次「下一步」就停在第二屏**，不会走到 Install 段，
     所以**不会写注册表**（`WriteRegStr ... "DisplayVersion"` 在 Section Install 里）。
     要多走几屏请显式传第 4 个参数，并清楚每多按一次回车就更接近真的安装。
  ③ **拍之前先确认 fixture**：`HKCU://Software//Microsoft//Windows//CurrentVersion//Uninstall//FontManager`
     的 DisplayVersion 决定拍到哪一屏 ——
       无该键        → 全新安装（欢迎页直接接目录页）
       DisplayVersion < 2.1.5 → 升级分支（「先卸载再安装 / 直接覆盖安装（推荐）」）
       DisplayVersion = 2.1.5 → 同版本维护页（「添加/重新安装组件 / 卸载 FontManager」）
     拍到的不是你要的那一屏时，八成是这个值被并发改过（共享机器上发生过两次）。
     **断言前先读一次 DisplayVersion 并把读到的值记进报告。**

另有 shot.py 的坑（用单屏工具时同样适用）：SetForegroundWindow 抢焦点失败会把键盘事件
丢给别的窗口，所以本工具会先检查前台窗口是不是安装器、不是就重置后再发键。
"""
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shot  # noqa: E402  复用 grab/write_png/find_windows/enable_dpi_awareness

VK_RETURN = 0x0D
KEYEVENTF_KEYUP = 0x0002


def press_enter():
    shot.user32.keybd_event(VK_RETURN, 0, 0, 0)
    time.sleep(0.05)
    shot.user32.keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, 0)


def main():
    if len(sys.argv) < 3:
        print('用法: python tools/shot_next.py <exe> <out.png> [等待秒数=6] [按几次回车=1]')
        return 2
    exe, out = sys.argv[1], sys.argv[2]
    wait = float(sys.argv[3]) if len(sys.argv) > 3 else 6.0
    presses = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    shot.enable_dpi_awareness()

    proc = subprocess.Popen(
        [exe], cwd=os.path.dirname(exe),
        creationflags=0x00000008 | 0x00000200,  # DETACHED_PROCESS | NEW_PROCESS_GROUP
    )
    print("pid", proc.pid, flush=True)

    hwnd = None
    t0 = time.time()
    while time.time() - t0 < 25:
        time.sleep(0.5)
        wins = shot.find_windows(proc.pid)
        if wins:
            hwnd, title, w, h = wins[0]
            print(f"window hwnd={hwnd} title={title!r} {w}x{h}", flush=True)
            break
    if not hwnd:
        print("!! 没找到窗口")
        proc.terminate()
        return 1

    shot.user32.ShowWindow(hwnd, shot.SW_RESTORE)
    shot.user32.SetForegroundWindow(hwnd)
    time.sleep(wait)

    base, ext = os.path.splitext(out)
    for i in range(presses):
        # 确认前台窗口确实是安装器，否则键盘事件会被别人吃掉
        fg = shot.user32.GetForegroundWindow()
        if fg != hwnd:
            print(f"! 前台窗口不是安装器（fg={fg} hwnd={hwnd}），重试置前", flush=True)
            shot.user32.SetForegroundWindow(hwnd)
            time.sleep(1.0)
        press_enter()
        print(f"pressed Enter #{i + 1}", flush=True)
        time.sleep(2.5)
        step = out if presses == 1 else f"{base}-step{i + 1}{ext}"
        w, h, rows = shot.grab(hwnd)
        shot.write_png(step, w, h, rows)
        print(f"saved {step} {w}x{h} {os.path.getsize(step)} bytes", flush=True)

    proc.terminate()
    try:
        proc.wait(timeout=8)
    except Exception:
        proc.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
