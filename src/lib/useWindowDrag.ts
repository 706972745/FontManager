import { PhysicalPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";

/** 可以越过屏幕上边界的余量（物理像素）：留一点点让窗口能贴到顶，又不会整条飞到屏幕外 */
const OVER_TOP = 4;
/** 拖动时不响应拖动的控件（输入框、按钮、滑条……） */
const INTERACTIVE = "input, textarea, select, button, a, [data-no-drag]";

/**
 * 自己实现窗口拖动，返回要挂到「可拖动区域」上的 pointerdown 处理器。
 *
 * 速览窗口不能用系统自带的标题栏拖动（`data-tauri-drag-region`）：那条路径会带上
 * Windows 的贴靠（Snap）行为，把窗口拖到屏幕顶端时系统会把它拉成整屏高，
 * 而不是我们要的「收起成一条」。这里改为按鼠标位移直接设置窗口位置，
 * 顺手把窗口上边界吸附在屏幕顶端，拖到最上面时能明显感觉“顶住了”。
 *
 * 移动用 requestAnimationFrame 合并到每帧一次，避免拖动时堆积 IPC 消息。
 * 只用于速览界面，完整界面仍用系统标题栏拖动。
 */
export function useWindowDrag() {
  const cleanupRef = useRef<(() => void) | null>(null);

  return useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    if ((e.target as HTMLElement | null)?.closest(INTERACTIVE)) return;

    cleanupRef.current?.();
    const win = getCurrentWindow();
    const dpr = window.devicePixelRatio || 1;
    const startX = e.screenX;
    const startY = e.screenY;

    let baseX = 0;
    let baseY = 0;
    let ready = false;
    let done = false;
    let pending: [number, number] | null = null;
    let raf: number | undefined;

    void win
      .outerPosition()
      .then((p) => {
        if (done) return;
        baseX = p.x;
        baseY = p.y;
        ready = true;
      })
      .catch(() => {});

    const flush = () => {
      raf = undefined;
      if (!pending) return;
      const [x, y] = pending;
      pending = null;
      void win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y))).catch(() => {});
    };

    const onMove = (ev: PointerEvent) => {
      if (!ready || done) return;
      const nx = baseX + (ev.screenX - startX) * dpr;
      // 往上顶到屏幕边缘就停住，配合吸顶收起
      const ny = Math.max(-OVER_TOP, baseY + (ev.screenY - startY) * dpr);
      pending = [nx, ny];
      if (raf === undefined) raf = requestAnimationFrame(flush);
    };

    const stop = () => {
      done = true;
      if (raf !== undefined) cancelAnimationFrame(raf);
      raf = undefined;
      pending = null;
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", stop, true);
      document.removeEventListener("pointercancel", stop, true);
      window.removeEventListener("blur", stop);
      document.body.classList.remove("is-dragging");
      if (cleanupRef.current === stop) cleanupRef.current = null;
      // 松手后没有新的 move 事件了，通知吸顶状态机再判定一次：
      // 被拖离顶边要解除吸顶、拖回顶边要重新吸住，都靠这一下。
      window.dispatchEvent(new Event("zfm:window-drag-end"));
    };

    e.preventDefault();
    document.body.classList.add("is-dragging");
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", stop, true);
    document.addEventListener("pointercancel", stop, true);
    window.addEventListener("blur", stop);
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* 拿不到指针捕获就退化为文档级监听，拖动依然可用（鼠标别移出窗口） */
    }
    cleanupRef.current = stop;
  }, []);
}
