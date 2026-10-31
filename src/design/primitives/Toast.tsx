import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, Info, XCircle } from "lucide-react";
import { useEffect } from "react";
import { create } from "zustand";
import { springBouncy } from "../springs";
import { playError, playKind } from "../../lib/sound";

type Kind = "success" | "error" | "info";

interface ToastAction {
  label: string;
  run: () => void;
}

interface ToastItem {
  id: number;
  kind: Kind;
  title: string;
  detail?: string;
  action?: ToastAction;
}

interface ToastStore {
  toasts: ToastItem[];
  push: (kind: Kind, title: string, detail?: string, sound?: string, action?: ToastAction) => void;
  dismiss: (id: number) => void;
  pause: (id: number) => void;
  resume: (id: number) => void;
  /** Toaster 卸载时调用：把仍处于暂停的提示重新计时（见 pausedIds 的注释） */
  resumePaused: () => void;
}

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
/**
 * 正在「暂停」的提示（鼠标悬停 / 键盘焦点进入）。
 *
 * 为什么要单独记：完整界面和速览各挂一个 Toaster，Alt+` 切换时组件被直接卸载，
 * 不会触发 mouseleave / blur。0.9.9-13 的 pause 只 clearTimeout，`resume` 又没人调，
 * 于是这条提示再也不会自动关闭，带「撤销」的还会一直占着闭包（BUG-6）。
 */
const pausedIds = new Set<number>();

function arm(id: number, ms: number, dismiss: (id: number) => void) {
  clearTimeout(timers.get(id));
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      dismiss(id);
    }, ms),
  );
}

const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (kind, title, detail, sound, action) => {
    if (kind === "success") playKind(sound ?? "success");
    else playError();
    const id = nextId++;
    set({ toasts: [...get().toasts, { id, kind, title, detail, action }] });

    arm(id, kind === "error" ? 7000 : action ? 6500 : 4000, get().dismiss);
  },
  dismiss: (id) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
    pausedIds.delete(id);
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  pause: (id) => {
    pausedIds.add(id);
    clearTimeout(timers.get(id));
  },
  resume: (id) => {
    pausedIds.delete(id);
    arm(id, 1600, get().dismiss);
  },
  resumePaused: () => {
    const live = new Set(get().toasts.map((t) => t.id));
    for (const id of [...pausedIds]) {
      pausedIds.delete(id);
      // 已经点掉的不用管；还在的补上计时器
      if (live.has(id)) arm(id, 1600, get().dismiss);
    }
  },
}));

export const toast = {
  success: (title: string, detail?: string, sound?: string, action?: ToastAction) =>
    useToastStore.getState().push("success", title, detail, sound, action),
  error: (title: string, detail?: string) =>
    useToastStore.getState().push("error", title, detail),
  info: (title: string, detail?: string) =>
    useToastStore.getState().push("info", title, detail),
};

export function Toaster() {
  const { toasts, dismiss, pause, resume } = useToastStore();
  /**
   * 卸载前把暂停中的提示恢复计时。
   * 完整界面 ⇄ 速览是两个 Toaster，切换时这个组件被卸载、不会发生 mouseleave，
   * 少了这一下，悬停过的提示会永久留在屏幕上（BUG-6）。
   * 用 getState 取最新 store，避免闭包拿到旧引用。
   */
  useEffect(() => () => useToastStore.getState().resumePaused(), []);
  return (
    <div className="toaster">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            className={`toast glass-e3 toast-${t.kind}`}
            role="status"
            initial={{ opacity: 0, x: 40, y: -10, scale: 0.94 }}
            animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
            exit={{
              opacity: 0,
              x: 32,
              scale: 0.96,
              transition: { duration: 0.16, ease: "easeIn" },
            }}
            transition={springBouncy}
            onClick={() => dismiss(t.id)}
            onMouseEnter={() => pause(t.id)}
            onMouseLeave={() => resume(t.id)}
            // 键盘用户也要能「停住」：焦点进到提示里（比如「撤销」按钮上）就不该再倒计时，
            // 否则刚 Tab 过去它就被收走了（§5 第 34 条）
            onFocusCapture={() => pause(t.id)}
            onBlurCapture={() => resume(t.id)}
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.97 }}
            layout
          >
            {t.kind === "success" ? (
              <CheckCircle2 size={16} strokeWidth={2} className="toast-icon success" />
            ) : t.kind === "error" ? (
              <XCircle size={16} strokeWidth={2} className="toast-icon error" />
            ) : (
              <Info size={16} strokeWidth={2} className="toast-icon info" />
            )}
            <span>
              <span className="toast-title">{t.title}</span>
              {t.detail && <span className="toast-detail">{t.detail}</span>}
            </span>
            {t.action && (
              <button
                className="toast-action"
                onClick={(e) => {
                  e.stopPropagation();
                  dismiss(t.id);
                  t.action?.run();
                }}
              >
                {t.action.label}
              </button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
