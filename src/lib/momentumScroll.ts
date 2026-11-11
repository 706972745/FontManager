/**
 * 惯性滚动（2026-11-11 用户要求）。
 *
 * 背景：Windows 上的 Chromium/WebView2 **没有**滚轮惯性 —— 鼠标滚一格，内容走一格，
 * 松手立刻停住；而 macOS 触控板 / 移动端那种「甩一下继续滑、越滑越慢」的手感没有。
 * 用户要的正是这一条：滚完之后按当前速度继续滑行、逐渐减速，
 * 滚得越快滑得越远，慢慢滚甚至可以几乎不滑。
 *
 * 做法：接管 `wheel` 事件，按当前速度驱动 `scrollTop` 做指数衰减。
 *
 *   - **跟手**：每一格滚轮的分量**立刻**写进 scrollTop（所以第一帧和原生手感一致，
 *     不会有"先卡一下再动"的延迟）；
 *   - **滑行**：同一分量再换成一个初速度（px/s），之后每帧 `v *= e^(-DECAY·dt)`，
 *     滑行总距离 ≈ v₀ / DECAY，所以「越快越远」是自然结果；
 *   - **慢滚几乎不滑**：一格 100px 只多滑约 45px；触控板的小分量多滑十几像素就到阈值停住；
 *   - **帧率无关**：用 `e^(-λ·dt)` 而不是「每帧乘 0.95」，120Hz 屏上不会滑得更远。
 *
 * 边界（都不许为了手感放松）：
 *
 * 1. **到底就交还原生**：容器已经滚到头还继续滚，`return` 而不 `preventDefault`，
 *    交给浏览器做连锁滚动（`overscroll-behavior: contain` 依然是它说了算）。
 *    这样「设置面板滚到底不该带着背后列表一起动」这条 1.8.2 的修复不受影响。
 * 2. **不碰输入框**：`input / textarea / select / contenteditable` 里的滚轮照旧原生
 *    （那里滚动常伴随光标移动，接管容易出怪事）。
 * 3. **不碰 Ctrl / ⌘ / Alt + 滚轮**：Ctrl+滚轮是调预览字号（`useCtrlWheelZoom`），
 *    而且要拦掉 WebView2 的整页缩放。
 * 4. **不碰横向滚动**：`|deltaX| > |deltaY|` 时原样交回（跑马灯、横向列表）。
 * 5. **减动效时整条关闭**：设置里的「减少动态效果」或系统 `prefers-reduced-motion`
 *    一旦生效，这里直接不接管，恢复成原生的「滚多少走多少」。
 * 6. **任何真实输入都立刻让位**：按下鼠标（拖滚动条、点卡片）、按翻页键、触摸，
 *    都立即停滑；另外每帧还会比对 scrollTop，被别人动过（程序滚动 / 键盘）就停。
 * 7. **单个容器可以退出**：给元素加 `data-momentum="off"`。
 *
 * 只接管「竖直、能滚、还没到底」这一个瞬间，其余一律原样放行 —— 出问题时最坏的结果是
 * 这一段手感变回原生，而不是滚动失灵。
 */

/** 速度衰减（1/s）。时间常数 ≈ 0.24s，松手后约 0.7 秒内停住 */
const DECAY = 4.2;
/**
 * 一格滚轮（px）换来的初速度（px/s）。
 * 滑行距离 ≈ GAIN / DECAY ≈ 0.45 格 —— 一格 100px 的滚轮，松手后再滑约 45px。
 * 调大 → 更"飘"；调小 → 更"实"。
 */
const GAIN = 1.9;
/** 低于这个速度就停（px/s）：约 3px 的余量，肉眼已经在静止 */
const MIN_VELOCITY = 14;
/** 上限，防连甩把手感甩飞 */
const MAX_VELOCITY = 6500;
/** deltaMode = 1（按行）时一行的像素估值 */
const LINE_PX = 16;
/**
 * 尾速的「分量折扣」区间（px）。
 *
 * 鼠标滚轮一格是 100 上下的**大**分量，Windows 触控板是 10~40 的**小**分量、
 * 而且系统本身已经在连续补惯性事件。两者一视同仁的话，触控板会发飘（我们的尾速
 * 叠在系统惯性上）。所以：12px 以下完全不给尾速，48px 以上按满额，
 * 中间线性过渡 —— 鼠标一格（Chromium 上是 100 上下）手感一点没变，
 * 触控板只是「滚多少走多少」。
 */
const TAIL_RAMP_START = 12;
const TAIL_RAMP_END = 48;

/** 会被我们让路的按键（原生滚动键） */
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
  "Spacebar",
]);

/** 滚轮 delta 折算成像素（deltaMode: 0=px 1=行 2=页） */
export function normalizeWheelDelta(
  deltaY: number,
  deltaMode: number,
  pagePx: number,
  linePx = LINE_PX,
): number {
  if (deltaMode === 1) return deltaY * linePx;
  if (deltaMode === 2) return deltaY * pagePx;
  return deltaY;
}

/** 这个方向还能不能再滚（不能就别接管，交给原生做连锁滚动） */
export function canScrollFurther(scrollTop: number, maxScroll: number, deltaY: number): boolean {
  if (deltaY > 0) return scrollTop < maxScroll - 0.5;
  if (deltaY < 0) return scrollTop > 0.5;
  return false;
}

/** 初速度 v₀ 一共能滑多远（px）—— 给单测和文档用 */
export function glideDistance(v0: number, decay = DECAY): number {
  return Math.abs(v0) / decay;
}

/** 一帧之后的剩余速度（帧率无关） */
export function decayVelocity(v: number, dt: number, decay = DECAY): number {
  return v * Math.exp(-decay * dt);
}

/** 是否允许惯性：设置里选了「减少动态效果」，或系统开了 reduce */
export function inertiaAllowed(motionPref: string | undefined, prefersReduced: boolean): boolean {
  if (motionPref === "reduced") return false;
  return !prefersReduced;
}

/**
 * 这个分量该按几成给尾速（0 = 只走不滑）。
 * 见 TAIL_RAMP_START / TAIL_RAMP_END 的注释：小分量是触控板，别叠系统惯性。
 */
export function tailShare(deltaY: number): number {
  const a = Math.abs(deltaY);
  if (a <= TAIL_RAMP_START) return 0;
  return clamp((a - TAIL_RAMP_START) / (TAIL_RAMP_END - TAIL_RAMP_START), 0, 1);
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function isEditable(el: Element | null): boolean {
  return !!el?.closest?.("input, textarea, select, [contenteditable='true']");
}

function overflowScrollsY(el: Element): boolean {
  const oy = getComputedStyle(el).overflowY;
  return oy === "auto" || oy === "scroll" || oy === "overlay";
}

/**
 * 从事件目标往上找第一个「真的能竖着滚」的容器。
 *
 * 只对 `scrollHeight > clientHeight` 的元素查 computed style（绝大多数祖先都比一次
 * 数字比较便宜）；`overflow: hidden` 的元素即使内容溢出也不接管 —— 用户本来也滚不动它。
 *
 * 走到 `<body>` 还没找到时，再看一眼页面本身（`document.scrollingElement`）：
 * 现在所有视图都是内部滚动，但将来若有整页滚动的界面，这里能直接兜住，
 * 不用回来改逻辑。
 */
function findScrollable(start: EventTarget | null): HTMLElement | null {
  if (document.documentElement.dataset.momentum === "off") return null;
  let el = start instanceof HTMLElement ? start : null;
  while (el && el !== document.body && el !== document.documentElement) {
    if (el.dataset.momentum === "off") return null;
    if (el.scrollHeight - el.clientHeight > 1 && overflowScrollsY(el)) return el;
    el = el.parentElement;
  }
  const page = document.scrollingElement;
  if (
    page instanceof HTMLElement &&
    page.scrollHeight - page.clientHeight > 1 &&
    page.dataset.momentum !== "off"
  ) {
    return page;
  }
  return null;
}

/**
 * 装上惯性滚动，返回卸载函数。
 *
 * 用 `capture` + `passive: false`：要能 `preventDefault` 才拿得下滚动。
 * 模块级只装一套 —— 重复调用（StrictMode 挂载两次、HMR 重跑）直接返回同一个卸载函数，
 * 否则两只手同时写 scrollTop，手感会打架。
 */
let active: (() => void) | null = null;

export function installMomentumScroll(): () => void {
  if (active) return active;

  let disposed = false;

  let el: HTMLElement | null = null;
  let velocity = 0;
  let raf = 0;
  let lastFrame = 0;
  /** 上一次由我们写进去的 scrollTop，用来识别「别人动了滚动位置」 */
  let written = 0;

  const reduceQuery =
    typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    el = null;
    velocity = 0;
  };

  const tick = (now: number) => {
    raf = 0;
    const target = el;
    if (!target) return;
    if (!target.isConnected) {
      stop();
      return;
    }
    // 别人动过（拖滚动条 / 键盘 / 程序滚动）→ 让位，别和它抢
    if (Math.abs(target.scrollTop - written) > 2) {
      stop();
      return;
    }

    const dt = clamp((now - lastFrame) / 1000, 0.001, 0.05);
    lastFrame = now;

    const max = Math.max(0, target.scrollHeight - target.clientHeight);
    const next = target.scrollTop + velocity * dt;
    const applied = clamp(next, 0, max);
    if (applied !== next) velocity = 0; // 撞到边界就停，不顶着边继续推
    target.scrollTop = applied;
    written = applied;

    velocity = decayVelocity(velocity, dt);
    if (Math.abs(velocity) < MIN_VELOCITY) {
      stop();
      return;
    }
    raf = requestAnimationFrame(tick);
  };

  /** 把一格滚轮吃进来：立刻走掉，再把剩下的动量交给滑行 */
  const push = (target: HTMLElement, deltaY: number) => {
    if (el !== target) {
      el = target;
      velocity = 0;
    }
    const max = Math.max(0, target.scrollHeight - target.clientHeight);
    const before = target.scrollTop;
    const applied = clamp(before + deltaY, 0, max);
    target.scrollTop = applied;
    written = target.scrollTop;
    // 贴边时按剩余行程打折：不然「最后半格」会攒出一段没法兑现的速度，
    // 下次反向滚动时先要把这段还掉，手感会发黏。
    const room = deltaY > 0 ? max - applied : applied;
    const share = clamp(room / Math.max(1, Math.abs(deltaY) * 2), 0, 1);
    velocity = clamp(
      velocity + deltaY * GAIN * share * tailShare(deltaY),
      -MAX_VELOCITY,
      MAX_VELOCITY,
    );

    if (!raf) {
      lastFrame = performance.now();
      raf = requestAnimationFrame(tick);
    }
  };

  const onWheel = (e: WheelEvent) => {
    // Ctrl / ⌘ + 滚轮 = 调预览字号（另一条链路），Alt + 滚轮 也别碰
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // 横向为主（跑马灯 / 横向列表）交回原生
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    if (!inertiaAllowed(document.documentElement.dataset.motion, !!reduceQuery?.matches)) return;
    if (isEditable(e.target instanceof Element ? e.target : null)) return;

    const container = findScrollable(e.target);
    if (!container) return;

    const max = Math.max(0, container.scrollHeight - container.clientHeight);
    const delta = normalizeWheelDelta(e.deltaY, e.deltaMode, container.clientHeight);
    if (!delta) return;
    // 已经到底还在往外滚：不接管，让浏览器按 overscroll-behavior 做连锁滚动
    if (!canScrollFurther(container.scrollTop, max, delta)) {
      if (container === el) stop();
      return;
    }

    e.preventDefault();
    push(container, delta);
  };

  // 任何真实输入都立刻停滑
  const onPointerDown = () => stop();
  const onTouchStart = () => stop();
  const onKeyDown = (e: KeyboardEvent) => {
    if (SCROLL_KEYS.has(e.key)) stop();
  };
  const onVisibility = () => {
    if (document.hidden) stop();
  };

  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  window.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("visibilitychange", onVisibility);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    active = null;
    stop();
    window.removeEventListener("wheel", onWheel, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("touchstart", onTouchStart, true);
    window.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("visibilitychange", onVisibility);
  };
  active = dispose;
  return dispose;
}
