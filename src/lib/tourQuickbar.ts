import { useSyncExternalStore } from "react";
import { useFontStore } from "../state/fontStore";

/**
 * 导览「真的切进速览去讲」这一段的状态机（1.9.3，清单 B52）。
 *
 * 背景：用户不接受「讲速览时只指着入口按钮」——讲速览就要看到速览。但速览不是一层
 * 浮层，而是**把整个窗口搬到屏幕顶部、换成窄尺寸**（`enterQuickbar`）：
 * App 在 `quickbar === true` 时整块换渲染树，导览层（`<Onboarding />`）跟着被卸载。
 * 所以「进速览」这件事必须由导览自己记住自己走到哪了，而且只能是**一个**状态机，
 * 不能压在组件实例上（切换过程中两个实例会先后存在：完整界面那个卸载、速览那个挂载）。
 *
 * 四个相位：
 *   main        完整界面，导览层正常画；
 *   to-quickbar 窗口正在滑出屏幕 / 屏幕外换装（此时两个窗口都不适合画卡片，空场）；
 *   quickbar    速览已经就位，导览层在速览窗口里画；
 *   to-main     正在退出速览（同样空场）。
 *
 * 为什么用模块级状态而不是塞进 fontStore：这只是导览的瞬态，不进 prefs、不需要在
 * 多条业务逻辑间共享；放 store 里反而要给它写「不持久化」的例外。组件用
 * `useSyncExternalStore` 订阅即可，两个实例看到的是同一份真相。
 */

export type TourPhase = "main" | "to-quickbar" | "quickbar" | "to-main";

export interface TourStage {
  phase: TourPhase;
  /**
   * 哪一步「进速览」失败过。
   * 失败后不再自动重试（否则 phase 会在 main ↔ to-quickbar 之间来回抖），
   * 卡片退回完整界面、指回入口按钮讲，导览照常能走完。
   */
  failedStep: number | null;
}

let stage: TourStage = { phase: "main", failedStep: null };
const listeners = new Set<() => void>();

/** 读相位。走函数读而不是直接读 `stage.phase`：TS 会把 `let` 的窄化一路带过 await，
 *  读出来的是「进函数时」的相位，不是此刻的（下面进/出的竞态判断全靠这个准确值）。 */
function currentPhase(): TourPhase {
  return stage.phase;
}

function publish(patch: Partial<TourStage>): void {
  const next: TourStage = { ...stage, ...patch };
  if (next.phase === stage.phase && next.failedStep === stage.failedStep) return;
  stage = next;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 读当前相位（组件里用，跟着相位更新重渲染） */
export function useTourStage(): TourStage {
  return useSyncExternalStore(
    subscribe,
    () => stage,
    () => stage,
  );
}

/**
 * 用户原来的「贴顶自动隐藏」。导览期间临时关掉，讲完原样还回去。
 * 它不在 `ipc.setPrefs` 的落盘字段里（只在内存里），所以临时改不会写进 state.json。
 */
let savedAutoHide: boolean | null = null;
/** 退出速览这一趟（同一时刻只允许一趟，重复调用复用同一个 Promise） */
let leaveInflight: Promise<void> | null = null;

function restoreAutoHide(): void {
  if (savedAutoHide === null) return;
  useFontStore.getState().setQuickbarAutoHide(savedAutoHide);
  savedAutoHide = null;
}

/**
 * 进速览并站稳（`setQuickbar(true)` 内部已经串行化 + 意图合并，这里只负责相位与停顿）。
 *
 * 为什么要先关「贴顶自动隐藏」：开着的时候 `enterQuickbar` 会把窗口直接压成
 * 34px 的提示条（`DOCK_HEIGHT_HINT`），卡片根本没地方放；而且 dock 接管后
 * 鼠标一移开就收成细线，导览卡片会跟着窗口一起消失。
 */
export async function enterTourQuickbar(step: number): Promise<void> {
  if (currentPhase() !== "main") return;
  publish({ phase: "to-quickbar" });
  const store = useFontStore.getState();
  savedAutoHide = store.quickbarAutoHide;
  store.setQuickbarAutoHide(false);
  try {
    /*
     * 4 s 超时兜底（清单 M2）：`enterQuickbar` 外面虽然有一整层 try/catch，但内部
     * 有一串**没有 catch 的 await**（restoreQuickbarDock / setMinSize / isMaximized …）。
     * IPC 一旦挂住（既不 resolve 也不 reject），这里就永不返回 → 相位永久停在
     * `to-quickbar` → 两个窗口都不画卡片 → 导览永久空场，且 autoHide 不还原。
     * 超时后走「进速览失败」那条路：退回完整界面、指着入口按钮把这一步讲完。
     */
    let timedOut = false;
    await Promise.race([
      store.setQuickbar(true),
      new Promise<void>((r) =>
        setTimeout(() => {
          timedOut = true;
          r();
        }, 4000),
      ),
    ]);
    if (timedOut) console.warn("[tour] 切入速览超时，退回完整界面继续导览");
  } catch (e) {
    console.warn("[tour] 切到速览失败", e);
  }
  if (!useFontStore.getState().quickbar) {
    // 没切成（几何调不动 / IPC 失败都已在 setQuickbar 内部兜底成「界面照切」，
    // 走到这里说明连界面都没切）：退回完整界面，这一步不再重试
    restoreAutoHide();
    publish({ phase: "main", failedStep: step });
    return;
  }
  // 期间如果用户已经要求退出（相位被 leaveTourQuickbar 改成 to-main），别把相位拽回来
  if (currentPhase() === "to-quickbar") publish({ phase: "quickbar" });
}

/**
 * 退回完整界面并还原几何。
 * 幂等：不在速览相位时立刻 resolve；正在退出的复用同一个 Promise。
 * 竞态靠 `setQuickbar` 自己的 single-flight 兜住：进出撞在一起时，
 * 最后按「用户最后一次表达的意图」收尾，不会停在半路。
 */
export function leaveTourQuickbar(): Promise<void> {
  if (currentPhase() === "main") {
    restoreAutoHide();
    return Promise.resolve();
  }
  if (!leaveInflight) {
    leaveInflight = (async () => {
      publish({ phase: "to-main" });
      try {
        await useFontStore.getState().setQuickbar(false);
      } catch (e) {
        console.warn("[tour] 退回完整界面失败", e);
      } finally {
        // 无论几何是否还原成功，相位与用户偏好都要回位：
        // 停在 to-main 就等于导览层永久空场（卡片再也不出来）
        restoreAutoHide();
        publish({ phase: "main" });
      }
    })().finally(() => {
      leaveInflight = null;
    });
  }
  return leaveInflight;
}

/**
 * 用户没走导览的退出流程就自己回到了完整界面（速览右上角「完整界面」/ Alt + `）。
 * 窗口已经没了，相位不能还挂在 quickbar —— 那样卡片无处安放，看起来像导览卡死。
 */
export function noticeQuickbarClosed(): void {
  if (currentPhase() !== "quickbar") return;
  restoreAutoHide();
  publish({ phase: "main" });
}

/** 换到别的步时清掉「进速览失败」的记录，让下次经过还能再试一次 */
export function clearTourFailure(): void {
  if (stage.failedStep !== null) publish({ failedStep: null });
}
