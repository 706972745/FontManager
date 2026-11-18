import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./design/tokens.css";
import "./app.css";
// 块状闪烁光标与主程序/插件中心面板共用一份（面板是独立 vite 入口，不会加载 app.css）
import "./design/primitives/blinkCaret.css";
import App from "./App";
import { BootErrorBoundary, reportBootError } from "./design/primitives/BootErrorBoundary";
import { installMomentumScroll } from "./lib/momentumScroll";

// 渲染期异常由 BootErrorBoundary 接（React 只认那一层）；事件回调、定时器、
// Promise 里的异常不会冒到它，这里补一层 window 级兜底 —— 只记日志，
// 不动启动页（那类错误大多不影响界面继续跑）。
window.addEventListener("error", (e) => {
  // 资源加载失败（字体、图标 404）也会触发 error 事件，但 `e.error` 是空的：
  // 那些不影响使用，记下来只会把日志灌满。
  if (e.error) reportBootError(e.error, "window.error");
});
window.addEventListener("unhandledrejection", (e) => {
  reportBootError(e.reason, "unhandledrejection");
});

// 惯性滚动（2026-11-11 用户要求）：Windows 上的 WebView2 滚轮没有惯性，
// 松手就停；这里统一接管成「继续滑行 + 指数减速」。整套逻辑自带边界
// （到底交还原生、输入框 / Ctrl 滚轮 / 横向滚动一律放行、减动效时关闭），
// 完整界面与速览两个窗口都会装上。
installMomentumScroll();

// 关掉 WebView2 自带的右键菜单（返回 / 刷新 / 另存为 / 打印 / 更多工具）：
// 软件自己的右键菜单由 React 处理，空白处右键弹出浏览器菜单只会让人困惑
//（2026-11-05 用户反馈：这东西用不到）。capture 阶段只 preventDefault、
// 不 stopPropagation，软件自己的菜单照常弹出；输入框保留系统菜单（复制/粘贴）。
document.addEventListener(
  "contextmenu",
  (e) => {
    const t = e.target as HTMLElement | null;
    if (t && t.closest("input, textarea, [contenteditable='true']")) return;
    e.preventDefault();
  },
  true,
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* 兜底只包一层：渲染树炸了也要把启动页收掉，别让用户对着启动页干等（2.4.4 事故） */}
    <BootErrorBoundary>
      <App />
    </BootErrorBoundary>
  </React.StrictMode>,
);
