/**
 * GitHub 登录（设备码 / Device Flow）——面板侧的状态机。
 *
 * ## 为什么是设备码，而不是「粘贴令牌」
 *
 * 2026-11-19 用户口径：**面板不自带令牌，也不收粘贴进来的令牌**，上传能力
 * 只来自「用户自己登录一次 GitHub」。设备码是唯一不需要 client_secret、
 * 又不需要在面板里开一个密码框的方案：
 *
 * ```
 * 面板：POST /api/github/device/start
 *        → { userCode: "WDJB-MJHT", verificationUri: "...", interval: 5 }
 * 用户：浏览器打开 verificationUri，输入 8 位码，点授权
 * 面板：每 interval 秒 POST /api/github/device/poll，直到 ok / expired / denied
 * ```
 *
 * **令牌不经过这里**：`poll` 只在成功时回一个登录名，令牌由 Rust 侧直接写进
 * DPAPI 文件；面板真正要用它调 GitHub API 时才通过 `/api/upload-token` 取一次
 * （那一步有一次性会话 key 保护）。
 *
 * ## 为什么轮询由面板驱动
 *
 * 主程序不起后台线程：用户关掉面板就该立刻停。代价是「面板关掉再打开」会丢掉
 * 正在进行的登录 —— 这是**故意的**，重新点一次「连接 GitHub」比留一个不知道
 * 什么时候还在打 GitHub 的线程更好。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { PanelError, panelApi, type GithubDevicePoll, type GithubDeviceStart } from "./api.ts";

/** 文案函数：面板用自己那份 9 语言词典，key 与 upload* 同前缀 */
type TFn = (key: string, vars?: Record<string, string | number>) => string;

/**
 * 一次登录的进度。
 *
 * - `idle`     —— 没登录，也没在登录
 * - `starting` —— 正在向 GitHub 要设备码（一次网络往返，通常 < 1s）
 * - `waiting`  —— 设备码已经给用户看了，正在等他去浏览器里授权
 * - `finishing`—— 用户已授权，正在换取令牌 / 读登录名
 * - `ready`    —— 拿到令牌，`login` 有值
 */
export type AuthStatus = "idle" | "starting" | "waiting" | "finishing" | "ready";

export interface AuthState {
  status: AuthStatus;
  /** 已登录的 GitHub 登录名（`ready` 时才有） */
  login: string | null;
  /** 当前用来调 GitHub API 的令牌（`ready` 时才有） */
  token: string | null;
  /** 正在进行的设备码；`waiting` / `finishing` 时才有 */
  device: GithubDeviceStart | null;
  /** 软件是否配了 OAuth App 的 client_id（false 时整块登录不可用） */
  configured: boolean;
  /** 要给用户看的一句错误话（已本地化）；null = 没有错误 */
  error: string | null;
}

/** 轮询间隔：GitHub 给的是秒，界面用的是毫秒；下限 2s 防手滑 */
export function pollDelayMs(intervalSec: number | undefined): number {
  const sec = Math.max(2, Math.min(60, intervalSec ?? 5));
  return sec * 1000;
}

/**
 * 这个状态是不是「这条登录已经结束」。
 *
 * `pending` / `slow_down` 之外的全是终态 —— 把它们列成白名单而不是黑名单，
 * 是为了以后 GitHub 加新状态时**默认停下来**，不会变成永远转圈。
 */
export function isTerminalPoll(status: GithubDevicePoll["status"]): boolean {
  return status !== "pending" && status !== "slow_down";
}

/** 复制设备码（`navigator.clipboard` 在部分 webview 里不可用，降级不报错） */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface GithubAuth {
  state: AuthState;
  /** 开始一次设备码登录（会顺手把浏览器打开到授权页） */
  start: () => Promise<void>;
  /** 放弃这次登录（用户点「取消」或关掉弹窗时调用） */
  cancel: () => void;
  /** 退出登录 */
  signOut: () => Promise<void>;
  /** 复制设备码，成功返回 true */
  copyCode: () => Promise<boolean>;
}

export function useGithubAuth(t: TFn): GithubAuth {
  const [state, setState] = useState<AuthState>({
    status: "idle",
    login: null,
    token: null,
    device: null,
    configured: true,
    error: null,
  });

  /** 轮询定时器；`null` = 目前没在轮询 */
  const timer = useRef<number | null>(null);
  /** 组件卸载后别再 setState（关窗时正在轮询的常见路径） */
  const alive = useRef(true);

  const stopPolling = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  // 挂载时问一次会话：上次登录过的话直接进 ready，不留「已登录却显示要登录」
  useEffect(() => {
    alive.current = true;
    void panelApi
      .githubSession()
      .then(async (s) => {
        if (!alive.current) return;
        if (!s.configured) {
          setState((p) => ({ ...p, configured: false }));
          return;
        }
        if (!s.login) return;
        // 会话有效才去取令牌：令牌取不到（老版本主程序没这个端点）就当没登录
        const r = await panelApi.getUploadToken().catch(() => ({ token: null }));
        if (!alive.current || !r.token) return;
        setState((p) => ({ ...p, status: "ready", login: s.login, token: r.token }));
      })
      .catch(() => {
        /* 主程序还没起完：当成没登录，用户点「连接」会再试一次 */
      });
    return () => {
      alive.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  /** 轮询一次，并按结果决定「停」还是「隔多久再来」 */
  const schedulePoll = useCallback(
    (delayMs: number) => {
      stopPolling();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        void panelApi
          .githubDevicePoll()
          .then(async (r) => {
            if (!alive.current) return;
            if (!isTerminalPoll(r.status)) {
              // pending：按 GitHub 给的节奏；slow_down：用服务端调大后的间隔
              schedulePoll(pollDelayMs(r.interval));
              return;
            }
            switch (r.status) {
              case "ok": {
                setState((p) => ({ ...p, status: "finishing" }));
                const token = await panelApi
                  .getUploadToken()
                  .then((x) => x.token)
                  .catch(() => null);
                if (!alive.current) return;
                setState({
                  status: token ? "ready" : "idle",
                  login: r.login ?? null,
                  token,
                  device: null,
                  configured: true,
                  error: token ? null : t("uploadTokenInvalid"),
                });
                return;
              }
              case "expired":
                setState((p) => ({ ...p, status: "idle", device: null, error: t("uploadDeviceExpired") }));
                return;
              case "denied":
                setState((p) => ({ ...p, status: "idle", device: null, error: t("uploadDeviceDenied") }));
                return;
              case "error":
                setState((p) => ({
                  ...p,
                  status: "idle",
                  device: null,
                  error: r.message ?? t("uploadDeviceFailed"),
                }));
                return;
              default:
                // `none`：主程序重启过，这次登录的中间状态没了
                setState((p) => ({ ...p, status: "idle", device: null }));
            }
          })
          .catch((e) => {
            if (!alive.current) return;
            setState((p) => ({
              ...p,
              status: "idle",
              device: null,
              error: `${t("uploadDeviceFailed")} (${String((e as Error).message)})`,
            }));
          });
      }, delayMs);
    },
    [stopPolling, t],
  );

  const start = useCallback(async () => {
    stopPolling();
    setState((p) => ({ ...p, status: "starting", error: null, device: null }));
    try {
      const d = await panelApi.githubDeviceStart();
      if (!alive.current) return;
      setState((p) => ({ ...p, status: "waiting", device: d }));
      // 两件事让「小白」也能走完：① 链接带上码，浏览器打开就是填好的；
      // ② 同时把码放进剪贴板（万一用户换了浏览器 / 链接被拦，直接粘贴）。
      void copyText(d.userCode);
      // 开浏览器会抢焦点，面板是「失焦即藏」的 → 先置守位
      void panelApi.openUrl(d.verificationUriComplete ?? d.verificationUri).catch(() => {});
      schedulePoll(pollDelayMs(d.interval));
    } catch (e) {
      if (!alive.current) return;
      // 面板与主程序是**两个可以独立更新的产物**：用户可能先更新了面板、
      // 软件还停在 2.4.x（那时没有 /api/github/*）。这时候说「连不上 GitHub」
      // 会让人以为是网络问题，其实是要更新软件 —— 必须给一句准话。
      const code = e instanceof PanelError ? e.status : 0;
      setState((p) => ({
        ...p,
        status: "idle",
        device: null,
        error:
          code === 404 || code === 405
            ? t("uploadNeedAppUpdate")
            : `${t("uploadDeviceFailed")} (${String((e as Error).message)})`,
      }));
    }
  }, [schedulePoll, stopPolling, t]);

  const cancel = useCallback(() => {
    stopPolling();
    setState((p) => ({ ...p, status: "idle", device: null }));
  }, [stopPolling]);

  const signOut = useCallback(async () => {
    stopPolling();
    await panelApi.githubLogout().catch(() => {});
    if (!alive.current) return;
    setState((p) => ({
      ...p,
      status: "idle",
      login: null,
      token: null,
      device: null,
      error: null,
    }));
  }, [stopPolling]);

  const copyCode = useCallback(async () => {
    const code = state.device?.userCode;
    return code ? copyText(code) : false;
  }, [state.device]);

  return { state, start, cancel, signOut, copyCode };
}
