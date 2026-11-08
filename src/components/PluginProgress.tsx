import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * 插件后台任务的进度条（插件 0.8.9+，主程序 1.4.8+）。
 *
 * 插件在 stdin 上发 {"type":"progress","text":…,"percent":…,"running":…}，
 * 主程序转发成 `plugin:progress` 事件；这里渲染成贴底的细进度条 ——
 * 样式和位置与 LoadProgress / PackProgress 一致，但互不共用状态：
 * 那两条是主程序自己的读库/打包，这条是插件（GitHub 同步）的任务。
 *
 * percent 为 null 表示「不确定进度」（还在准备/核对阶段），画流动条；
 * running=false 时文字保留 5 秒（让用户看到结果）再收起。
 */
interface PluginProgressPayload {
  text: string;
  percent: number | null;
  running: boolean;
}

export function PluginProgress() {
  const [p, setP] = useState<PluginProgressPayload | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<PluginProgressPayload>("plugin:progress", (e) => {
      if (cancelled) return;
      const d = e.payload;
      if (!d || typeof d.text !== "string") return;
      setP(d);
      if (hideTimer.current !== undefined) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = undefined;
      }
      if (!d.running) {
        // 结果文字停留 5 秒再收，给用户看清「完成/失败」
        hideTimer.current = window.setTimeout(() => setP(null), 5000);
      }
    }).then((f) => {
      if (cancelled) f();
      else unlisten = f;
    });
    return () => {
      cancelled = true;
      unlisten?.();
      if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current);
    };
  }, []);

  if (!p) return null;
  const running = p.running;
  const percent =
    p.percent == null
      ? null
      : Math.max(0, Math.min(100, Math.round(p.percent)));
  return (
    <div className="load-progress" role="status" aria-live="polite">
      <div className="load-track" aria-hidden="true">
        {percent == null ? (
          running ? (
            <div className="load-fill load-fill-indeterminate" />
          ) : null
        ) : (
          <div className="load-fill" style={{ width: `${percent}%` }} />
        )}
      </div>
      <span className="load-text tabular">{p.text}</span>
    </div>
  );
}
