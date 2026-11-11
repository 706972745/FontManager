import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, FolderSync, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { scrimFade, spring, springSnappy, springSoft } from "../design/springs";
import { toast } from "../design/primitives/Toast";
import { ipc } from "../lib/ipc";
import { useT } from "../lib/i18n";
import type { TKey } from "../lib/i18n";
import { useFocusTrap } from "../lib/useFocusTrap";
import { useModalLayer } from "../lib/modalLayer";
import { useFontStore } from "../state/fontStore";

type Report = Awaited<ReturnType<typeof ipc.resyncLibraryLabels>>;

/** 后端回来的 class 字符串 → 现成的版权文案键（`t` 的入参是联合类型，不能拼字符串） */
const CLASS_LABEL: Record<string, TKey> = {
  free_commercial: "copyright.free_commercial",
  free_personal: "copyright.free_personal",
  paid: "copyright.paid",
  timelimited: "copyright.timelimited",
  unknown: "copyright.unknown",
};

/**
 * 版权判定 v7 的迁移入口：按证据重算全库字族目录名。
 *
 * 为什么需要它：后端的 `resync_library_labels` 早就写好了，但一直**没有人调用**——
 * 命令只能由开发者手动敲，普通用户点不到。v7 把「目录名当证据」这条闭环拆掉之后，
 * 老库里按旧口径写下的（商用免费）后缀就成了历史遗留：字体自己的版权信息明明写着
 * 收费，界面却还挂着免费。这个对话框就是让用户自己把那次迁移跑完的地方。
 *
 * 交互照抄 DestructiveConfirmDialog / TrashConfirmDialog：同样的遮罩、焦点陷阱、
 * 模态层级与样式类。区别是它**默认只预演**（dryRun），报告出来之后由用户决定是否落盘，
 * 而且只改「证据给出明确分类」的目录 —— 判不出来的一律保持原名，绝不凭空贴标签。
 */
export function LabelResyncDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const panelRef = useFocusTrap<HTMLDivElement>(open);
  const isTopLayer = useModalLayer(open);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  /** 预演请求的代次：面板关掉/重开时，晚到的旧结果不许覆盖新结果 */
  const gen = useRef(0);

  const preview = useCallback(async () => {
    const mine = ++gen.current;
    setLoading(true);
    setReport(null);
    try {
      const r = await ipc.resyncLibraryLabels(true);
      if (mine === gen.current) setReport(r);
    } catch (e) {
      if (mine === gen.current) toast.error(t("labelResync.failed"), String(e));
    } finally {
      if (mine === gen.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open) {
      // 关掉就作废在途请求，下次打开重新预演（字体库可能已经变了）
      gen.current += 1;
      setReport(null);
      setLoading(false);
      setApplying(false);
      return;
    }
    void preview();
  }, [open, preview]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!isTopLayer()) return;
      if (applying) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, isTopLayer, applying, onClose, panelRef]);

  const apply = async () => {
    if (applying || !report || report.changed === 0) return;
    setApplying(true);
    try {
      const r = await ipc.resyncLibraryLabels(false);
      if (r.errors.length > 0) {
        // 有失败的就把最新结果留在面板上，让用户看得见还剩哪些没改成
        setReport(r);
        toast.error(
          t("labelResync.partial", { count: r.changed, failed: r.errors.length }),
          r.errors[0],
        );
        return;
      }
      toast.success(t("labelResync.done", { count: r.changed }));
      onClose();
      // 目录名变了，卡片上的路径与分组都跟着变，重扫一次让界面回到真实状态
      void useFontStore.getState().rescan();
    } catch (e) {
      toast.error(t("labelResync.failed"), String(e));
    } finally {
      setApplying(false);
    }
  };

  const canApply = !loading && !applying && (report?.changed ?? 0) > 0;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="trashconfirm-backdrop labelresync-backdrop"
          onClick={applying ? undefined : onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={scrimFade}
        >
          <motion.div
            ref={panelRef}
            className="trashconfirm-panel glass-e3 labelresync-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="labelresync-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8, transition: { duration: 0.13 } }}
            transition={springSnappy}
          >
            <div className="trashconfirm-head">
              <FolderSync size={18} strokeWidth={1.8} className="trashconfirm-icon" />
              <span className="trashconfirm-title" id="labelresync-title">
                {t("labelResync.title")}
              </span>
            </div>

            <p className="trashconfirm-note">{t("labelResync.intro")}</p>

            {loading && (
              <div className="settings-scanning tabular" role="status" aria-live="polite">
                <LoaderCircle size={13} strokeWidth={1.5} className="settings-scanning-icon" />
                {t("labelResync.loading")}
              </div>
            )}

            {!loading && report && (
              <>
                <p className="trashconfirm-note labelresync-summary tabular">
                  {t("labelResync.summary", {
                    checked: report.checked,
                    changed: report.changed,
                    unchanged: report.unchanged,
                    noEvidence: report.no_evidence,
                  })}
                </p>
                {report.items.length === 0 ? (
                  <p className="trashconfirm-note">{t("labelResync.empty")}</p>
                ) : (
                  <ul className="trashconfirm-list labelresync-list">
                    {report.items.map((item) => (
                      <li key={item.from} className="trashconfirm-item labelresync-item">
                        <span className="detail-mono labelresync-from">{item.from}</span>
                        <ArrowRight size={11} strokeWidth={1.6} className="labelresync-arrow" />
                        <span className="detail-mono labelresync-to">{item.to}</span>
                        <span className="labelresync-class">
                          {t(CLASS_LABEL[item.class] ?? "copyright.unknown")}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {report.errors.length > 0 && (
                  <p className="trashconfirm-note">
                    {t("labelResync.errors", { count: report.errors.length })}
                  </p>
                )}
              </>
            )}

            <div className="trashconfirm-actions">
              <button
                className="trashconfirm-cancel"
                onClick={onClose}
                disabled={applying}
              >
                {t("labelResync.close")}
              </button>
              {report && report.changed > 0 && (
                <motion.button
                  className="trashconfirm-run"
                  onClick={() => void apply()}
                  disabled={!canApply}
                  whileHover={canApply ? { y: -1, transition: spring } : undefined}
                  whileTap={canApply ? { scale: 0.97, transition: springSnappy } : undefined}
                  transition={springSoft}
                >
                  {applying && (
                    <LoaderCircle size={13} strokeWidth={2} className="trashconfirm-spin" />
                  )}
                  {t("labelResync.apply", { count: report.changed })}
                </motion.button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
