import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { scrimFade, spring, springSnappy, springSoft } from "../design/springs";
import { useFontStore } from "../state/fontStore";
import { useT } from "../lib/i18n";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useModalLayer } from "../lib/modalLayer";

/** 面板里最多列出几个族名，剩下的用「等 N 个」收口 —— 4213 个全列出来没有意义 */
const PREVIEW_LIMIT = 8;

/**
 * 批量「移到回收站」的确认框（C9）。
 *
 * 为什么需要它：右键菜单里「将 4213 个移到回收站」紧挨着「停用 4213 个」，
 * 没有二次确认。2026-11-01 一次误点就把全库搬进回收站 —— 虽然可还原，
 * 但用户当时看到的是「字体库 4211 → 1788」和一串看不懂的 toast。
 *
 * 结构照抄 `DuplicateDialog`：同样的遮罩、Escape、焦点陷阱、模态层级，
 * 这样键盘行为和别的对话框完全一致（§5 第 8 / 35 条）。
 */
export function TrashConfirmDialog() {
  const t = useT();
  const targets = useFontStore((s) => s.trashConfirm);
  const cancel = () => useFontStore.getState().cancelTrash();
  const confirm = () => void useFontStore.getState().confirmTrash();
  const panelRef = useFocusTrap<HTMLDivElement>(!!targets);
  const isTopLayer = useModalLayer(!!targets);
  /** 确认后到状态更新完之间锁一下按钮，避免连点触发两轮删除 */
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!targets) {
      setBusy(false);
      return;
    }
    panelRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 不是最上层就让路，否则会把下层（设置 / 对比）关掉而自己还开着
      if (!isTopLayer()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [targets, isTopLayer]);

  const names = targets ?? [];
  const shown = names.slice(0, PREVIEW_LIMIT);
  const rest = names.length - shown.length;

  const run = () => {
    if (busy) return;
    setBusy(true);
    confirm();
  };

  return (
    <AnimatePresence>
      {targets && (
        <motion.div
          className="trashconfirm-backdrop"
          onClick={cancel}
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
            aria-labelledby="trashconfirm-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8, transition: { duration: 0.13 } }}
            transition={springSnappy}
          >
            <div className="trashconfirm-head">
              <AlertTriangle size={18} strokeWidth={2} className="trashconfirm-icon" />
              <span className="trashconfirm-title" id="trashconfirm-title">
                {t("trashConfirm.title", { count: names.length })}
              </span>
            </div>
            <ul className="trashconfirm-list">
              {shown.map((name) => (
                <li key={name} className="trashconfirm-item">
                  {name}
                </li>
              ))}
            </ul>
            {rest > 0 && (
              <p className="trashconfirm-more">{t("trashConfirm.more", { count: rest })}</p>
            )}
            <p className="trashconfirm-note">{t("trashConfirm.note")}</p>
            <div className="trashconfirm-actions">
              <motion.button
                className="trashconfirm-cancel"
                onClick={cancel}
                whileTap={{ scale: 0.97, transition: springSnappy }}
                transition={springSoft}
              >
                {t("trashConfirm.cancel")}
              </motion.button>
              <motion.button
                className="trashconfirm-run"
                onClick={run}
                disabled={busy}
                whileHover={busy ? undefined : { y: -1, transition: spring }}
                whileTap={{ scale: 0.97, transition: springSnappy }}
                transition={springSoft}
              >
                {busy ? (
                  <Loader2 size={14} strokeWidth={2} className="trashconfirm-spin" />
                ) : (
                  <Trash2 size={14} strokeWidth={2} />
                )}
                {busy ? t("trashConfirm.working") : t("trashConfirm.confirm")}
              </motion.button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
