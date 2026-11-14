import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// `__dirname` 在 ESM 形态的配置里不存在（package.json 是 type: module）：
// 用 import.meta.url 反推项目根 —— fileURLToPath 顺带处理了盘符与中文路径的转义，
// 手写 pathname 会在 `软件迭代` 这类目录上拿到 %E8%BD%AF… 这种坏路径。
// @ts-expect-error import.meta 在 tsconfig.node.json 的 module 设置下不被识别
const root = fileURLToPath(new URL(".", import.meta.url));

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // 启动页是**独立的第二个 HTML 入口**（不是 React 应用的一部分）：
  // 它要能在 100ms 内出首帧，所以自己一份入口、自己的脚本，不进主 bundle。
  // 少了这一项，`dist/` 里就只有 index.html，Tauri 的 splash 窗口会 404。
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        splash: resolve(root, "splash.html"),
        // 安装器 / 卸载器的界面（路线 C，2.1.7）：**独立入口**，不并进主 bundle。
        // 判据见 docs/安装器与启动页-UI交付规格书.md §9.5 C1：产物 ≤ 80KB 未压缩、
        // 主入口的 chunk 列表里不出现 setup-*.js。它由 `fontmanager.exe --installer-ui`
        // 单独加载（src-tauri/src/setup_ui.rs）。
        setup: resolve(root, "setup.html"),
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
