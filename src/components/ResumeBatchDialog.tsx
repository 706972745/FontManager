import { AnimatePresence, motion } from "motion/react";
import { History, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { springSnappy, springSoft } from "../design/springs";
import { useFontStore } from "../state/fontStore";
import { useT } from "../lib/i18n";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useModalLayer } from "../lib/modalLayer";

/**
 * E2：上次批量启停没跑完的续做询问框。
 *
 * 启动时从 state.pending_batch 读到断点（fontStore.init 之后由 App 挂载时拉一次）
 * 就弹这个框：继续 = 把剩下的清单交给 setFamiliesActiveBulk 原路跑完；
 * 放弃 = 清除断点，剩余清单作废。绝不背着用户自动动注册表（红线 8 的口径）。
 *
 * 结构照抄 TrashConfirmDialog：同样的遮罩、Escape、焦点陷阱、模态层级与样式类，
 * 键盘行为和别的对话框完全一致。
 */
export function ResumeBatchDialog() {
  const t = useT();
  const cp = useFontStore((s) => s.pendingResume);
  const [busy, setBusy] = useState(false);
  const panelRef = useFocusTrap<HTMLDivElement>(!!cp);
  const isTopLayer = useModalLayer(!!cp);

  useEffect(() => {
    if (!cp) {
      setBusy(false);
      return;
    }
    panelRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!isTopLayer()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      dismiss();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cp, isTopLayer]);

  const dismiss = () => useFontStore.getState().dismissPendingResume();

  const resume = () => {
    if (busy || !cp) return;
    setBusy(true);
    void useFontStore.getState().resumePendingBatch(cp);
  };

  const mode = cp?.active ? t("resumeBatch.activate") : t("resumeBatch.deactivate");
  const remaining = cp?.remaining.length ?? 0;

  return (
    <AnimatePresence>
      {cp && (
        <motion.div
          className="trashconfirm-backdrop"
          onClick={busy ? undefined : dismiss}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <motion.div
            ref={panelRef}
            className="trashconfirm-panel glass-e3"
            role="dialog"
            aria-modal="true"
            aria-labelledby="resumebatch-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8, transition: { duration: 0.13 } }}
            transition={springSnappy}
          >
            <div className="trashconfirm-head">
              <History size={18} strokeWidth={2} className="trashconfirm-icon" />
              <span className="trashconfirm-title" id="resumebatch-title">
                {t("resumeBatch.title", { mode })}
              </span>
            </div>
            <p className="trashconfirm-note">
              {t("resumeBatch.body", {
                remaining,
                total: cp.total,
                done: cp.done,
                mode,
              })}
            </p>
            <div className="trashconfirm-actions">
              <motion.button
                className="trashconfirm-cancel"
                onClick={dismiss}
                disabled={busy}
                whileTap={busy ? undefined : { scale: 0.97 }}
                transition={springSoft}
              >
                {t("resumeBatch.discard")}
              </motion.button>
              <motion.button
                className="trashconfirm-run"
                onClick={resume}
                disabled={busy}
                whileHover={busy ? undefined : { y: -1 }}
                whileTap={busy ? undefined : { scale: 0.97 }}
                transition={springSoft}
              >
                {busy && <Loader2 size={14} strokeWidth={2} className="trashconfirm-spin" />}
                {t("resumeBatch.continue")}
              </motion.button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
