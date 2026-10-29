import {
  LogicalPosition,
  PhysicalPosition,
  PhysicalSize,
  currentMonitor,
  cursorPosition,
  getCurrentWindow,
  primaryMonitor,
} from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { syncQuickbarMinSize, useFontStore } from "../state/fontStore";
import { matchesHotkey } from "./hotkey";
import { ipc } from "./ipc";
import { createSerialQueue, leadNormalized } from "./quickbarAnim";
import { morphWindow } from "./windowMorph";

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
 * 收成细线时「提示条滑出屏幕 / 细线落回画面」的时长（毫秒）。
 *
 * 以前是窗口原地变矮 + 内容淡出，两个毛病：内容被从底部一刀裁掉；窗口高度跨过
 * DWM 的圆角阈值时四角会从圆角跳成直角。改成整块往上滑出屏幕后，圆角是「滑走」
 * 而不是「变形」，也不裁内容。
 */
const RETRACT_OUT_MS = 180;
const RETRACT_IN_MS = 160;
/** 屏幕外换内容后的等待（毫秒）：给 React 一帧时间把细线画出来 */
const BAR_SWAP_MS = 70;
/** 滑出时多走这么多像素，确保整窗真的在屏幕外（外框比客户区高一点） */
const OFFSCREEN_PAD = 24;
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
/**
 * 热键呼出后的观察期（毫秒）：面板弹出来先给用户看一眼，
 * 这段时间内鼠标没进面板就自动收起——避免「按了一下键，屏幕顶上一直摊着一块」。
 * 鼠标进来了就转成正常模式：之后按「移出静置自动收起」的规则走。
 */
const HOTKEY_HOLD_MS = 1000;
/**
 * 快捷键文案不再写死：用户可以在设置里改成别的组合（见 lib/hotkey.ts），
 * 这里保留一个默认值给「还没读到偏好」的极短窗口用。
 */
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

/** 原生侧「系统级 Alt+` 被按下」的事件（RegisterHotKey，跟焦点无关） */
const GLOBAL_HOTKEY_EVENT = "quickbar://hotkey";

/** 当前激活的「立即还原」句柄：一个进程里同时只有一个速览界面 */
let activeRestore: (() => Promise<void>) | null = null;

/** 当前激活的「立刻展开成完整面板」句柄（全局热键从完整界面切进来时用） */
let activeExpand: (() => Promise<void>) | null = null;

/**
 * 立刻把速览面板展开（如果正收成顶部一条）。
 * 全局 Alt+` 从「完整界面」切进速览时用：进入动作本身是把窗口收成一条，
 * 用户按快捷键的意图显然是「把面板叫出来」，所以要紧接着展开。
 */
export async function expandQuickbarPanel(): Promise<void> {
  await activeExpand?.();
}

/** 当前激活的「接管收起态」句柄：进入速览时窗口已经收成顶部一条，由它接上状态机 */
let activeAdoptDock: ((widthPhys: number, heightPhys: number) => Promise<void>) | null = null;

/**
 * 当前激活的「贴顶最小化」句柄：返回 true 表示它自己处理完了，
 * 调用方就不要再调系统的 minimize。
 */
let activeMinimize: (() => Promise<boolean>) | null = null;

/**
 * 速览窗口几何是否正被状态机改写（收起/展开动画、收成细线的滑出形变）。
 * 拖动这类也要写窗口位置的操作必须先问一句：两套写入互相覆盖，
 * 窗口最后就停在「拖了一半又跳回去」的坐标上（§5 第 15 条）。
 */
let dockBusyGetter: (() => boolean) | null = null;
export function isQuickbarGeometryBusy(): boolean {
  return dockBusyGetter?.() ?? false;
}

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
  /**
   * 「贴顶自动隐藏」开关。
   *
   * 注意它只门控**自动**行为（贴顶自动收起、失焦自动收起、热键观察期自动收起、
   * 移出静置自动召回）；热键、还原、接管收起态、基础监听全都得留着——
   * 以前是把整个 hook 门控掉（`if (!enabled) return`），关掉开关后速览一进来就
   * 卡在 34px 提示条、热键也失灵，只能杀进程（§5 第 1 条）。
   * 用 ref 读，主 effect 就不用因为开关翻转而整段重建（重建会丢掉收起态和监听）。
   */
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  /**
   * 速览窗口在整个速览期间都用「无系统圆角 + CSS 圆角」：
   *
   * 1. DWM 只给圆角窗口画阴影，而收起态（43px 提示条 / 12px 细线）贴在屏幕顶、
   *    底下就是桌面，那圈阴影会糊出一大片（实测亮度 255→184，一直到 140px 才干净）；
   * 2. 更关键的是**不能跟着 docked 切**：展开时 `docked=false` 会让 CSS 圆角规则失效，
   *    而 DWM 圆角要等 IPC 往返才生效，中间那几帧窗口既没 CSS 圆角也没系统圆角 ——
   *    实测 60fps 抓帧里稳定出现 2 帧直角（主线程忙时能拖到 80 帧），
   *    就是用户看到的「四个角从圆角变直角又变回来」。
   *
   * 所以：进速览关一次系统圆角、CSS 圆角常开（形状全程一致），离开速览再开回来
   * （完整界面保留系统圆角和阴影）。代价是速览内一律没有阴影 —— 和完整界面比是
   * 「速览不投影」，但速览内部展开/收起完全一致，也不再有任何形状跳变。
   */
  /**
   * 速览期间系统圆角保持关闭，退出时也不再打开。
   *
   * 圆角（完整界面和速览）现在全部由 CSS 画（--qb-radius，App 挂载时按
   * 「8 物理像素 / DPR」写入，两个界面同一个来源、弧度必然一致）；
   * DWM 圆角在哪儿都不启用——它自带一圈窗口阴影，而用户要求两个界面
   * 都不要窗口边缘阴影。这里进速览补一道关闭只是防御性的。
   */
  useEffect(() => {
    void ipc.setWindowRounded(false).catch(() => {});
    return () => {
      void ipc.setWindowRounded(false).catch(() => {});
    };
  }, []);

  /**
   * 关掉「贴顶自动隐藏」时把可能已经收起的面板还原回展开尺寸。
   *
   * 这里只做「还原」这一件事：状态机本身（上面的主 effect）不因开关翻转而重建，
   * 否则热键句柄、收起态、原生监听会一起丢掉（§5 第 1 条）。
   */
  useEffect(() => {
    if (enabled) return;
    void activeRestore?.();
  }, [enabled]);

  useEffect(() => {
    const win = getCurrentWindow();
    let alive = true;
    let unlisten: (() => void) | undefined;
    let unlistenFocus: (() => void) | undefined;
    let unlistenNear: (() => void) | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    let recallTimer: ReturnType<typeof setTimeout> | undefined;
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    /** 热键呼出后的观察期定时器 */
    let hotkeyHoldTimer: ReturnType<typeof setTimeout> | undefined;
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
    /**
     * 动画期间发生的「失焦」先记下来，等几何落定再补收起。
     * 以前是 `if (dockedRef.current || animating) return` 直接丢掉：展开动画跑 200ms，
     * 这期间点到别的软件，收尾时就没人再管，面板一直摊在屏幕上（§5 第 4 条）。
     */
    let blurPending = false;
    /**
     * 被冷却 / 宽限期 / 动画挡下来的「靠近」事件。
     * hover 是边沿事件：挡掉这一下就再也不会重来，只能自己排一次重试（§5 第 20 条）。
     */
    let pendingReveal: { near: boolean } | null = null;
    let revealRetryTimer: ReturnType<typeof setTimeout> | undefined;
    /**
     * 热键 toggle 串行链。快速连按时第二下会撞上 `animating/mutating` 被静默丢掉，
     * 现在排队按顺序执行，执行时才读最新的 docked（§5 第 21 条）。
     * 算法在 lib/quickbarAnim.ts（可单测）。
     */
    const toggleQueue = createSerialQueue();

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
    const clearHotkeyHold = () => {
      if (hotkeyHoldTimer) clearTimeout(hotkeyHoldTimer);
      hotkeyHoldTimer = undefined;
    };
    const clearRevealRetry = () => {
      if (revealRetryTimer) clearTimeout(revealRetryTimer);
      revealRetryTimer = undefined;
      pendingReveal = null;
    };
    /** 「自动」行为的开关：只在关掉贴顶自动隐藏时挡住自动收起/召回 */
    const autoHideOn = () => enabledRef.current;

    /**
     * 清掉动画直接写上去的行内几何与标记。
     * 取消动画（stopAnim / 各种 restore 路径）必须一起清：只重置 React 状态的话，
     * `.qb-frame` 会一直钉在中断那一帧的高度上，界面看起来「卡在半截」（§5 第 5 条）。
     */
    const clearFrameDom = () => {
      const el = document.querySelector<HTMLElement>(".qb-frame");
      if (!el) return;
      el.style.height = "";
      el.removeAttribute("data-anim");
    };

    /** 光标此刻是否落在窗口矩形里（热键呼出时鼠标往往不动，只能主动问系统） */
    const cursorInsideWindow = async (): Promise<boolean> => {
      try {
        const [pos, origin, size] = await Promise.all([
          cursorPosition(),
          win.outerPosition(),
          win.outerSize(),
        ]);
        return (
          pos.x >= origin.x &&
          pos.x <= origin.x + size.width &&
          pos.y >= origin.y &&
          pos.y <= origin.y + size.height
        );
      } catch {
        // 拿不到光标位置就保守当「在里面」，宁可多留一会儿也不要误收起
        return true;
      }
    };

    /**
     * 热键呼出后的观察期：1 秒内鼠标没进面板 → 收起；
     * 进来了就转成 hover 展开（之后移出静置再收，和正常路径一致）。
     */
    const armHotkeyHold = () => {
      clearHotkeyHold();
      hotkeyHoldTimer = setTimeout(() => {
        hotkeyHoldTimer = undefined;
        void (async () => {
          // 注意：这里要判断「还是展开态」——展开后 dockedRef 已经是 false，
          // 写成 !dockedRef 会直接把整段逻辑 return 掉（第一版就踩了这个坑）。
          if (!alive || dockedRef.current) return;
          // 正在动画 / 改几何的：等它跑完再看，否则这一下就白丢了
          if (animating || mutating) {
            armHotkeyHold();
            return;
          }
          // 用户可能在这 1 秒里已经退出速览（Esc / 返回按钮）：那这个观察期就作废，
          // 否则会把刚回到的「完整界面」也收成顶栏（真的会收，别问怎么知道的）。
          if (!useFontStore.getState().quickbar) return;
          // 关掉「贴顶自动隐藏」时不该再自动收回去
          if (!autoHideOn()) return;
          if (await cursorInsideWindow()) {
            // 鼠标在面板里：转成正常 hover 展开，之后移出静置再收
            hoverExpanded = true;
            return;
          }
          if (!alive || dockedRef.current) return;
          hoverExpanded = false;
          void collapse();
        })();
      }, HOTKEY_HOLD_MS);
    };

    const stopAnim = () => {
      if (raf !== undefined) cancelAnimationFrame(raf);
      raf = undefined;
      if (finishTimer) {
        clearTimeout(finishTimer);
        finishTimer = undefined;
      }
      animating = false;
      // 取消也得把行内高度 / data-anim 摘掉，否则 qb-frame 停在中断那一帧
      clearFrameDom();
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
     * 内容底边必须始终落在窗口底边**内侧**（圆角修复的关键）：
     * WebView2 的布局/合成跟不上每帧 SetSize，纹理里的内容高度总比窗口滞后 1~3 帧；
     * 如果内容和窗口一样高，窗口底边就会把纹理裁出一条直边——收起/展开途中
     * 下面两个角看起来就是直角。所以 qb-frame 的高度在这里直接写 DOM（不走 React
     * 状态，60fps setState 会抖）：收起时按 t+LEAD 取值（内容比窗口先到位）、
     * 展开时按 t-LEAD（内容比窗口慢一步），两个方向内容都缩在窗口里面，
     * 底边和窗口底边之间露出透明画布（桌面），圆角由 .qb-frame 自己的
     * border-radius 画（见 app.css / App.tsx 的 --qb-radius）。
     *
     * 卡死防护（「最小化再恢复后窗口卡住不动」的根因）：窗口最小化 / 被完全遮挡时
     * WebView2 会停发 rAF，动画永远走不到 done，animating 就一直是 true——
     * 之后所有收起 / 展开 / 长回提示全被它拒掉，窗口彻底失去响应。
     * 所以：页面不可见时直接落到终态；可见时也挂一道 setTimeout 兜底
     * （后台标签页定时器会被钳到 ~1s，正好够用），保证 animating 一定会释放。
     */
    const ANIM_LEAD_MS = 45;
    const animateHeight = (
      fromH: number,
      toH: number,
      widthPhys: number,
      done: () => void,
      scale: number,
      durationMs: number = ANIM_MS,
    ) => {
      stopAnim();
      animating = true;
      const frameEl = document.querySelector<HTMLElement>(".qb-frame");
      const shrinking = toH < fromH;
      const start = performance.now();
      let settled = false;
      const clearFrameHeight = clearFrameDom;
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
        clearFrameHeight();
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
        // 收起方向：窗口比内容晚 LEAD_MS 起步、在剩余时间里跑完同一条缓动——
        // WebView2 的纹理要 1~3 帧才反映出新的内容高度，窗口若与内容同时起步，
        // 头几帧纹理里还是全高内容、被窗口底边裁出直角。窗口晚这一拍，
        // 任何一帧的纹理里内容底边都在窗口底边内侧，圆角始终完整。
        // 展开方向正好相反：窗口边在合成器里也可能滞后于纹理，内容若与窗口同步长高，
        // 纹理里偏高的旧内容会被裁出直角——所以内容滞后 LEAD_MS 再长。
        // 两个方向的效果一致：内容底边永远缩在可见窗口底边之内，圆角画在内容自己的边缘上。
        const lead = Math.min(ANIM_LEAD_MS, Math.max(1, durationMs - 1));
        // 两个方向都把 LEAD 归一化（算法与单测见 lib/quickbarAnim.ts）：
        // 早先展开方向写成 `t - L/d`，结尾只到 0.775 再补一帧，收尾会跳约 1.14%（§5 第 14 条）。
        const norm = leadNormalized(t, durationMs, lead);
        const tw = shrinking ? norm : t;
        const eased = 1 - Math.pow(1 - tw, 3);
        const h = Math.round(fromH + (toH - fromH) * eased);
        // 内容高度：展开时滞后 LEAD，收起时按原始进度（窗口已延后，天然在前）
        const tf = shrinking ? t : norm;
        const easedS = 1 - Math.pow(1 - tf, 3);
        const hs = Math.round(fromH + (toH - fromH) * easedS);
        if (frameEl) {
          frameEl.setAttribute("data-anim", "true");
          frameEl.style.height = `${(hs / scale).toFixed(2)}px`;
        }
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
        // 收成细线 = 整块向上滑出屏幕，再在屏幕外换成细线、从外面落回来。
        //
        // 为什么不继续「原地变矮 + 淡出」：
        // 1. 内容会被窗口底边一刀裁掉，看着像被切断；
        // 2. 窗口高度跨过 DWM 圆角阈值那一刻，四角从圆角直接跳成直角，很割裂
        //    （DWM 只给圆角窗口画阴影，所以圆角又不能一直开着）。
        // 滑出去之后圆角是「滑走」的，切换发生在屏幕外，用户看不到任何形状突变。
        lastChangeAt = Date.now();
        const pos = await win.outerPosition();
        const px = Math.round(pos.x);
        const py = Math.round(pos.y);
        try {
          // 1) 提示条整块往上滑出顶边（尺寸不变，内容不压缩也不裁）
          await morphWindow(
            { x: px, y: py, width: widthPhys, height: from },
            { x: px, y: py - from - OFFSCREEN_PAD, width: widthPhys, height: from },
            RETRACT_OUT_MS,
          );
          if (!alive || !dockedRef.current) return;
          // 2) 屏幕外换成细线：内容切到 bar 阶段，尺寸收成细线高，贴着顶边上沿待命
          setPhaseBoth("bar");
          setBar({ width: Math.round(widthPhys / s), height: DOCK_HEIGHT_BAR });
          await win.setSize(new PhysicalSize(widthPhys, to)).catch(() => {});
          await win.setPosition(new PhysicalPosition(px, py - to - OFFSCREEN_PAD)).catch(() => {});
          // 窗口在屏幕外时 rAF 可能被节流，这里用定时器给 React 一帧画细线
          await new Promise<void>((resolve) => setTimeout(resolve, BAR_SWAP_MS));
          if (!alive || !dockedRef.current) return;
          // 3) 细线从屏幕外落回顶边
          await morphWindow(
            { x: px, y: py - to - OFFSCREEN_PAD, width: widthPhys, height: to },
            { x: px, y: py, width: widthPhys, height: to },
            RETRACT_IN_MS,
          );
        } catch {
          // 原生形变不可用：直接落位到细线，绝不能把窗口留在屏幕外
          await win.setSize(new PhysicalSize(widthPhys, to)).catch(() => {});
          await win.setPosition(new PhysicalPosition(px, py)).catch(() => {});
        }
        if (!alive) return;
        setPhaseBoth("bar");
        setBar({ width: Math.round(widthPhys / s), height: DOCK_HEIGHT_BAR });
        // 收成横线说明这一轮收起彻底结束了：解锁「靠近就展开」。
        // 只靠「指针离开过一次」解锁是不够的——刚点完速览按钮时鼠标往往压在那条上，
        // 但它其实从来没「进入」过收起后的窗口，也就永远等不到离开，划上去不会弹开。
        hoverArmed = true;
        // 细线只有几像素高，鼠标几乎碰不到——交给原生侧的光标感应带
        void ipc.setDockSensor(true).catch(() => {});
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
        animateHeight(
          size.height,
          dockPhys,
          size.width,
          () => {
            if (!alive) return;
            dockedRef.current = true;
            setDocked(true);
            setContentHeight(null);
            setPhaseBoth("hint");
            // 提示行只显示一小会儿，之后收成横线
            scheduleShrink();
          },
          scale,
        );
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
        // 从这里开始才算「展开过程中失焦」：起点清一次，避免上一次收起时的陈旧标记
        blurPending = false;
        animateHeight(
          fromH,
          toH,
          widthPhys,
          () => {
            if (!alive) return;
            setContentHeight(null);
            // 展开完毕再恢复「放得下右键菜单」的最小尺寸限制
            void syncQuickbarMinSize();
            // 鼠标已经不在窗口里的话，静置一会儿自动收回
            if (hoverExpanded && !pointerInside) scheduleRecall();
            // 动画期间失焦过的：几何落定了才补收起，否则 setSize 会被动画线程覆盖（§5 第 4 条）
            if (blurPending) {
              blurPending = false;
              void measure().then((m) => {
                if (!alive || dockedRef.current || !m?.near) return;
                void collapse();
              });
            }
          },
          scale,
        );
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
          animateHeight(from, to, wide, () => then(), scale);
        })
        .finally(() => {
          mutating = false;
        });
    };

    /**
     * 被挡下来的「靠近」排一次重试。
     *
     * hover / 感应带都是**边沿事件**：冷却、失焦宽限期、动画期间挡掉这一下之后，
     * 用户鼠标停在原地不动就再也不会发第二次——表现就是「划上去没反应，得挪开再划」。
     * 所以按剩余时间延迟重试，到期再复查一次光标（§5 第 20 条）。
     */
    const scheduleRevealRetry = (delay: number, near: boolean) => {
      pendingReveal = { near };
      if (revealRetryTimer) return;
      revealRetryTimer = setTimeout(() => {
        revealRetryTimer = undefined;
        const want = pendingReveal;
        pendingReveal = null;
        if (!alive || !want) return;
        if (!want.near && !pointerInside) return;
        reveal(want.near);
      }, Math.max(40, delay));
    };

    /**
     * 鼠标靠近收起条并停留 100ms 才展开。
     * near 为 true 表示光标落在原生侧的感应带里（细线只有几像素高，鼠标实际没进窗口）。
     */
    const reveal = (near = false) => {
      if (revealTimer) return;
      revealTimer = setTimeout(() => {
        revealTimer = undefined;
        if (!alive || !dockedRef.current) return;
        // 动画 / 几何锁：排一次重试，别把这唯一的边沿事件丢掉
        if (animating || mutating) {
          scheduleRevealRetry(120, near);
          return;
        }
        // 刚失焦收起的这一小会儿鼠标可能还压在窗口上：先别弹开，过了宽限期照常展开
        if (!hoverArmed || Date.now() - blurredAt < REVEAL_AFTER_BLUR_MS) {
          const left = REVEAL_AFTER_BLUR_MS - (Date.now() - blurredAt);
          if (left > 0) {
            scheduleRevealRetry(left + 30, near);
            return;
          }
          if (!hoverArmed) return;
        }
        if (!near && !pointerInside) return;
        // 刚收起后的冷却期内也排重试（鼠标往往还压在窗口上，冷却一过就该弹）
        if (Date.now() - lastChangeAt < REVEAL_COOLDOWN_MS) {
          scheduleRevealRetry(REVEAL_COOLDOWN_MS - (Date.now() - lastChangeAt) + 20, near);
          return;
        }
        void expand(true);
      }, SETTLE_MS);
    };

    /** 鼠标移出窗口且没做任何操作 → 静置后自动收回（窗口还贴在顶部才收） */
    const scheduleRecall = () => {
      clearRecall();
      recallTimer = setTimeout(() => {
        recallTimer = undefined;
        if (!alive || dockedRef.current || animating) return;
        if (!autoHideOn()) return;
        if (!hoverExpanded || pointerInside) return;
        void evaluate();
      }, RECALL_IDLE_MS);
    };

    /** 用户真的在用它了：取消「移开就收回」 */
    const markEngaged = () => {
      hoverExpanded = false;
      clearRecall();
      clearHotkeyHold();
    };

    /** 立即回到展开状态（退出速览 / 关闭开关时用，不带动画） */
    const restoreNow = async () => {
      stopAnim();
      mutating = false;
      clearRevealRetry();
      blurPending = false;
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
    activeExpand = async () => {
      markEngaged();
      if (!dockedRef.current) return;
      // 收在顶上那条线、或正被最小化：先保证窗口是「能改几何」的状态
      await win.unminimize().catch(() => {});
      await expand();
      void win.show().catch(() => {});
      // 热键唤出的面板必须真的拿到键盘焦点：Windows 会拒绝后台进程抢前台，
      // 仅靠 setFocus 经常失败，于是「面板弹出来了，打字/ESC 全落到别的软件」。
      void ipc.focusQuickbar().catch(() => {
        void win.setFocus().catch(() => {});
      });
      // 热键叫出来的面板：给 1 秒观察期，鼠标没进来就收回去
      armHotkeyHold();
    };

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
      blurPending = false;
      clearRevealRetry();
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
      // 先拿锁再 await：量几何是异步的，两个最小化请求（按钮 + 快捷键）会在这段
      // await 里同时穿过上面的检查，然后两套流程一起改几何（§5 第 16 条）。
      mutating = true;
      try {
        const m = await measure();
        if (!alive || !m?.near) return false;
        // 1) 内容卷走（CSS），观感上就是「收起来」
        document.body.classList.add("qb-minimizing");
        try {
          await new Promise<void>((r) => setTimeout(r, MINIMIZE_FADE_MS));
          if (!alive) return true;
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
          shrinkWindowHints();
          void ipc.setDockSensor(true).catch(() => {});
          // 3) 关掉这个窗口的 DWM 过渡再真最小化：不播「飞到任务栏」
          await ipc.setWindowTransitions(true).catch(() => {});
          transitionsOff = true;
          await win.minimize().catch(() => {});
          return true;
        } finally {
          // 任何一条分支退出都要摘掉卷走标记：它留在 body 上内容就是永久透明的
          // （`qb-minimizing` 的规则是 opacity:0，见 app.css）（§5 第 16 条）。
          document.body.classList.remove("qb-minimizing");
        }
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
        // 单位必须统一成逻辑像素：`outerPosition()` 和 `Monitor.workArea.position`
        // 返回的都是物理像素（见 @tauri-apps/api 的 Monitor 定义），下面 `top` 已经除以
        // scale，edge 若原样保留就是「物理 - 逻辑」，在任务栏置顶 / 多屏纵向排列
        // （workArea.y ≠ 0）时会把 near 判定直接顶出容差，吸顶彻底失效。
        // 本机单屏、任务栏在底部时 workArea.y = 0，恰好看不出问题。
        const edgePhys = monitor?.workArea?.position?.y ?? monitor?.position?.y;
        if (edgePhys === undefined) return null;
        const edge = edgePhys / scale;
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
      // 关掉「贴顶自动隐藏」：不再贴顶自动收起（热键手动收起不受影响）
      if (!autoHideOn()) return;
      if (settleTimer) return;
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        if (!alive || animating || mutating || dockedRef.current) return;
        if (!autoHideOn()) return;
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
        blurPending = false;
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
      // 只有「动画正在进行」时才需要记下来等落定后补收：
      // 其它情况下面会直接处理，而收起态（docked）本来就该保持收起 ——
      // 如果无条件记，收起时的失焦会变成一个陈旧的 pending，
      // 下次 hover 展开刚结束就被它立刻收回（§5 第 4 条的边界）。
      if (animating || mutating) blurPending = true;
      if (dockedRef.current) return;
      if (animating || mutating) return;
      void measure().then((m) => {
        if (!alive || !m?.near || dockedRef.current) return;
        // 鼠标已经到别的窗口去了：解锁「靠近就展开」，回来时正常弹开，不用先点一下
        hoverArmed = true;
        void collapse();
      });
    };

    // 指针在窗口内移动：收起时靠近展开；展开时取消「移开就收回」
    const onPointerMove = () => {
      pointerInside = true;
      clearRecall();
      if (hotkeyHoldTimer) {
        // 观察期内鼠标进来了：这次展开改成「hover 展开」，之后离开静置才收
        clearHotkeyHold();
        hoverExpanded = true;
      }
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
      // 鼠标已经走了：之前排的「等冷却完再展开」也一并作废，别在鼠标离开后才弹开
      clearRevealRetry();
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

    /**
     * 热键 toggle 走串行链：连按时第二下会撞上 animating / mutating 被静默丢掉，
     * 用户看到「按了两下只反应一下」。排队执行，执行时才读最新 docked（§5 第 21 条）。
     */
    const queueToggle = (run: () => Promise<void>): Promise<void> => toggleQueue.run(run);

    // 配置的快捷键收起 / 展开（界面内：有焦点时原生热键不会把按键送进来，这里是兜底）
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (!matchesHotkey(e, useFontStore.getState().quickbarHotkey)) return;
      e.preventDefault();
      markEngaged();
      void queueToggle(async () => {
        if (!alive) return;
        if (dockedRef.current) await expand();
        else await collapse();
      });
    };

    /**
     * 系统级 Alt+`（原生 RegisterHotKey 发来的事件）。
     * 这时窗口通常没有焦点——用户可能正在别的软件里，所以展开之后要主动抢焦点，
     * 否则面板弹出来了却收不到键盘输入。
     */
    const onGlobalHotkey = () => {
      if (!alive) return;
      markEngaged();
      void queueToggle(async () => {
        if (!alive) return;
        // 窗口可能正被最小化在任务栏、或被「贴顶最小化 / 托盘」藏起来了。
        // 这时候只看 docked 会算成「已经展开 → 收起」，第一次按就等于没反应（§5 第 2 条）。
        const [minimized, visible] = await Promise.all([
          win.isMinimized().catch(() => false),
          win.isVisible().catch(() => true),
        ]);
        if (!alive) return;
        const hidden = minimized || !visible;
        if (dockedRef.current || hidden) {
          // 不可见 / 收起：统一走「恢复 → 展开 → 显示 → 抢焦点」
          await win.unminimize().catch(() => {});
          await win.show().catch(() => {});
          if (dockedRef.current) await expand();
          else await healGeometry();
          if (!alive) return;
          void ipc.focusQuickbar().catch(() => {
            void win.setFocus().catch(() => {});
          });
          armHotkeyHold();
          return;
        }
        await collapse();
      });
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
    // 系统级 Alt+`：原生侧注册的全局热键，任何软件在前台都能把这条线拉下来
    let unlistenHotkey: (() => void) | undefined;
    void listen(GLOBAL_HOTKEY_EVENT, () => onGlobalHotkey())
      .then((un) => {
        if (alive) unlistenHotkey = un;
        else un();
      })
      .catch(() => {
        /* 监听不上就只剩界面内快捷键，不影响其他行为 */
      });
    void evaluate();
    activeMinimize = minimizeAtTop;
    dockBusyGetter = () => animating || mutating;

    return () => {
      alive = false;
      stopAnim();
      clearSettle();
      clearReveal();
      clearRecall();
      clearHotkeyHold();
      clearRevealRetry();
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
      unlistenHotkey?.();
      void ipc.setDockSensor(false).catch(() => {});
      if (activeRestore === restoreNow) activeRestore = null;
      if (activeExpand) activeExpand = null;
      if (activeAdoptDock === adoptDock) activeAdoptDock = null;
      if (activeMinimize === minimizeAtTop) activeMinimize = null;
      if (dockBusyGetter) dockBusyGetter = null;
      if (transitionsOff) {
        transitionsOff = false;
        void ipc.setWindowTransitions(false).catch(() => {});
      }
    };
    // 依赖故意留空：开关翻转只影响「自动」行为（读 enabledRef），
    // 状态机本身不能重建——重建会丢掉收起态、热键句柄与原生监听（§5 第 1 条）。
  }, []);

  return { docked, contentHeight, phase, bar };
}
