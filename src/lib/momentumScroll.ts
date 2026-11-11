/**
 * 惯性滚动（2026-11-11 用户要求）。
 *
 * 背景：Windows 上的 Chromium/WebView2 **没有**滚轮惯性 —— 鼠标滚一格，内容走一格，
 * 松手立刻停住；而 macOS 触控板 / 移动端那种「甩一下继续滑、越滑越慢」的手感没有。
 * 用户要的正是这一条：滚完之后按当前速度继续滑行、逐渐减速，
 * 滚得越快滑得越远，慢慢滚甚至可以几乎不滑。
 *
 * 做法：**目标位置**与**视觉位置**分开，视觉位置每帧去追目标位置。
 *
 *   - 滚轮只改「目标」：`goal += delta`，同时给 `velocity` 加一份动量；
 *   - 惯性作用在目标上：`goal += v·dt`，`v *= e^(-DECAY·dt)` —— 越快走越远是自然结果；
 *   - 视觉位置 `pos` 每帧按指数逼近 goal 再写进 `scrollTop`。
 *
 * 为什么不是「每格立刻写 scrollTop」（第一版的做法）：
 * Windows 滚轮一格是 100px，一次性写进去就是**硬跳 100px**，滑行只是跳完之后的尾巴，
 * 手感就是「跳、跳、跳」。现在单格 100px 会被铺成约 100ms 的连续位移，
 * 连续多格则自然叠成一段匀速滑行再减速。
 *
 * 三条保证「顺滑但不拖沓」的约束：
 *
 *   1. **追赶系数随距离自适应**：差 8px（触控板碎步）时系数 50/s，两帧到位，
 *      几乎不加延迟；差 100px 以上时降到 18/s，铺开成平滑运动。
 *   2. **单帧位移上限** `MAX_RENDER_SPEED`：连甩十几格时目标可能领先上千像素，
 *      不设上限第一帧就会跳一大段。现在一帧最多走 2000·dt（60fps 下约 33px）。
 *   3. **起步渐入** `RAMP_SECONDS`：从静止接上滚轮时不直接给满速，
 *      80ms 内线性升到全速 —— 挡掉「第一帧就跳满」的观感。
 *
 * 帧率无关：全部用 `e^(-λ·dt)` 而不是「每帧乘 0.95」，120Hz 屏上不会滑得更远。
 *
 * 边界（都不许为了手感放松）：
 *
 * 1. **到底就交还原生**：容器已经滚到头还继续滚，`return` 而不 `preventDefault`，
 *    交给浏览器做连锁滚动（`overscroll-behavior: contain` 依然是它说了算）。
 * 2. **不碰输入框**：`input / textarea / select / contenteditable` 里的滚轮照旧原生。
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
 * 滑行距离 ≈ (GAIN·Δ − MIN_VELOCITY) / DECAY ≈ 0.4 格 —— 一格 100px 的滚轮，
 * 松手后再滑约 40px。调大 → 更"飘"；调小 → 更"实"。
 */
const GAIN = 2.2;
/**
 * 低于这个速度就停（px/s）。
 *
 * 这个值不能太小：速度掉到十几 px/s 时，一帧只走 0.2px，而 Chromium 的
 * `scrollTop` 在 100% 缩放下按整数存 —— 于是每帧写进去的值被量化成 0 或 1，
 * 视觉上就是「一格一格蹭」，比干脆停住更难受。
 * 55px/s 约 0.9px/帧，正好是量化后还能看出连续位移的下限。
 */
const MIN_VELOCITY = 55;
/** 上限，防连甩把手感甩飞 */
const MAX_VELOCITY = 6500;
/** deltaMode = 1（按行）时一行的像素估值 */
const LINE_PX = 16;

/**
 * 视觉位置追赶目标位置的系数（1/s），随「还差多少」自适应。
 *
 * - 差距小（≤ 0 起点，触控板 8~20px 的碎步）：取 `SMOOTH_FAST`，两帧就到，
 *   不加任何可感知的延迟；
 * - 差距大（≥ `SMOOTH_RANGE`）：取 `SMOOTH_SLOW`，把一格的位移铺开成连续运动。
 *
 * 对照（60fps，dt≈16.7ms）：
 *   差 8px  → k≈47 → 首帧走 4.4px，两帧到位；
 *   差 100px → k≈18 → 首帧走 26px，约 100ms 走完 95%。
 */
const SMOOTH_FAST = 50;
const SMOOTH_SLOW = 18;
const SMOOTH_RANGE = 80;

/**
 * 单帧位移上限（px/s）。连甩十几格时目标位置可能领先上千像素，
 * 不设上限第一帧就跳一大段 —— 这是「看着卡」的另一个来源。
 * 2000 在 60fps 下约 33px/帧，已经比一格滚轮小，肉眼是连续滚动而非跳。
 */
const MAX_RENDER_SPEED = 2000;

/**
 * 起步渐入（秒）：从静止接上滚轮时不直接给满速，这段时间内线性升到全速。
 * 挡掉「第一帧就把第一格的分位移完」的观感。
 */
const RAMP_SECONDS = 0.08;

/**
 * 剩余差距小于这个值（px）就直接到位，不再逐帧逼近。
 *
 * 指数追赶的理论时间常数只有 20ms，但 60fps 下每帧最多走 55%，
 * 剩下那 1~2px 的尾巴要再花两三帧才收干净 —— 视觉上毫无意义，
 * 反而让触控板碎步多出一点"黏"的感觉。2.5px 在屏幕上不到一个像素行。
 */
const SNAP_PX = 2.5;

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

/**
 * 初速度 v₀ 实际还能滑多远（px）。
 * 要扣掉「速度掉到 MIN_VELOCITY 就停」的那一截，否则算出来的距离永远偏大。
 */
export function glideDistance(v0: number, decay = DECAY, minVelocity = MIN_VELOCITY): number {
  const v = Math.abs(v0);
  if (v <= minVelocity) return 0;
  return (v - minVelocity) / decay;
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

/** 追赶系数（1/s）：差得越多，追得越"柔" */
export function smoothFactor(diff: number): number {
  const t = clamp(Math.abs(diff) / SMOOTH_RANGE, 0, 1);
  return SMOOTH_FAST - (SMOOTH_FAST - SMOOTH_SLOW) * t;
}

/**
 * 这一帧视觉位置该往前挪多少（px，带符号）。
 *
 * @param diff        目标位置 − 视觉位置
 * @param dt          距上一帧的秒数
 * @param speedLimit  本帧允许的最大速度（px/s），由调用方乘以起步渐入系数
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
  /** 目标位置：滚轮与惯性共同决定的终点 */
  let goal = 0;
  /** 视觉位置：实际写进 scrollTop 的值，每帧向 goal 逼近 */
  let pos = 0;
  let velocity = 0;
  /** 起步渐入进度 0→1 */
  let ramp = 0;
  /** 容器可滚动的最大距离（缓存：每帧读 scrollHeight 会强制同步布局） */
  let maxScroll = 0;
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
    ramp = 0;
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
    ramp = Math.min(1, ramp + dt / RAMP_SECONDS);

    // ① 惯性推进「目标位置」：这一段决定滑多远（越快越远）
    if (Math.abs(velocity) >= MIN_VELOCITY) {
      const next = goal + velocity * dt;
      if (next <= 0 || next >= maxScroll) {
        goal = clamp(next, 0, maxScroll);
        velocity = 0; // 撞到边界就停，不顶着边继续推
      } else {
        goal = next;
      }
      velocity = decayVelocity(velocity, dt);
    } else {
      velocity = 0;
    }

    // ② 「视觉位置」追「目标位置」：这一段决定顺不顺滑
    const diff = goal - pos;
    if (Math.abs(diff) < 1 && velocity === 0) {
      if (pos !== goal) {
        pos = goal;
        target.scrollTop = pos;
        written = target.scrollTop;
      }
      stop();
      return;
    }

    pos += renderStep(diff, dt, MAX_RENDER_SPEED * ramp);
    target.scrollTop = pos;
    // 记读回来的值而不是 pos：Chromium 在 100% 缩放下会把 scrollTop 量化成整数，
    // 用精确值当基准会让下一帧的「外部改动」检测偏 0.x 像素。
    written = target.scrollTop;
    raf = requestAnimationFrame(tick);
  };

  /** 把一格滚轮吃进来：只改目标位置与动量，实际位移交给 tick 铺开 */
  const push = (target: HTMLElement, deltaY: number) => {
    if (el !== target) {
      el = target;
      velocity = 0;
      ramp = 0;
      pos = target.scrollTop;
      goal = pos;
      written = pos;
      maxScroll = Math.max(0, target.scrollHeight - target.clientHeight);
    } else {
      // 虚拟列表 / 图片加载可能改变高度，重新夹一次目标
      maxScroll = Math.max(0, target.scrollHeight - target.clientHeight);
      goal = clamp(goal, 0, maxScroll);
      // 位置被外部改过（列表重置 / 拖滚动条 / 程序滚动到顶）：以真实位置为准重来。
      // 不重新对齐的话，tick 开头的「别人动过」检测会把这一格整个丢掉 ——
      // 表现就是「界面上滚了一下之后，第一次滚轮没反应」。
      if (Math.abs(target.scrollTop - written) > 2) {
        pos = target.scrollTop;
        goal = pos;
        written = pos;
        velocity = 0;
        ramp = 0;
      }
    }

    // 反向滚动：把旧方向的动量清掉，否则前半段会先被往反方向拽一下
    if (velocity * deltaY < 0) velocity = 0;

    goal = clamp(goal + deltaY, 0, maxScroll);
    // 贴边时按剩余行程打折：不然「最后半格」会攒出一段没法兑现的速度，
    // 下次反向滚动时先要把这段还掉，手感会发黏。
    const room = deltaY > 0 ? maxScroll - goal : goal;
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
    // 用「视觉位置」判断：目标可能已经跑到头但画面还没走完，这时仍该由我们接管
    const here = container === el ? pos : container.scrollTop;
    // 已经到底还在往外滚：不接管，让浏览器按 overscroll-behavior 做连锁滚动
    if (!canScrollFurther(here, max, delta)) {
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
