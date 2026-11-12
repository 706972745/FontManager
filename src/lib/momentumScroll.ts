/**
 * 惯性滚动（2026-11-12 第二版：滚动与滑行分离）。
 *
 * 背景：Windows 上的 Chromium/WebView2 **没有**滚轮惯性 —— 鼠标滚一格，内容走一格，
 * 松手立刻停住；macOS 触控板 / 手机那种「甩一下继续滑、越滑越慢」的手感没有。
 *
 * 第一版（2026-11-11）的做法是「每格既加位移又加动量」：连续滚十几格，动量会累加到
 * 6500px/s，松手后还要走 1.1 秒、约 1500px；再加上画面被 1400px/s 限速、目标位置早已
 * 跑到前面，松手时还欠着几百像素没走完 —— 用户看到的就是「手停了还在滚一屏」。
 *
 * 第二版按手机的模型拆成两段：
 *
 *   1. **滚动中 1:1 跟手**：滚轮只改目标位置（`goal += delta`），**不再顺手加动量**；
 *      同时把 `(时刻, 位移)` 记进一个 120ms 的滑动窗口。
 *   2. **松手后按测速滑行**：90ms 没有新的滚轮 = 松手，用窗口里测出的**手速**起滑，
 *      `v *= e^(-7t)`（时间常数 0.14s，约 0.4s 停住），滑行距离还受两道封顶：
 *      不超过「半屏」、也不超过「刚才滚过的距离」。
 *
 * 于是：
 *   - 慢慢滚一格 → 窗口里只有一个采样点，测不出速度 → **直接停，零滑行**；
 *   - 连续滚 5 格 → 按 5 格/0.3s ≈ 1666px/s 起滑，再走约 200px 就停；
 *   - 快速连甩 10 格 → 按 5000px/s 起滑，但封顶半屏，0.4s 内一定停；
 *   - 触控板碎步 → 测速本来就小，滑行自然短，不再和系统惯性叠加。
 *
 * 帧率无关：全部用 `e^(-λ·dt)` 而不是「每帧乘 0.95」，120Hz 屏上不会滑得更远。
 *
 * 边界（都不许为了手感放松）：
 *
 * 1. **到底就交还原生**：容器已经滚到头还继续滚，`return` 而不 `preventDefault`，
 *    交给浏览器做连锁滚动（`overscroll-behavior: contain` 依然是它说了算）。
 * 2. **不碰输入框**：`input / textarea / select / contenteditable` 里的滚轮照旧原生。
 * 3. **不碰 Ctrl / ⌘ / Alt + 滚轮**：Ctrl+滚轮是调预览字号（`useCtrlWheelZoom`）。
 * 4. **不碰横向滚动**：`|deltaX| > |deltaY|` 时原样交回（跑马灯、横向列表）。
 * 5. **减动效时整条关闭**：设置里的「减少动态效果」或系统 `prefers-reduced-motion`。
 * 6. **任何真实输入都立刻让位**：按下鼠标、按翻页键、触摸都立即停滑；每帧还会比对
 *    scrollTop，被别人动过（程序滚动 / 键盘）就停。
 * 7. **单个容器可以退出**：给元素加 `data-momentum="off"`。
 *
 * 只接管「竖直、能滚、还没到底」这一个瞬间，其余一律原样放行 —— 出问题时最坏的结果是
 * 这一段手感变回原生，而不是滚动失灵。
 */

/** 测速窗口（ms）：只统计最近这么久的滚轮事件 */
const SAMPLE_WINDOW = 120;
/**
 * 测速的最小时间跨度（ms）。
 *
 * 浏览器一次物理滚轮可能在同一帧里补发 2~3 个事件，`Δt` 会接近 0，
 * 直接除会算出几万 px/s 的假速度。夹到 50ms 相当于「一次快甩最多算 20 格/秒」。
 */
const MIN_SPAN = 50;
/** 多久没有新滚轮就算「松手」（ms）。低于一帧的间隔不能算，否则连续滚动会被误判成松手 */
const IDLE_MS = 90;
/** 两次滚轮间隔超过这个值就当作新手势：不继承上一次的速度（ms） */
const GESTURE_GAP = 250;

/** 滑行衰减（1/s）。时间常数 0.14s，松手后约 0.5 秒停住 */
export const GLIDE_DECAY = 7;
/** 低于这个速度就停（px/s）。太小会让 scrollTop 的整数量化变成「一格一格蹭」 */
const GLIDE_MIN_VELOCITY = 40;
/** 低于这个手速压根不起滑（px/s）：慢慢滚、触控板碎步都落在这里 */
const GLIDE_START_VELOCITY = 300;
/** 起滑速度上限（px/s），防连甩把手感甩飞 */
const GLIDE_MAX_VELOCITY = 6000;
/** 滑行距离封顶：不超过容器高度的这个比例 */
const GLIDE_CAP_RATIO = 0.45;
/** 滑行距离封顶：不超过「刚才滚过的距离」的倍数（滚两格就不该滑出三格远） */
const GLIDE_CAP_OF_INPUT = 0.6;

/** deltaMode = 1（按行）时一行的像素估值 */
const LINE_PX = 16;

/**
 * 视觉位置追赶目标位置的系数（1/s），随「还差多少」自适应。
 *
 * - 差距小（≤ 0 起点，触控板 8~20px 的碎步）：取 `SMOOTH_FAST`，两帧就到；
 * - 差距大（≥ `SMOOTH_RANGE`）：取 `SMOOTH_SLOW`，把一格的位移铺开成连续运动。
 *
 * 对照（60fps，dt≈16.7ms）：差 8px → k≈47，两帧到位；差 100px → k≈18，约 100ms 走完 95%。
 */
const SMOOTH_FAST = 50;
const SMOOTH_SLOW = 18;
const SMOOTH_RANGE = 80;

/**
 * 单帧位移上限（px/s）的**下限**。
 *
 * 连甩十几格时目标位置会领先上千像素，不设上限第一帧就会跳一大段。但固定 1400 也不行：
 * 手速 5000px/s 时画面被限在 1400，松手时还欠着几百像素 —— 那笔「欠账」就是第二版要
 * 消灭的尾巴。所以上限跟着手速走：`max(1600, 3×当前速度)`。
 */
const MAX_RENDER_SPEED = 1600;

/** 剩余差距小于这个值（px）就直接到位，不再逐帧逼近 */
const SNAP_PX = 2.5;

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

/** 一帧之后的剩余速度（帧率无关） */
export function decayVelocity(v: number, dt: number, decay = GLIDE_DECAY): number {
  return v * Math.exp(-decay * dt);
}

/** 初速度 v₀ 在停住之前还能滑多远（px）：∫v = v₀/λ */
export function glideDistance(v0: number, decay = GLIDE_DECAY): number {
  return Math.abs(v0) / decay;
}

/**
 * 滑行距离的两道封顶：不超过半屏，也不超过「刚才滚过的距离」。
 * @param viewportPx 容器高度
 * @param inputPx    本次手势累计滚过的距离（取绝对值）
 */
export function glideCap(viewportPx: number, inputPx: number): number {
  const byScreen = Math.max(0, viewportPx) * GLIDE_CAP_RATIO;
  const byInput = Math.abs(inputPx) * GLIDE_CAP_OF_INPUT;
  return Math.max(0, Math.min(byScreen, byInput));
}

/** 是否允许惯性：设置里选了「减少动态效果」，或系统开了 reduce */
export function inertiaAllowed(motionPref: string | undefined, prefersReduced: boolean): boolean {
  if (motionPref === "reduced") return false;
  return !prefersReduced;
}

/** 追赶系数（1/s）：差得越多，追得越"柔" */
export function smoothFactor(diff: number): number {
  const t = clamp(Math.abs(diff) / SMOOTH_RANGE, 0, 1);
  return SMOOTH_FAST - (SMOOTH_FAST - SMOOTH_SLOW) * t;
}

/** 本帧允许的最大速度（px/s）：跟着手速走，别让画面欠账 */
export function followSpeedLimit(currentVelocity = 0): number {
  return Math.max(MAX_RENDER_SPEED, Math.abs(currentVelocity) * 3);
}

/**
 * 这一帧视觉位置该往前挪多少（px，带符号）。
 *
 * @param diff        目标位置 − 视觉位置
 * @param dt          距上一帧的秒数
 * @param speedLimit  本帧允许的最大速度（px/s），见 `followSpeedLimit`
 */
export function renderStep(diff: number, dt: number, speedLimit = MAX_RENDER_SPEED): number {
  if (diff === 0 || dt <= 0) return 0;
  // 尾差直接收掉，别为 1~2px 再磨两三帧
  if (Math.abs(diff) <= SNAP_PX) return diff;
  const ease = diff * (1 - Math.exp(-smoothFactor(diff) * dt));
  const cap = speedLimit * dt;
  if (Math.abs(ease) <= cap) return ease;
  return ease > 0 ? cap : -cap;
}

/** 一次滚轮采样 */
export interface WheelSample {
  /** 时刻（ms，performance.now） */
  t: number;
  /** 折算成像素的位移 */
  d: number;
}

/**
 * 从滑动窗口里测「手速」（px/s）。
 *
 * 少于两个采样点 = 测不出来（一格滚轮就是这种情况）→ 返回 0，调用方据此不起滑。
 * 时间跨度夹在 `MIN_SPAN` 以上，避免同帧补发的事件算出假速度。
 */
export function measureVelocity(samples: readonly WheelSample[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const span = Math.max(MIN_SPAN, last.t - first.t);
  let total = 0;
  for (const s of samples) total += s.d;
  return clamp((total / span) * 1000, -GLIDE_MAX_VELOCITY, GLIDE_MAX_VELOCITY);
}

/** 这个手速该不该起滑 */
export function shouldGlide(velocity: number): boolean {
  return Math.abs(velocity) >= GLIDE_START_VELOCITY;
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
  /** 目标位置：滚轮与滑行共同决定的终点 */
  let goal = 0;
  /** 视觉位置：实际写进 scrollTop 的值，每帧向 goal 逼近 */
  let pos = 0;
  /** 容器可滚动的最大距离（缓存：每帧读 scrollHeight 会强制同步布局） */
  let maxScroll = 0;
  let raf = 0;
  let lastFrame = 0;
  /** 上一次由我们写进去的 scrollTop，用来识别「别人动了滚动位置」 */
  let written = 0;

  /** 本次手势的滚轮采样（只留最近 SAMPLE_WINDOW 毫秒） */
  let samples: WheelSample[] = [];
  /** 本次手势累计滚过的距离（像素，带符号）—— 滑行封顶要用 */
  let gestureInput = 0;
  /** 上一次滚轮时刻（ms） */
  let lastWheelAt = 0;
  /** 是否处于「松手后的滑行」阶段 */
  let gliding = false;
  /** 滑行速度（px/s） */
  let glideV = 0;
  /** 本次滑行已经走了多少（px，取绝对值累计） */
  let glideTraveled = 0;
  /** 本次滑行的距离封顶（px） */
  let glideLimit = 0;

  const reduceQuery =
    typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

  const resetGesture = (target: HTMLElement) => {
    el = target;
    pos = target.scrollTop;
    goal = pos;
    written = pos;
    maxScroll = Math.max(0, target.scrollHeight - target.clientHeight);
    samples = [];
    gestureInput = 0;
    gliding = false;
    glideV = 0;
    glideTraveled = 0;
    glideLimit = 0;
  };

  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    el = null;
    gliding = false;
    glideV = 0;
    samples = [];
    gestureInput = 0;
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

    // ① 松手判定：一段时间没有新滚轮 → 按窗口里测出的手速起滑（一格滚轮测不出速度，直接停）
    if (!gliding && samples.length > 0 && now - lastWheelAt >= IDLE_MS) {
      const v = measureVelocity(samples);
      samples = [];
      if (shouldGlide(v)) {
        gliding = true;
        glideTraveled = 0;
        glideLimit = glideCap(target.clientHeight, gestureInput);
        // 把「距离封顶」换算成「速度上限」而不是滑到一半硬停：
        // 距离 ≈ v/λ，所以 v ≤ limit·λ 时自然停在 limit 上，减速曲线完整。
        const vCap = glideLimit * GLIDE_DECAY;
        glideV = clamp(v, -vCap, vCap);
      }
    }

    // ② 滑行：只推目标位置，速度按指数衰减，撞到边界或封顶就停
    if (gliding) {
      const step = glideV * dt;
      const nextTraveled = glideTraveled + Math.abs(step);
      const nextGoal = goal + step;
      if (nextTraveled > glideLimit || nextGoal <= 0 || nextGoal >= maxScroll) {
        goal = clamp(nextGoal, 0, maxScroll);
        gliding = false;
        glideV = 0;
      } else {
        goal = nextGoal;
        glideTraveled = nextTraveled;
        glideV = decayVelocity(glideV, dt);
        if (Math.abs(glideV) < GLIDE_MIN_VELOCITY) {
          gliding = false;
          glideV = 0;
        }
      }
    }

    // ③ 视觉位置追目标位置（顺滑那一段）
    const diff = goal - pos;
    if (Math.abs(diff) < 1 && !gliding && samples.length === 0) {
      if (pos !== goal) {
        pos = goal;
        target.scrollTop = pos;
        written = target.scrollTop;
      }
      stop();
      return;
    }

    const speed = gliding ? glideV : measureVelocity(samples);
    pos += renderStep(diff, dt, followSpeedLimit(speed));
    target.scrollTop = pos;
    // 记读回来的值而不是 pos：Chromium 在 100% 缩放下会把 scrollTop 量化成整数
    written = target.scrollTop;
    raf = requestAnimationFrame(tick);
  };

  /** 把一格滚轮吃进来：只改目标位置并采样，位移交给 tick 铺开 */
  const push = (target: HTMLElement, deltaY: number, now: number) => {
    if (el !== target) {
      resetGesture(target);
    } else {
      // 虚拟列表 / 图片加载可能改变高度，重新夹一次目标
      maxScroll = Math.max(0, target.scrollHeight - target.clientHeight);
      goal = clamp(goal, 0, maxScroll);
      // 位置被外部改过（列表重置 / 拖滚动条 / 程序滚动到顶）：以真实位置为准重来
      if (Math.abs(target.scrollTop - written) > 2) {
        pos = target.scrollTop;
        goal = pos;
        written = pos;
        gliding = false;
        glideV = 0;
        samples = [];
        gestureInput = 0;
      }
    }

    // 新手势：不继承上一次的速度与采样
    if (now - lastWheelAt > GESTURE_GAP) {
      samples = [];
      gestureInput = 0;
    }
    // 新的滚轮输入立刻接管：滑行中再滚，就从当前位置重新开始
    gliding = false;
    glideV = 0;

    goal = clamp(goal + deltaY, 0, maxScroll);
    gestureInput += deltaY;

    samples.push({ t: now, d: deltaY });
    const cutoff = now - SAMPLE_WINDOW;
    while (samples.length > 0 && samples[0].t < cutoff) samples.shift();
    lastWheelAt = now;

    if (!raf) {
      lastFrame = now;
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
    // 用「视觉位置」判断：目标可能已经跑到头但画面还没走完，这时仍该由我们接管
    const here = container === el ? pos : container.scrollTop;
    // 已经到底还在往外滚：不接管，让浏览器按 overscroll-behavior 做连锁滚动
    if (!canScrollFurther(here, max, delta)) {
      if (container === el) stop();
      return;
    }

    e.preventDefault();
    push(container, delta, performance.now());
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
