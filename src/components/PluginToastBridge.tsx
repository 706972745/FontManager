import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "../design/primitives/Toast";

/**
 * 插件提示（0.5.2）。
 *
 * 插件在 stdout 发 {"type":"toast","message":…} 时，主程序以前只把它写进日志，
 * 界面上什么都没有 —— 插件作者以为用户看到了，用户以为「点了没反应」
 * （0.5.1 实测：导出 PNG、字库统计都是这个体验）。
 *
 * 现在后端转发成 `plugin:toast` 事件，这里接到应用内统一的 toast 上。
 * 不弹「成功/失败」：插件没说结果性质，用中性提示，别替它下判断。
 */
interface PluginToastPayload {
  plugin?: string;
  message?: string;
}

export function PluginToastBridge() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<PluginToastPayload>("plugin:toast", (e) => {
      if (cancelled) return;
      const msg = e.payload?.message;
      if (typeof msg !== "string" || !msg.trim()) return;
      toast.info(msg.trim());
    })
      .then((f) => {
        if (cancelled) f();
        else unlisten = f;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  return null;
}
