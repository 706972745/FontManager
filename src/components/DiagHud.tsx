import { useEffect, useState } from "react";
import { faceStats } from "../lib/fontLoader";
import { frameStats, startFrameWatch } from "../lib/frameWatch";

/**
 * 诊断 HUD（交接文档 §10.3）。
 *
 * 为什么必须用 DOM 而不是 DevTools：WebView2 用 `--remote-debugging-port` 会让渲染进程
 * 直接崩（0.9.9 期间实测），UIA 读 `role="status"` 的文本是唯一能看见 LRU 内部计数的通道。
 *
 * 代价要说清楚：常驻一个 500ms 的 interval + 一个 rAF 循环。所以只在
 * `?diag=1`（或 `localStorage["zfm.exp.diag"]=1`）时才挂载 —— 测量工具不能影响被测量的东西。
 */
export function DiagHud() {
  const [text, setText] = useState("");

  useEffect(() => {
    const stop = startFrameWatch();
    const timer = window.setInterval(() => {
      const f = faceStats();
      const fr = frameStats.snapshot();
      const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
      const pct = Math.round(f.prefetchHitRate * 100);
      const subPct = Math.round(f.subsetHitRate * 100);
      setText(
        `resident ${f.resident}/${mb(f.bytes)}MB pin ${f.pinned} | ` +
          `load ${f.loads} evict ${f.evictions} | ` +
          `p50 ${f.loadP50.toFixed(1)} p95 ${f.loadP95.toFixed(1)} max ${f.loadMax.toFixed(0)} | ` +
          `ink ${f.inkP95.toFixed(1)}/${f.inkCount} | ` +
          `repair ${f.repairLoads}@${f.repairP95.toFixed(0)} | ` +
          `pf ${f.prefetchHit}/${f.prefetchQueued}=${pct}% | ` +
          `sub ${f.subsetHits}/${f.subsetHits + f.subsetMisses}=${subPct}% art ${f.subsetArtifacts} | ` +
          `frame ${fr.frames} drop ${fr.drops} worst ${fr.worst.toFixed(0)}`,
      );
    }, 500);
    return () => {
      window.clearInterval(timer);
      stop();
    };
  }, []);

  return (
    <div className="diag-hud" role="status">
      {text}
    </div>
  );
}
