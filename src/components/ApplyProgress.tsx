import { useT } from "../lib/i18n";
import { useFontStore } from "../state/fontStore";

/**
 * 快照应用的底部状态条，两种形态：
 *   1. 正在应用/撤销：细进度条 + 「取消」；
 *   2. 已取消：常驻的「已应用 x / y + 撤销」条。
 *
 * 为什么要有第 2 种：取消往往发生在一个几分钟的操作之后，用户的眼睛在字体列表上，
 * 用 6 秒就消失的 toast 提示「可以撤销」根本来不及点。这里复用同一条底部条，
 * 让它一直待着，点到为止。
 *
 * 样式复用 `LoadProgress` 的 `.load-progress`，不新造 UI。
 */
export function ApplyProgress({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const apply = useFontStore((s) => s.applyProgress);
  const notice = useFontStore((s) => s.applyNotice);
  const cancelApply = useFontStore((s) => s.cancelApply);
  const undoLastApply = useFontStore((s) => s.undoLastApply);
  const dismissApplyNotice = useFontStore((s) => s.dismissApplyNotice);
  const cancelled = useFontStore((s) => s.applyCancelled);

  if (!apply && !notice) return null;

  const className = `load-progress ${compact ? "load-progress-compact" : ""}`;

  if (!apply) {
    return (
      <div className={className} role="status" aria-live="polite">
        <span className="load-text">
          {t("snap.cancelled")} · {t("snap.cancelledDetail", { done: notice!.done, total: notice!.total })}
        </span>
        <button className="load-cancel" onClick={undoLastApply} title={t("snap.cancelUndoTip")}>
          {t("snap.cancelUndo")}
        </button>
        <button className="load-cancel" onClick={dismissApplyNotice} title={t("snap.noticeClose")}>
          {t("snap.noticeClose")}
        </button>
      </div>
    );
  }

  const { done, total, undo } = apply;
  const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : null;

  return (
    <div className={className} role="status" aria-live="polite">
      <div className="load-track" aria-hidden="true">
        {percent == null ? (
          <div className="load-fill load-fill-indeterminate" />
        ) : (
          <div className="load-fill" style={{ width: `${percent}%` }} />
        )}
      </div>
      <span className="load-text tabular">
        {undo
          ? t("snap.undoing", { done, total, percent: percent ?? 0 })
          : t("load.applying", { done, total, percent: percent ?? 0 })}
      </span>
      {/* 撤销本身是一次「回到原状」的动作，中途停下来的话又会卡在第三个中间态，所以不给再取消 */}
      {!cancelled && !undo && (
        <button className="load-cancel" onClick={cancelApply} title={t("snap.cancelTip")}>
          {t("snap.cancel")}
        </button>
      )}
    </div>
  );
}
