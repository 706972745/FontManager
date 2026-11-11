import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./design/tokens.css";
import "./app.css";
import App from "./App";
import { installMomentumScroll } from "./lib/momentumScroll";

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
    <App />
  </React.StrictMode>,
);
