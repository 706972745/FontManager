import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, Info, XCircle } from "lucide-react";
import { useEffect } from "react";
import { create } from "zustand";
import { spring, springSnappy } from "../springs";
import { playError, playKind } from "../../lib/sound";
import { enqueueToast } from "../../lib/toastQueue";

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
  /** 相同内容合并后的条数（默认 1；>1 时标题后显示 `×N`） */
  count: number;
}

/**
 * 同时最多显示几条。
 *
 * 批量操作是会「一条一条报错」的：导入 40 个 zip、把 60 个族丢进回收站，
 * 每个失败都 push 一条（`for (const err of errors) toast.error(...)`）。
 * 之前没有上限也没有合并，屏幕上会一路堆到看不见的窗外，而且每条都响一次错误音。
 * 4 条是「不挡列表、又能看清」的上限，超出的从最旧的一条开始收。
 */
const MAX_TOASTS = 4;

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

/** 一条提示该停留多久 */
function ttl(kind: Kind, action?: ToastAction): number {
  return kind === "error" ? 7000 : action ? 6500 : 4000;
}

const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (kind, title, detail, sound, action) => {
    const list = get().toasts;
    const id = nextId++;
    const { list: next, dropped, mergedId } = enqueueToast(
      list,
      { id, kind, title, detail, action, count: 1 },
      MAX_TOASTS,
    );

    // ① 和上一条一模一样：只把计数 +1，不新建、不重复响错误音
    if (mergedId != null) {
      set({ toasts: next });
      arm(mergedId, ttl(kind, action), get().dismiss);
      return;
    }

    // ② 超过上限被挤出去的：顺手清掉计时器与暂停标记（否则会泄漏）
    for (const old of dropped) {
      clearTimeout(timers.get(old.id));
      timers.delete(old.id);
      pausedIds.delete(old.id);
    }

    if (kind === "success") playKind(sound ?? "success");
    else playError();

    set({ toasts: next });
    arm(id, ttl(kind, action), get().dismiss);
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
            /*
             * 出场与入场同方向、同幅度（审计 P2-10）：原来只回 x:32、y 不动、
             * scale 还是 0.96 —— 看上去是「略微变大再消失」，和「从右上进来」对不上。
             * 现在原路退回：x:40 / y:-10，scale 收到 0.98（不再变大）。
             *
             * 入场曲线从 springBouncy（ζ≈0.51，16% 过冲）换成 springSnappy（ζ≈0.78）：
             * Toast 是全项目唯一「会弹」的东西，与整体克制的基调不符（审计 P1-11）。
             * 只改曲线、保留三轴：三轴同时动在 0.16s 里其实看不出「弹」，只是收尾抖一下。
             */
            exit={{
              opacity: 0,
              x: 40,
              y: -10,
              scale: 0.98,
              transition: { duration: 0.16, ease: "easeIn" },
            }}
            transition={springSnappy}
            onClick={() => dismiss(t.id)}
            onMouseEnter={() => pause(t.id)}
            onMouseLeave={() => resume(t.id)}
            // 键盘用户也要能「停住」：焦点进到提示里（比如「撤销」按钮上）就不该再倒计时，
            // 否则刚 Tab 过去它就被收走了（§5 第 34 条）
            onFocusCapture={() => pause(t.id)}
            onBlurCapture={() => resume(t.id)}
            whileHover={{ y: -1, transition: spring }}
            whileTap={{ scale: 0.97, transition: springSnappy }}
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
              <span className="toast-title">
                {t.title}
                {t.count > 1 && (
                  <span className="toast-count tabular" aria-label={`×${t.count}`}>
                    ×{t.count}
                  </span>
                )}
              </span>
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
