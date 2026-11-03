import { useT } from "../lib/i18n";
import { useFontStore } from "../state/fontStore";

/**
 * 整包（`.ZFontManager`）打包 / 解包的进度条。
 *
 * 样式和位置与 `LoadProgress` 一致（贴底、一条细线 + 一句实时详情），但**互不共用状态**：
 * 那边是「读字库」，这边是「自己读写几 GB 的文件」，导入完还会再触发一次扫描，
 * 两者可能同时在跑，塞进同一个槽位必然互相顶掉。
 */
export function PackProgress() {
  const t = useT();
  const pack = useFontStore((s) => s.packProgress);
  if (!pack) return null;

  const { kind, done, total, part, parts } = pack;
  const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : null;
  // 单卷不显示「第 1/1 卷」这种废话；多卷才带上，让用户知道还要等几卷
  const vol = parts > 1 ? t("pack.volume", { part, parts }) : "";

  let text: string;
  if (kind === "export") {
    text = percent == null
      ? t("pack.preparingExport")
      : t("pack.exporting", { done, total, percent, vol });
  } else {
    text = percent == null
      ? t("pack.preparingImport")
      : t("pack.importing", { done, total, percent, vol });
  }

  return (
    <div className="load-progress" role="status" aria-live="polite" data-hint="hint.packProgress">
      <div className="load-track" aria-hidden="true">
        {percent == null ? (
          <div className="load-fill load-fill-indeterminate" />
        ) : (
          <div className="load-fill" style={{ width: `${percent}%` }} />
        )}
      </div>
      <span className="load-text tabular">{text}</span>
    </div>
  );
}
