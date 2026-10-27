import {
  LogicalPosition,
  PhysicalSize,
  currentMonitor,
  getCurrentWindow,
  primaryMonitor,
} from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { syncQuickbarMinSize } from "../state/fontStore";
import { ipc } from "./ipc";

/** 窗口顶边离屏幕工作区顶边多近算「吸顶」（逻辑像素） */
const DOCK_TOLERANCE = 5;
/** 防误触：吸顶判定、靠近判定都要稳定这么久才真正切换（毫秒） */
const SETTLE_MS = 100;
/** 刚收起后的冷却：拖动结束时鼠标往往还压在窗口上，避免立刻又弹回来（毫秒） */
const REVEAL_COOLDOWN_MS = 350;
/**
 * 失焦收起后的宽限期（毫秒）：这段时间内不响应「靠近展开」，
 * 否则「点到别的软件 → 立刻收起」后鼠标还没离开就会又弹开。
 * 过了这段时间，**即使窗口没有焦点也要能靠近展开**——细线是常驻置顶的入口，
 * 用户从别的软件里回来时不应该还得先点一下。
 */
const REVEAL_AFTER_BLUR_MS = 600;
/** 收起 / 展开的窗口动画时长（毫秒） */
const ANIM_MS = 200;
/**
 * 提示条收成细线的时长（毫秒）。
 * 比普通展开 / 收起长一点：这一段是「提示行向上滑走 + 窗口变矮 + 底色变透明」三件事
 * 同时收尾，太快就又变成「被一刀切掉」了。
 */
const RETRACT_MS = 260;
/**
 * 收起后分两个阶段：
 * - hint：34px，抓手 + 一行提示（告诉用户快捷键），停留一小会儿；
 * - bar：12px，只剩最上面一条 5px 的横线（带约 7px 的鼠标感应余量）。
 *
 * 注意：窗口不能再矮了——Windows 对外框有个下限（约 10 物理像素起），
 * 而且细线还得能接住鼠标。所以「看起来 5px」由 CSS 保证（.qb-grip-bar 就是 5px 实心），
 * 窗口留 12 逻辑像素，其中多出来的部分是透明的、专门给指针当靶子。
 */
export const DOCK_HEIGHT_HINT = 34;
export const DOCK_HEIGHT_BAR = 12;
/** 横线高度（逻辑像素）：CSS 里 .qb-grip-bar 用 clamp() 按 DPI/分辨率微调，这里只是文档说明 */
export const DOCK_BAR_LINE = 5;
/**
 * 提示行停留多久后收成一条横线（毫秒）。
 * 每次露出来都只亮这么一下就收掉——鼠标路过时也能看清快捷键，但不会一直占着屏幕。
 */
const HINT_HOLD_MS = 1000;
/** 鼠标移出窗口后，静置多久自动收回（毫秒） */
const RECALL_IDLE_MS = 900;
/** 快捷键 Alt + `（物理键位 Backquote，Shift 按下时 key 为 ~，两个都认） */
const HOTKEY_CODE = "Backquote";

/** 快捷键展示文案，供界面提示复用 */
export const TOP_BAR_HOTKEY = "Alt + `";

/**
 * 收起后的三个阶段：
 * - hint：带提示行；
 * - retract：提示行向上滑走、底色淡成透明的过渡态（窗口同时在变矮）；
 * - bar：只剩最上面一条横线。
 */
export type DockPhase = "hint" | "retract" | "bar";
export interface QuickbarDockState {
  /** 整个速览窗口是否已经收起成屏幕顶端的一条 */
  docked: boolean;
  /**
   * 收起 / 展开动画进行时把内容高度钉住（逻辑像素）。
   * 窗口高度在动，内容不跟着压缩，看起来就是「被卷起来 / 放下来」而不是被压扁。
   */
  contentHeight: number | null;
  /** 收起后的阶段：带提示 / 只剩横线 */
  phase: DockPhase;
  /** 收成横线时的窗口尺寸（逻辑像素）；未处于该阶段时为 null */
  bar: { width: number; height: number } | null;
}

/** 原生侧「光标落到细线感应带里」的事件（见 src-tauri/src/window_dock.rs） */
const DOCK_NEAR_EVENT = "quickbar://dock-near";

/** 当前激活的「立即还原」句柄：一个进程里同时只有一个速览界面 */
let activeRestore: (() => Promise<void>) | null = null;

/** 当前激活的「接管收起态」句柄：进入速览时窗口已经收成顶部一条，由它接上状态机 */
let activeAdoptDock: ((widthPhys: number, heightPhys: number) => Promise<void>) | null = null;

/**
 * 当前激活的「贴顶最小化」句柄：返回 true 表示它自己处理完了，
 * 调用方就不要再调系统的 minimize。
 */
let activeMinimize: (() => Promise<boolean>) | null = null;

/** 内容卷走（然后窗口直接消失）的时长（毫秒） */
const MINIMIZE_FADE_MS = 160;

/**
 * 速览右上角那个「最小化」按钮走这里。
 *
 * 只有窗口贴在屏幕顶边时才自己接管：先把内容卷走（看起来是「收起来」），
 * 再把窗口一步压成细线，然后关掉这个窗口的 DWM 过渡并真最小化——
 * 这样就没有「从一根细线飞到任务栏」那一段；还原时窗口也是原地直接出现，
 * 不带从任务栏「放大」回来的动画。
 *
 * 不在顶边就返回 false，让调用方走系统默认最小化（正常窗口的动画是好看的）。
 */
export async function minimizeQuickbar(): Promise<boolean> {
  return (await activeMinimize?.()) ?? false;
}

/** 退出速览 / 进入速览前调用：窗口如果还收起着，立刻还原成展开状态 */
export async function restoreQuickbarDock(): Promise<void> {
  await activeRestore?.();
}

/**
 * 进入速览时由按钮触发：窗口已经形变到「屏幕顶部的一条」，这里把收起态接管过来，
 * 并记下展开时要还原的速览尺寸（物理像素）。
 *
 * 挂钩子需要等 QuickBar 挂载完，这里做一小段轮询，避免进入太快时丢掉这次收起。
 */
export async function adoptQuickbarDock(widthPhys: number, heightPhys: number): Promise<void> {
  for (let i = 0; i < 24 && !activeAdoptDock; i++) {
    await new Promise<void>((r) => setTimeout(r, 25));
  }
  await activeAdoptDock?.(widthPhys, heightPhys);
}

export function useQuickbarDock(enabled: boolean): QuickbarDockState {
  const [docked, setDocked] = useState(false);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [phase, setPhase] = useState<DockPhase>("hint");
  const [bar, setBar] = useState<{ width: number; height: number } | null>(null);
  const dockedRef = useRef(false);
  const phaseRef = useRef<DockPhase>("hint");

  useEffect(() => {
    if (!enabled) {
      dockedRef.current = false;
      phaseRef.current = "hint";
      setDocked(false);
      setPhase("hint");
      setBar(null);
      setContentHeight(null);
      return;
    }

    const win = getCurrentWindow();
    let alive = true;
    let unlisten: (() => void) | undefined;
    let unlistenFocus: (() => void) | undefined;
    let unlistenNear: (() => void) | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    let recallTimer: ReturnType<typeof setTimeout> | undefined;
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    let raf: number | undefined;
    /** 动画兜底完成定时器：最小化时 rAF 停发，靠它把动画收尾（见 animateHeight） */
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    /** 收起前窗口的客户区尺寸（物理像素），展开时原样还原 */
    let restoreSize: { width: number; height: number } | null = null;
    /**
     * 几何锁：所有会改窗口几何的操作都要先拿它。
     * 原来只靠 `animating`，但 `measure()` 之类的异步调用可能刚好卡在
     * 「animating 还是 false、但 mutate 已经发出去了」的窗口期，两边一起改几何就会互相打架，
     * 表现为「收起来后等一下再展开卡住」。现在改成同一时刻只允许一个 mutate 在跑。
     */
    let mutating = false;
    let animating = false;
    let lastChangeAt = 0;
    /** 这次展开是鼠标靠近触发的（不是用户拖 / 按键），鼠标一走就该自动收回 */
    let hoverExpanded = false;
    /**
     * 「鼠标靠近就展开」是否已解锁。刚从完整界面收进来时是 false：
     * 点完按钮鼠标往往就压在那条上，不解锁的话一动就会立刻弹开，白收一次。
     * 指针离开过一次、或点一下那条，才解锁；按键展开不受影响。
     */
    let hoverArmed = true;
    /** 指针是否还在窗口里 */
    let pointerInside = false;
    /**
     * 上一次失焦的时刻（毫秒）。失焦还没到 REVEAL_AFTER_BLUR_MS 时不响应靠近展开——
     * 否则「点到别的软件 → 立刻收起」之后鼠标还压在窗口上会马上又弹开。
     * 注意不能直接拿「当前有没有焦点」当门控：那样一来在别的软件里用鼠标划过细线
     * 永远不会展开，等于把常驻入口废掉了。
     */
    let blurredAt = 0;
    /** 是不是我们关掉了这个窗口的 DWM 过渡（还原后要开回去） */
    let transitionsOff = false;

    const setPhaseBoth = (next: DockPhase) => {
      phaseRef.current = next;
      setPhase(next);
    };

    const clearSettle = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = undefined;
    };
    const clearReveal = () => {
      if (revealTimer) clearTimeout(revealTimer);
      revealTimer = undefined;
    };
    const clearRecall = () => {
      if (recallTimer) clearTimeout(recallTimer);
      recallTimer = undefined;
    };

    const stopAnim = () => {
      if (raf !== undefined) cancelAnimationFrame(raf);
      raf = undefined;
      if (finishTimer) {
        clearTimeout(finishTimer);
        finishTimer = undefined;
      }
      animating = false;
    };

    /**
     * 当前窗口的客户区（inner）尺寸与缩放。
     * 注意：Windows 上 setSize 设置的是客户区，而 outerSize 是含边框的外框，
     * 两者差一个恒定的边框宽度 —— 必须始终用 innerSize 记录与还原，否则每次
     * 收起/展开窗口都会变宽一圈。
     */
    const currentPhys = async () => {
      const [size, scale] = await Promise.all([win.innerSize(), win.scaleFactor()]);
      return { scale, size };
    };

    /**
     * 用 0.2s 缓动把窗口高度（物理像素）推到目标值，宽度保持不变。
     * 细线阶段窗口只是变矮，宽度和水平位置都跟速览展开时一致——
     * 这样「收起来在哪、多宽」用户是有预期的，不会出现线跑到屏幕中间的问题。
     *
     * 卡死防护（「最小化再恢复后窗口卡住不动」的根因）：窗口最小化 / 被完全遮挡时
     * WebView2 会停发 rAF，动画永远走不到 done，animating 就一直是 true——
     * 之后所有收起 / 展开 / 长回提示全被它拒掉，窗口彻底失去响应。
     * 所以：页面不可见时直接落到终态；可见时也挂一道 setTimeout 兜底
     * （后台标签页定时器会被钳到 ~1s，正好够用），保证 animating 一定会释放。
     */
    const animateHeight = (
      fromH: number,
      toH: number,
      widthPhys: number,
      done: () => void,
      durationMs: number = ANIM_MS,
    ) => {
      stopAnim();
      animating = true;
      const start = performance.now();
      let settled = false;
      const finish = (writeFinal: boolean) => {
        if (settled) return;
        settled = true;
        if (raf !== undefined) {
          cancelAnimationFrame(raf);
          raf = undefined;
        }
        if (finishTimer) {
          clearTimeout(finishTimer);
          finishTimer = undefined;
        }
        animating = false;
        if (writeFinal) {
          // 兜底路径也把最终几何写一次，保证窗口和状态机一致
          void win.setSize(new PhysicalSize(Math.max(1, widthPhys), Math.max(1, toH))).catch(() => {
            /* 最小化 / 拖动中会失败，恢复后由状态机自愈 */
          });
        }
        done();
      };
      finishTimer = setTimeout(() => finish(true), durationMs + 800);
      const step = () => {
        raf = undefined;
        if (!alive || settled) return;
        if (document.visibilityState === "hidden") {
          finish(true);
          return;
        }
        const t = Math.min(1, (performance.now() - start) / durationMs);
        const eased = 1 - Math.pow(1 - t, 3);
        const h = Math.round(fromH + (toH - fromH) * eased);
        void win.setSize(new PhysicalSize(Math.max(1, widthPhys), Math.max(1, h))).catch(() => {
          /* 窗口正在被拖动时偶尔会失败，忽略即可 */
        });
        if (t < 1) {
          raf = requestAnimationFrame(step);
          return;
        }
        finish(false);
      };
      raf = requestAnimationFrame(step);
    };

    /**
     * 细线阶段窗口只剩十几像素高，双击标题栏会被系统放大到整屏，
     * 所以收成细线时关掉「可调整大小」，展开时再开回来。
     */
    const shrinkWindowHints = () => {
      void win.setResizable(false).catch(() => {});
    };
    const restoreWindowHints = () => {
      void win.setResizable(true).catch(() => {});
    };

    /** 收起后先停在带提示的高度，停留一小会儿再收成一条横线 */
    const scheduleShrink = () => {
      if (hintTimer) clearTimeout(hintTimer);
      clearReveal();
      hintTimer = setTimeout(() => {
        hintTimer = undefined;
        void shrinkToBar();
      }, HINT_HOLD_MS);
    };

    const shrinkToBar = async () => {
      if (animating || mutating || !dockedRef.current || phaseRef.current !== "hint") return;
      mutating = true;
      try {
        const s = await win.scaleFactor();
        const from = Math.round(DOCK_HEIGHT_HINT * s);
        const to = Math.round(DOCK_HEIGHT_BAR * s);
        const widthPhys = restoreSize?.width ?? Math.round(414 * s);
        if (!alive || !dockedRef.current || phaseRef.current !== "hint") return;
        // 细线高度按「工作区屏高的 0.45%」取整（4~10px）。CSS 里的 vh 用不了：
        // 收起后窗口视口只有 12px，vh 恒等于 0。拿到屏幕高度失败就保持默认 5px。
        try {
          const mon = await currentMonitor();
          const workH = mon?.workArea?.size?.height;
          if (workH) {
            const lineH = Math.min(10, Math.max(4, Math.round((workH / s) * 0.0045)));
            document.documentElement.style.setProperty("--dock-line-h", `${lineH}px`);
          }
        } catch {
          /* 保持 CSS 默认值 */
        }
        shrinkWindowHints();
        // 不要「啪」地直接跳到 bar：先进入 retract 阶段——提示行向上滑走并淡出、
        // 底色与边框同时淡成透明（见 app.css 的 data-dock-phase="retract"），
        // 窗口高度用同样的时长收到细线，落地后才算 bar。
        setPhaseBoth("retract");
        lastChangeAt = Date.now();
        animateHeight(
          from,
          to,
          widthPhys,
          () => {
            if (!alive) return;
            setPhaseBoth("bar");
            setBar({ width: Math.round(widthPhys / s), height: DOCK_HEIGHT_BAR });
            // 收成横线说明这一轮收起彻底结束了：解锁「靠近就展开」。
            // 只靠「指针离开过一次」解锁是不够的——刚点完速览按钮时鼠标往往压在那条上，
            // 但它其实从来没「进入」过收起后的窗口，也就永远等不到离开，划上去不会弹开。
            hoverArmed = true;
            // 细线只有几像素高，鼠标几乎碰不到——交给原生侧的光标感应带
            void ipc.setDockSensor(true).catch(() => {});
          },
          RETRACT_MS,
        );
      } finally {
        mutating = false;
      }
    };

    const collapse = async () => {
      if (animating || mutating || dockedRef.current) return;
      mutating = true;
      try {
        const { scale, size } = await currentPhys();
        const dockPhys = Math.round(DOCK_HEIGHT_HINT * scale);
        const barPhys = Math.round(DOCK_HEIGHT_BAR * scale);
        if (!alive) return;
        if (size.height <= dockPhys + 8) {
          // 窗口已经在提示条高度以内（正常收起后、或某次几何被系统吞掉）：
          // 不要再走一遍动画，直接把状态接回去。否则会留下「状态说展开、窗口只有一条线」
          // 的死局——那种状态下点它、划过它都进不了任何分支，只能杀进程。
          // 注意别动 restoreSize：现在量到的是细线高度，拿它当还原尺寸会把窗口还原成一条线。
          dockedRef.current = true;
          setDocked(true);
          setContentHeight(null);
          lastChangeAt = Date.now();
          if (size.height <= barPhys + 8) {
            setPhaseBoth("bar");
            setBar({
              width: Math.round(size.width / scale),
              height: DOCK_HEIGHT_BAR,
            });
            hoverArmed = true;
            void ipc.setDockSensor(true).catch(() => {});
          } else {
            setPhaseBoth("hint");
            setBar(null);
            scheduleShrink();
          }
          return;
        }
        restoreSize = { width: size.width, height: size.height };
        // 收起后窗口远小于速览的最小尺寸限制（要放得下右键菜单），先解除
        await win.setMinSize(null).catch(() => {});
        setContentHeight(size.height / scale);
        lastChangeAt = Date.now();
        animateHeight(size.height, dockPhys, size.width, () => {
          if (!alive) return;
          dockedRef.current = true;
          setDocked(true);
          setContentHeight(null);
          setPhaseBoth("hint");
          // 提示行只显示一小会儿，之后收成横线
          scheduleShrink();
        });
      } finally {
        mutating = false;
      }
    };

    const expand = async (byHover = false) => {
      if (animating || mutating || !dockedRef.current) return;
      mutating = true;
      try {
        if (hintTimer) {
          clearTimeout(hintTimer);
          hintTimer = undefined;
        }
        const scale = await win.scaleFactor();
        const widthPhys = restoreSize?.width ?? Math.round(414 * scale);
        const toH = restoreSize?.height ?? Math.round(1000 * scale);
        const wasBar = phaseRef.current === "bar";
        const fromH = wasBar ? Math.round(DOCK_HEIGHT_BAR * scale) : Math.round(DOCK_HEIGHT_HINT * scale);
        if (!alive || !dockedRef.current) return;
        void ipc.setDockSensor(false).catch(() => {});
        restoreWindowHints();
        dockedRef.current = false;
        setDocked(false);
        setPhaseBoth("hint");
        setBar(null);
        setContentHeight(toH / scale);
        lastChangeAt = Date.now();
        hoverExpanded = byHover;
        animateHeight(fromH, toH, widthPhys, () => {
          if (!alive) return;
          setContentHeight(null);
          // 展开完毕再恢复「放得下右键菜单」的最小尺寸限制
          void syncQuickbarMinSize();
          // 鼠标已经不在窗口里的话，静置一会儿自动收回
          if (hoverExpanded && !pointerInside) scheduleRecall();
        });
      } finally {
        mutating = false;
      }
    };

    /** 收起状态下先长回带提示的高度（顺便再告诉一次快捷键），随后展开 */
    const growToHint = (then: () => void) => {
      if (animating || mutating || !dockedRef.current || phaseRef.current === "hint") {
        then();
        return;
      }
      mutating = true;
      void win
        .scaleFactor()
        .then((scale) => {
          if (!alive || !dockedRef.current || phaseRef.current !== "bar") return;
          const from = Math.round(DOCK_HEIGHT_BAR * scale);
          const to = Math.round(DOCK_HEIGHT_HINT * scale);
          const wide = restoreSize?.width ?? Math.round(414 * scale);
          setPhaseBoth("hint");
          setBar(null);
          restoreWindowHints();
          void ipc.setDockSensor(false).catch(() => {});
          animateHeight(from, to, wide, () => then());
        })
        .finally(() => {
          mutating = false;
        });
    };

    /**
     * 鼠标靠近收起条并停留 100ms 才展开。
     * near 为 true 表示光标落在原生侧的感应带里（细线只有几像素高，鼠标实际没进窗口）。
     */
    const reveal = (near = false) => {
      if (revealTimer) return;
      revealTimer = setTimeout(() => {
        revealTimer = undefined;
        if (!alive || !dockedRef.current || animating || mutating) return;
        // 刚失焦收起的这一小会儿鼠标可能还压在窗口上：先别弹开，过了宽限期照常展开
        if (!hoverArmed || Date.now() - blurredAt < REVEAL_AFTER_BLUR_MS) return;
        if (!near && !pointerInside) return;
        if (Date.now() - lastChangeAt < REVEAL_COOLDOWN_MS) return;
        void expand(true);
      }, SETTLE_MS);
    };

    /** 鼠标移出窗口且没做任何操作 → 静置后自动收回（窗口还贴在顶部才收） */
    const scheduleRecall = () => {
      clearRecall();
      recallTimer = setTimeout(() => {
        recallTimer = undefined;
        if (!alive || dockedRef.current || animating) return;
        if (!hoverExpanded || pointerInside) return;
        void evaluate();
      }, RECALL_IDLE_MS);
    };

    /** 用户真的在用它了：取消「移开就收回」 */
    const markEngaged = () => {
      hoverExpanded = false;
      clearRecall();
    };

    /** 立即回到展开状态（退出速览 / 关闭开关时用，不带动画） */
    const restoreNow = async () => {
      stopAnim();
      mutating = false;
      if (hintTimer) {
        clearTimeout(hintTimer);
        hintTimer = undefined;
      }
      void ipc.setDockSensor(false).catch(() => {});
      restoreWindowHints();
      if (!dockedRef.current) {
        setContentHeight(null);
        setBar(null);
        return;
      }
      const scale = await win.scaleFactor();
      const widthPhys = restoreSize?.width ?? Math.round(414 * scale);
      const toH = restoreSize?.height ?? Math.round(1000 * scale);
      // 退出速览前把窗口尺寸还原成速览展开时的尺寸（细线阶段高度是 12px）
      const fullscreen = await win.isFullscreen().catch(() => false);
      if (!fullscreen) void win.setSize(new PhysicalSize(widthPhys, toH)).catch(() => {});
      dockedRef.current = false;
      setDocked(false);
      setPhaseBoth("hint");
      setBar(null);
      setContentHeight(null);
      try {
        if (fullscreen) return;
        await syncQuickbarMinSize();
      } catch {
        /* 窗口几何拿不到就算了，退出速览时会还原 */
      }
    };
    activeRestore = restoreNow;

    /**
     * 接管「已经收成一条」的窗口（进入速览时由按钮触发）：
     * 窗口几何已经到位，这里只补上状态——展开时按传入的速览尺寸还原，
     * 并锁住 hover 展开，免得点完按钮鼠标一动就弹开。
     */
    const adoptDock = async (widthPhys: number, heightPhys: number) => {
      stopAnim();
      mutating = false;
      if (hintTimer) {
        clearTimeout(hintTimer);
        hintTimer = undefined;
      }
      restoreSize = { width: widthPhys, height: heightPhys };
      await win.setMinSize(null).catch(() => {});
      dockedRef.current = true;
      lastChangeAt = Date.now();
      hoverExpanded = false;
      hoverArmed = false;
      setDocked(true);
      setContentHeight(null);
      setPhaseBoth("hint");
      setBar(null);
      scheduleShrink();
    };
    activeAdoptDock = adoptDock;

    /**
     * 贴顶时接管「最小化」：内容卷走 → 窗口一步收成细线 → 关 DWM 过渡 → 真最小化。
     * 收成细线是为了让「还原」这一步直接落在那条透明抓手栏上，而不是先弹出一整块面板。
     */
    const minimizeAtTop = async (): Promise<boolean> => {
      if (mutating || animating) return false;
      const m = await measure();
      if (!alive || !m?.near) return false;
      mutating = true;
      try {
        // 1) 内容卷走（CSS），观感上就是「收起来」
        document.body.classList.add("qb-minimizing");
        await new Promise<void>((r) => setTimeout(r, MINIMIZE_FADE_MS));
        if (!alive) {
          document.body.classList.remove("qb-minimizing");
          return true;
        }
        // 2) 窗口一步落到细线，并把收起态接过来：还原时就是这条抓手栏
        const { scale, size } = await currentPhys();
        const barPhys = Math.round(DOCK_HEIGHT_BAR * scale);
        if (size.height > barPhys + 8) {
          restoreSize = { width: size.width, height: size.height };
          await win.setMinSize(null).catch(() => {});
          await win
            .setSize(new PhysicalSize(Math.max(1, size.width), Math.max(1, barPhys)))
            .catch(() => {});
        }
        dockedRef.current = true;
        lastChangeAt = Date.now();
        hoverExpanded = false;
        // 还原回来时鼠标往往还在原来那条线上，解锁才划得开
        hoverArmed = true;
        setDocked(true);
        setContentHeight(null);
        setPhaseBoth("bar");
        setBar({ width: Math.round(size.width / scale), height: DOCK_HEIGHT_BAR });
        // 内容已经换成细线了，这时才摘掉卷走标记：早摘会有一帧「面板又亮回来」
        document.body.classList.remove("qb-minimizing");
        shrinkWindowHints();
        void ipc.setDockSensor(true).catch(() => {});
        // 3) 关掉这个窗口的 DWM 过渡再真最小化：不播「飞到任务栏」
        await ipc.setWindowTransitions(true).catch(() => {});
        transitionsOff = true;
        await win.minimize().catch(() => {});
        return true;
      } finally {
        mutating = false;
      }
    };

    /**
     * 量一次窗口相对当前显示器工作区顶边的位置。拿不到几何（正在拖动 / 重建 / 最小化）时返回 null。
     * 最大化 / 全屏时顶边贴屏是系统行为，不算吸顶。
     *
     * 最小化必须当「拿不到」处理：Windows 会把窗口挪到 -32000,-32000，
     * 这看起来就是「离顶边十万八千里」，于是 evaluate 会误判成「被拖走了」→ 解除吸顶 → 展开。
     * 但最小化时 setSize 是无效的，展开的尺寸写不进去，状态机却已经变成「未吸顶、已展开」，
     * 结果窗口永远停在一条 15px 细线上，点它、划它都不再有反应（0.8.23 的真实卡死现场）。
     */
    const measure = async () => {
      try {
        const [pos, maximized, fullscreen, minimized, current, primary, scale] = await Promise.all([
          win.outerPosition(),
          win.isMaximized(),
          win.isFullscreen(),
          win.isMinimized(),
          currentMonitor(),
          primaryMonitor(),
          win.scaleFactor(),
        ]);
        if (!alive || maximized || fullscreen || minimized) return null;
        // 最小化 / 刚恢复的那一帧可能还留着 -32000 这种哨兵值
        if (pos.y < -1000 || pos.x < -1000) return null;
        const monitor = current ?? primary;
        const edge = monitor?.workArea?.position?.y ?? monitor?.position?.y;
        if (edge === undefined) return null;
        const top = pos.y / scale;
        const near = top - edge <= DOCK_TOLERANCE && top - edge >= -DOCK_TOLERANCE * 3;
        return { near, edge, x: Math.round(pos.x / scale) };
      } catch {
        /* 拖动 / 重建窗口期间拿不到几何信息，忽略这一帧 */
        return null;
      }
    };

    /** 展开时窗口该有多高（物理像素）：没记录过还原尺寸就没法判断，交给调用方跳过 */
    const expectedExpandHeight = () => restoreSize?.height ?? 0;

    /**
     * 自愈：状态机说「已经展开」，但窗口实际还是一条细线 / 提示条的高度
     * —— 说明那次改几何被系统吞掉了（最小化、正在被拖动、WebView2 停发 rAF 都可能）。
     * 不补这一下，窗口就会永远卡在十几像素高：点它、划过它都进不了任何分支，
     * 只能杀进程重开。这里把展开尺寸补写一次。
     */
    const healGeometry = async () => {
      if (!alive || dockedRef.current || animating || mutating) return;
      // 没记录过「收起前的展开尺寸」就无从判断，宁可不动
      if (!restoreSize) return;
      try {
        const [size, minimized] = await Promise.all([win.innerSize(), win.isMinimized()]);
        if (!alive || dockedRef.current || minimized) return;
        const want = expectedExpandHeight();
        if (!want) return;
        // 细线（12）/ 提示条（34）都远小于展开高度，用一半当阈值，不会误伤正常窗口
        if (size.height >= want * 0.5) return;
        const widthPhys = restoreSize.width;
        restoreWindowHints();
        await win.setSize(new PhysicalSize(widthPhys, want)).catch(() => {});
        void syncQuickbarMinSize();
      } catch {
        /* 拿不到几何就等下一次重试 */
      }
    };

    /** 判断窗口是否贴在当前显示器工作区（排除任务栏）的顶边 */
    const evaluate = async () => {
      const m = await measure();
      if (!alive || !m) return;
      const { near, edge, x: left } = m;
      if (!near) {
        if (!dockedRef.current) return;
        if (settleTimer) return;
        // 「离开顶边」不能只看一帧：拖动中每帧位置都在变，最小化 / 恢复的瞬间还会冒出
        // -32000 这种假位置。等它稳住 SETTLE_MS 之后再量一次，确认真的不在顶边才解除吸顶。
        settleTimer = setTimeout(() => {
          settleTimer = undefined;
          void (async () => {
            if (!alive || animating || mutating || !dockedRef.current) return;
            // 别在用户还拖着的时候改几何：两边一起 setSize / setPosition 会互相打架
            if (document.body.classList.contains("is-dragging")) return;
            const again = await measure();
            if (!alive || !again || again.near || !dockedRef.current) return;
            await expand();
            // 拖动中被吞掉的尺寸补一次，避免「解除了吸顶但窗口还是细线高」。
            // 等动画跑完再量，否则量到的是中间高度。
            setTimeout(() => void healGeometry(), ANIM_MS + 150);
          })();
        }, SETTLE_MS);
        return;
      }
      if (dockedRef.current) return;
      if (settleTimer) return;
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        if (!alive || animating || mutating || dockedRef.current) return;
        // 收起前把窗口稍微对齐到顶边，避免抓手被拖到屏幕外看不见
        void win
          .setPosition(new LogicalPosition(left, Math.round(edge)))
          .catch(() => {})
          .then(() => void collapse());
      }, SETTLE_MS);
    };

    /**
     * 窗口失焦（鼠标点到别的软件）：速览还展开着、且贴在屏幕顶部 → 立刻收成一条，
     * 不要一直摊在屏幕上挡着别的窗口。
     */
    const onFocusChange = ({ payload: focused }: { payload: boolean }) => {
      if (!alive) return;
      if (focused) {
        // 从最小化 / 别的软件回来：把可能被吞掉的尺寸补回来
        void healGeometry();
        // 还原这一下已经落地了，把 DWM 过渡开回去（留一点余量，别让还原又动起来）
        if (transitionsOff) {
          setTimeout(() => {
            if (!alive) return;
            transitionsOff = false;
            void ipc.setWindowTransitions(false).catch(() => {});
          }, 300);
        }
        return;
      }
      blurredAt = Date.now();
      if (dockedRef.current || animating) return;
      void measure().then((m) => {
        if (!alive || !m?.near || dockedRef.current || animating) return;
        // 鼠标已经到别的窗口去了：解锁「靠近就展开」，回来时正常弹开，不用先点一下
        hoverArmed = true;
        void collapse();
      });
    };

    // 指针在窗口内移动：收起时靠近展开；展开时取消「移开就收回」
    const onPointerMove = () => {
      pointerInside = true;
      clearRecall();
      if (!dockedRef.current) return;
      if (animating || !hoverArmed || Date.now() - blurredAt < REVEAL_AFTER_BLUR_MS) return;
      if (phaseRef.current === "bar") {
        // 长回提示高度后也要重新计时：万一这次没展开（冷却中 / 未解锁），
        // 提示条不会一直挂在屏幕上，1 秒后照样收成横线。
        growToHint(() => {
          scheduleShrink();
          reveal(true);
        });
        return;
      }
      reveal();
    };

    /**
     * 原生侧报告「光标落到细线感应带里」。细线只有几像素高，鼠标基本进不来，
     * 这条路径是收成细线后唯一的展开入口（连同 Alt+` 和点击）。
     */
    const onDockNear = () => {
      if (!alive || !dockedRef.current || animating || mutating) return;
      if (!hoverArmed || Date.now() - blurredAt < REVEAL_AFTER_BLUR_MS) return;
      if (phaseRef.current === "bar") {
        growToHint(() => {
          scheduleShrink();
          reveal(true);
        });
        return;
      }
      reveal(true);
    };

    // 指针离开窗口：如果是「靠近展开」的，静置一会儿自动收回
    const onPointerLeave = () => {
      pointerInside = false;
      // 指针离开过一次，之后「靠近展开」才生效
      hoverArmed = true;
      clearReveal();
      if (dockedRef.current || !hoverExpanded) return;
      scheduleRecall();
    };

    const onEngage = () => {
      // 收成一条时点它就展开（等同于用鼠标把它拉下来）
      if (dockedRef.current) {
        hoverArmed = true;
        void expand();
        return;
      }
      // 点击 / 输入 / 键盘操作都算「在用」，不再自动收回
      markEngaged();
      // 万一状态说展开、窗口却还是细线高（几何被系统吞掉），点一下就能救回来
      void healGeometry();
    };

    // Alt + ` 收起 / 展开
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || !e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.code !== HOTKEY_CODE && e.key !== "`" && e.key !== "~") return;
      e.preventDefault();
      markEngaged();
      if (animating) return;
      if (dockedRef.current) void expand();
      else void collapse();
    };

    document.addEventListener("pointermove", onPointerMove, true);
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
    document.addEventListener("mouseleave", onPointerLeave);
    document.addEventListener("pointerdown", onEngage, true);
    window.addEventListener("keydown", onKeyDown);
    // 拖动结束（useWindowDrag 派发）：松手后没有新的 move 事件，这里补一次判定
    const onDragEnd = () => {
      if (!alive) return;
      void evaluate();
      setTimeout(() => void healGeometry(), 120);
    };
    window.addEventListener("zfm:window-drag-end", onDragEnd);
    void win
      .onMoved(() => {
        clearSettle();
        void evaluate();
      })
      .then((un) => {
        if (alive) unlisten = un;
        else un();
      })
      .catch(() => {
        /* 拿不到移动事件时退化为 Alt+` 手动收起 */
      });
    void win
      .onFocusChanged(onFocusChange)
      .then((un) => {
        if (alive) unlistenFocus = un;
        else un();
      })
      .catch(() => {
        /* 拿不到焦点事件就只是「点到别处不自动收起」，不影响其他行为 */
      });
    void listen(DOCK_NEAR_EVENT, () => onDockNear())
      .then((un) => {
        if (alive) unlistenNear = un;
        else un();
      })
      .catch(() => {
        /* 拿不到感应事件时，鼠标直接压到窗口上仍然能展开 */
      });
    void evaluate();
    activeMinimize = minimizeAtTop;

    return () => {
      alive = false;
      stopAnim();
      clearSettle();
      clearReveal();
      clearRecall();
      if (hintTimer) clearTimeout(hintTimer);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("mouseleave", onPointerLeave);
      document.removeEventListener("pointerdown", onEngage, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("zfm:window-drag-end", onDragEnd);
      unlisten?.();
      unlistenFocus?.();
      unlistenNear?.();
      void ipc.setDockSensor(false).catch(() => {});
      if (activeRestore === restoreNow) activeRestore = null;
      if (activeAdoptDock === adoptDock) activeAdoptDock = null;
      if (activeMinimize === minimizeAtTop) activeMinimize = null;
      if (transitionsOff) {
        transitionsOff = false;
        void ipc.setWindowTransitions(false).catch(() => {});
      }
    };
  }, [enabled]);

  return { docked, contentHeight, phase, bar };
}
