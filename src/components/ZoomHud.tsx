import { useFontStore } from "../state/fontStore";

/**
 * Ctrl+滚轮调字号时闪一下的小气泡（用户 2026-11-08）。
 *
 * 为什么是 React 组件而不是往 body 上插一个 div：这个窗口是透明窗口，
 * 手写 DOM 的 `position: fixed` 实测会算到窗口外面去（气泡落在窗口左下方、被裁掉一半，
 * 看起来就像「根本没反应」）。挂在外框里、由状态驱动，位置和层级都跟界面一致。
 *
 * 常驻挂载、靠 `is-on` 切换透明度 —— 这样 CSS 过渡才有效，不会一闪就断。
 * 外层 `.app-frame` / `.qb-frame` 有 overflow:hidden，气泡不会被画到窗口外。
 */
export function ZoomHud() {
  const px = useFontStore((s) => s.zoomHint);
  return (
    <div className={px != null ? "zoom-hud is-on" : "zoom-hud"} aria-hidden="true">
      {px ?? ""}
    </div>
  );
}
