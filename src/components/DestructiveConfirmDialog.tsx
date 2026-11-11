import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { scrimFade, spring, springSnappy, springSoft } from "../design/springs";
import { useFontStore } from "../state/fontStore";
import { useT } from "../lib/i18n";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useModalLayer } from "../lib/modalLayer";

/**
 * DEF-1 / DEF-2：「删除非空分组」与「清空快照内所有字体」的确认框。
 *
 * 为什么需要它（2026-11-01 测试报告）：
 *   - DEF-1：删非空分组原来立即执行，只 toast 一句「已删除分组（含 3 项）」。
 *     分组关系（元数据）的丢失不可撤销，测试文档 §3.7 要求「组内 N 个字体如何
 *     处理」必须有明确提示——字体本身不删，对话框要把这条边界说清楚。
 *   - DEF-2：「清除快照内所有字体」原来也是立即清空，测试文档 §4.8 要求确认框。
 *
 * 两件事后果不同（一个丢分组关系、一个丢快照记录），但结构完全一样，
 * 所以合成一个组件按 `pendingDestructive.kind` 分叉，不写两个 90% 重复的文件。
 *
 * 结构照抄 TrashConfirmDialog / ResumeBatchDialog：同样的遮罩、Escape、焦点陷阱、
 * 模态层级与样式类，键盘行为和别的对话框完全一致。
 */
export function DestructiveConfirmDialog() {
  const t = useT();
  const pending = useFontStore((s) => s.pendingDestructive);
  const cancel = () => useFontStore.getState().cancelPendingDestructive();
  const confirm = () => void useFontStore.getState().confirmPendingDestructive();
  const panelRef = useFocusTrap<HTMLDivElement>(!!pending);
  const isTopLayer = useModalLayer(!!pending);
  /** 确认后到状态更新完之间锁一下按钮，避免连点触发两轮 */
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pending) {
      setBusy(false);
      return;
    }
    panelRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!isTopLayer()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending, isTopLayer]);

  const run = () => {
    if (busy || !pending) return;
    setBusy(true);
    confirm();
  };

  const isCollection = pending?.kind === "collection";

  return (
    <AnimatePresence>
      {pending && (
        <motion.div
          className="trashconfirm-backdrop"
          onClick={busy ? undefined : cancel}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={scrimFade}
        >
          <motion.div
            ref={panelRef}
            className="trashconfirm-panel glass-e3"
            role="dialog"
            aria-modal="true"
            aria-labelledby="destructiveconfirm-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8, transition: { duration: 0.13 } }}
            transition={springSnappy}
          >
            <div className="trashconfirm-head">
              <AlertTriangle size={18} strokeWidth={2} className="trashconfirm-icon" />
              <span className="trashconfirm-title" id="destructiveconfirm-title">
                {isCollection
                  ? t("confirmDestructive.collectionTitle", { name: pending.name })
                  : t("confirmDestructive.snapshotTitle", { name: pending.name })}
              </span>
            </div>
            <p className="trashconfirm-note">
              {isCollection
                ? t("confirmDestructive.collectionBody", { count: pending.count })
                : t("confirmDestructive.snapshotBody", { count: pending.count })}
            </p>
            <div className="trashconfirm-actions">
              <motion.button
                className="trashconfirm-cancel"
                onClick={cancel}
                disabled={busy}
                whileTap={busy ? undefined : { scale: 0.97, transition: springSnappy }}
                transition={springSoft}
              >
                {t("confirmDestructive.cancel")}
              </motion.button>
              <motion.button
                className="trashconfirm-run"
                onClick={run}
                disabled={busy}
                whileHover={busy ? undefined : { y: -1, transition: spring }}
                whileTap={busy ? undefined : { scale: 0.97, transition: springSnappy }}
                transition={springSoft}
              >
                {isCollection
                  ? t("confirmDestructive.delete")
                  : t("confirmDestructive.clear")}
              </motion.button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
