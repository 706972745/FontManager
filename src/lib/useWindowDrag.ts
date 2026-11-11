import { PhysicalPosition, getCurrentWindow } from "@tauri-apps/api/window";
import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { isQuickbarGeometryBusy } from "./useQuickbarDock";
import { snapDragTop } from "./dragSnap";

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
/**
 * 按下后移动多少（CSS 像素，屏幕坐标）才算「拖动」。
 *
 * 低于这个距离的按下—抬起只是**点了一下**：不能当成拖动去通知吸顶状态机，
 * 否则「点顶栏空白处」会被当成拖到顶边，100ms 后窗口自己收起（2026-11-11 用户反馈）。
 */
const DRAG_DEAD_PX = 3;

export function useWindowDrag() {
  const cleanupRef = useRef<(() => void) | null>(null);
  /** 组件卸载时必须摘掉监听：否则残留的 pointermove 会继续写窗口位置 */
  useEffect(() => () => cleanupRef.current?.(), []);

  return useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    if ((e.target as HTMLElement | null)?.closest(INTERACTIVE)) return;
    // 窗口几何正在被动画 / 形变改写（速览进出、收成细线）：这时候拖动，
    // 两套写入会互相覆盖，最后停在半路的坐标上（§5 第 15 条）。
    if (document.body.classList.contains("is-morphing") || isQuickbarGeometryBusy()) return;

    cleanupRef.current?.();
    const win = getCurrentWindow();
    const dpr = window.devicePixelRatio || 1;
    const startX = e.screenX;
    const startY = e.screenY;

    let baseX = 0;
    let baseY = 0;
    let ready = false;
    let done = false;
    /** 是否已越过死区、真的在拖（决定要不要通知吸顶状态机） */
    let moved = false;
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
      const dx = ev.screenX - startX;
      const dy = ev.screenY - startY;
      // 死区：指针没真正移动就是「点了一下」，什么都不做（见 DRAG_DEAD_PX）
      if (!moved) {
        if (Math.hypot(dx, dy) < DRAG_DEAD_PX) return;
        moved = true;
        document.body.classList.add("is-dragging");
      }
      const nx = baseX + dx * dpr;
      const rawY = baseY + dy * dpr;
      // DPR 实时取：拖到另一块不同缩放的屏幕上时，吸附距离也跟着那块屏幕换算。
      // 距顶边不足吸附距离 → 直接贴到 y=0（含越过顶边的情况），松手后吸顶状态机
      // 会照常判定收起；离开吸附区才回到自由拖动，保留原有越顶余量。
      const ny = snapDragTop(rawY, window.devicePixelRatio || dpr || 1);
      pending = [nx, ny];
      if (raf === undefined) raf = requestAnimationFrame(flush);
    };

    const stop = () => {
      done = true;
      if (raf !== undefined) cancelAnimationFrame(raf);
      raf = undefined;
      // 松手前最后一次位移必须落下去：rAF 还没跑就清掉 pending，
      // 窗口会停在「差一帧」的位置上，快速轻拖时特别明显（§5 第 27 条）。
      if (pending) {
        const [x, y] = pending;
        pending = null;
        void win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y))).catch(() => {});
      }
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", stop, true);
      document.removeEventListener("pointercancel", stop, true);
      window.removeEventListener("blur", stop);
      document.body.classList.remove("is-dragging");
      if (cleanupRef.current === stop) cleanupRef.current = null;
      /*
       * 真正拖过才通知吸顶状态机：没移动的按下—抬起只是「点了一下空白处」，
       * 通知过去会被 evaluate() 判成「贴在顶边」→ 100ms 后自己收起。
       * 这也是「点顶栏/抓手空白处，速览莫名其妙收起来」的根因（2026-11-11）。
       */
      if (moved) window.dispatchEvent(new Event("zfm:window-drag-end"));
    };

    e.preventDefault();
    // is-dragging 由 onMove 在越过死区后才加：只是一个点击时不该告诉全站「正在拖」
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
