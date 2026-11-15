/**
 * 插件中心面板入口（独立 vite 入口，**不进主 bundle**）。
 *
 * 面板是主程序装到本机的独立产物：主程序开窗时用查询参数下发
 * 一次性会话 key、界面语言与主题（?k=…&lang=zh-CN&theme=dark）。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WorkshopPanel } from "./App.tsx";
import "../design/primitives/blinkCaret.css";
import "./panel.css";

const root = document.getElementById("root");
if (!root) throw new Error("找不到 #root 容器");

createRoot(root).render(
  <StrictMode>
    <WorkshopPanel />
  </StrictMode>,
);
