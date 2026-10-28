import { useT } from "../lib/i18n";
import { useFontStore } from "../state/fontStore";

/**
 * 字库读取进度条。
 *
 * 字体库动辄几千个文件，冷启动（尤其是第一次 / 换了大目录之后）要挨个解析，
 * 这段时间界面里是空的，用户只看到「在转」却不知道还要等多久。这里把
 * `scan:progress` 的 done/total 直接换成百分比摆在底部，心里有数。
 *
 * 完整界面和速览界面都用它（compact 用于速览），读完自动消失。
 */
export function LoadProgress({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const phase = useFontStore((s) => s.phase);
  const scan = useFontStore((s) => s.scanProgress);
  if (phase !== "scanning") return null;

  const { done, total } = scan;
  // 还没数出总数（正在遍历目录）时给个「不确定」态：只有文案、没有百分比
  const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : null;

  return (
    <div
      className={`load-progress ${compact ? "load-progress-compact" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className="load-track" aria-hidden="true">
        {percent == null ? (
          <div className="load-fill load-fill-indeterminate" />
        ) : (
          <div className="load-fill" style={{ width: `${percent}%` }} />
        )}
      </div>
      <span className="load-text tabular">
        {percent == null
          ? t("load.finding")
          : t("load.reading", { done, total, percent })}
      </span>
    </div>
  );
}
