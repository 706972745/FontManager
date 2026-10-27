import { useEffect, useState } from "react";
import { AVAILABLE_ADOBE_APPS, ipc, type AppWarm } from "../lib/ipc";
import { useT } from "../lib/i18n";

/**
 * 底部预热指示条。
 *
 * 只显示「此刻正在运行」的三个目标软件，百分比表示预热进度：
 * 100% 时在那边替换字体不用等；连不上会直接标红，不用等点完才发现。
 * 纯展示，不响应点击（用户明确要求）。
 */
export function WarmFooter({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const [list, setList] = useState<AppWarm[]>([]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const next = await ipc.appWarmState();
        if (alive) setList(next);
      } catch {
        /* 读不到就保持上一次的值，不要闪 */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 2000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const shown = list.filter((w) => w.running && AVAILABLE_ADOBE_APPS.includes(w.id));
  if (shown.length === 0) return null;

  const label = (w: AppWarm): string => {
    const name = t(`adobe.${w.id}`);
    if (w.state === "failed") return t("warm.failed", { app: name });
    if (w.percent >= 100) {
      return w.ms > 0 ? t("warm.readyMs", { app: name, ms: w.ms }) : t("warm.ready", { app: name });
    }
    return t("warm.working", { app: name, percent: w.percent });
  };

  return (
    <div className={`warm-footer ${compact ? "warm-footer-compact" : ""}`}>
      {shown.map((w) => (
        <span key={w.id} className="warm-chip" title={label(w)}>
          <span className={`warm-dot warm-${w.state}`} aria-hidden="true" />
          <span className="warm-name">{t(`adobe.${w.id}`)}</span>
          <span className={`warm-pct tabular ${w.state === "failed" ? "warm-pct-bad" : ""}`}>
            {w.percent}%
          </span>
        </span>
      ))}
    </div>
  );
}
