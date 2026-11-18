import { Component, type ErrorInfo, type ReactNode } from "react";

import { t } from "../../lib/i18n";
import { ipc } from "../../lib/ipc";

/**
 * 启动期兜底：任何渲染异常都不许让界面「无声消失」。
 *
 * 事故背景（2026-11-19，2.4.4）：`ApplyProgress` 在冷启动时解引用了一个 null，
 * 项目没有 ErrorBoundary，React 直接把整棵树卸载 —— 主窗口变成空白，
 * 前端再也不会调 `splash_done`，用户看到的就只有启动页一直停在
 * 「正在读取上次启用的字体…」。整条链上没有一句报错，只能靠 Rust 侧
 * 「15 秒内主界面没被打开」反推。
 *
 * 这个组件解决三件事：
 * 1. **先把启动页结束掉**（`splashDone` 是幂等的）：主窗口必须出来，
 *    哪怕出来的是一个错误页 —— 卡在启动页是最糟的形态，用户连重试都没得点。
 * 2. **把异常写进 activation.log**：前端拿不到数据根，走 `log_frontend` 命令。
 * 3. **给用户两个真能用的出口**：重试（重新加载 WebView）和打开日志目录。
 *
 * 边界就一层，包住整个 App：再多一层也只是把错误挪个位置，不会变得更好修。
 * 不能捕获的：事件回调里的异步错误（onClick 里的 throw 不会冒到这里），
 * 那类由 `main.tsx` 里的 window 级监听兜。
 */
export class BootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportBootError(error, info.componentStack ?? "", { unblockSplash: true });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="boot-error" role="alert">
        <h1 className="boot-error-title">{t("boot.error.title")}</h1>
        <p className="boot-error-body">{t("boot.error.body")}</p>
        {/* 技术细节原样给出：用户看不懂也没关系，截图发过来就能定位 */}
        <pre className="boot-error-msg">{String(error.message || error).slice(0, 400)}</pre>
        <div className="boot-error-actions">
          <button className="boot-error-btn" onClick={() => window.location.reload()}>
            {t("boot.error.retry")}
          </button>
          <button
            className="boot-error-btn"
            onClick={() => {
              void ipc
                .logFilePath()
                .then((p) => ipc.revealInFolder(p))
                .catch(() => {});
            }}
          >
            {t("boot.error.openLogs")}
          </button>
        </div>
      </div>
    );
  }
}

/**
 * 记录一次前端异常。
 *
 * `unblockSplash` 只在**渲染树已经死掉**的时候传 true（见本组件的 `componentDidCatch`）：
 * `splash_done` 是让启动页收工的唯一信号，主窗口要是没了它，用户就只能看着启动页干等。
 * window 级的 `error` / `unhandledrejection` 不传 —— 那些大多不影响 React 树继续跑，
 * 提前关掉启动页反而会让主界面「先白一下再出现」。
 *
 * 两个 invoke 都 `.catch(() => {})`：日志写不进去不该反过来把界面搞崩
 * （浏览器预览里没有 Tauri，invoke 一定 reject）。
 */
export function reportBootError(
  error: unknown,
  where: string,
  opts: { unblockSplash?: boolean } = {},
) {
  const err = error instanceof Error ? error : new Error(String(error));
  // 控制台留一份给开发模式（打包后没人看，dev 下最方便）
  console.error(`[boot] ${where}`, err);

  if (opts.unblockSplash) ipc.splashDone().catch(() => {});
  ipc
    .logFrontend("error", `${where}: ${err.message}\n${err.stack ?? ""}`)
    .catch(() => {});
}
