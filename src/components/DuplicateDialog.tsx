import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle } from "lucide-react";
import { useEffect, useRef } from "react";
import { springSnappy } from "../design/springs";
import { useFontStore } from "../state/fontStore";
import { useT } from "../lib/i18n";

/**
 * 「这些字体已经存在，跳过了」提示。
 *
 * 它带一层挡界面的遮罩，所以必须当成真正的对话框对待：有 dialog 语义、Escape 能关、
 * 焦点收进来；用户把焦点放进来时不该继续倒计时自动消失（§5 第 35 条）。
 */
export function DuplicateDialog() {
  const t = useT();
  const report = useFontStore((s) => s.duplicateReport);
  const close = () => useFontStore.getState().setDuplicateReport(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** 焦点在里面时暂停自动关闭 */
  const pausedRef = useRef(false);

  useEffect(() => {
    if (!report) return;
    pausedRef.current = false;
    // 把焦点收进面板：键盘用户的 Tab 不该跑到被遮住的界面上
    const el = panelRef.current;
    el?.focus({ preventScroll: true });
    const id = setTimeout(() => {
      if (!pausedRef.current) close();
    }, 6500);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      // 最上层先吃，别让 Escape 继续去清主界面的选择
      e.stopImmediatePropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(id);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [report]);

  return (
    <AnimatePresence>
      {report && (
        <motion.div
          className="dup-backdrop"
          onClick={close}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <motion.div
            ref={panelRef}
            className="dup-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dup-dialog-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            onFocusCapture={(e) => {
              // 面板自己拿到焦点不算「用户在用」，只有焦点进到里面的控件才暂停倒计时
              if (e.target !== panelRef.current) pausedRef.current = true;
            }}
            onBlurCapture={() => {
              pausedRef.current = false;
            }}
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 6, transition: { duration: 0.13 } }}
            transition={springSnappy}
          >
            <div className="dup-head">
              <AlertTriangle size={18} strokeWidth={2} className="dup-icon" />
              <span className="dup-title" id="dup-dialog-title">
                {t("toast.duplicatesSkipped", { count: report.names.length })}
              </span>
            </div>
            <ul className="dup-list">
              {report.names.map((name) => (
                <li key={name} className="dup-item">
                  {name}
                </li>
              ))}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
