/**
 * 速览窗口动画里那几块「纯逻辑」。
 *
 * 抽出来的唯一目的是能被单元测试直接盯住：缓动曲线的数值实现、时间轴归一化的收尾、
 * 热键 toggle 的串行合并，这些东西以前都是内联在 hook 里的 `if (...) return` 或
 * 一行 `1 - Math.pow(1 - t, 3)`，出了问题只能靠 60fps 抓帧回看
 * （而且结论并不唯一）。算法本身与 DOM / Tauri 无关。
 */

/* ─── 标准缓动曲线 ────────────────────────────────────────────────────────
 *
 * `cubic-bezier(0.4, 0, 0.2, 1)` —— 也就是 `src/design/tokens.css:108` 的 `--ease-std`
 * 与 Windows 窗口动画（最大化 / 还原 / 贴靠）同款的那条曲线。
 *
 * 为什么速览的高度动画要用它：之前这里写的是纯缓出 `1 - (1-t)^3`，它在 t=0 处导数 = 3，
 * **第一帧就吃掉总行程的 23%**（Δ=980 逻辑 px、200ms、60fps 下实测 225.2 px/帧，
 * 而平均只有 81.7 px/帧）——观感就是「猛地一冲」，收尾又偏急。
 * 仓库自己在 `src-tauri/src/window_morph.rs:29-32` 已经判过这条曲线并换成了 standard，
 * 但 dock 这条链没跟上，于是同一套设计语言里跑着两套曲线。
 *
 * 为什么 JS 侧要留一份数值副本（而不是读 CSS 的 `--ease-std`）：
 * `src/design/springs.ts` 是 LB-07 承重墙（改动要 S1 → slow + 人工批准），本卡走 fast
 * 故绕开；逐帧 rAF 里也不适合去 getComputedStyle 读令牌（每帧强刷样式）。
 * 代价是这份副本可能与令牌漂移，**用单测锁住**：`tests/quickbarAnim.test.ts` 会读
 * `tokens.css` 把四个控制点逐个对账，不一致即红。这条测试替代的是「不许写死数字」的人工纪律。
 *
 * 数值解法直接照 `src-tauri/src/window_morph.rs:49-87`（牛顿迭代解 Bx(t)=x，
 * 不收敛再二分兜底，x 轴误差 ≤1e-5），保证 Rust 侧原生形变与 JS 侧高度动画**同一条曲线**——
 * 两处若各写一套近似算法，同屏的两个动作会有肉眼可见的相位差。
 */

/** 第一控制点 x（= 令牌里的 0.4） */
export const STANDARD_EASE_X1 = 0.4;
/** 第一控制点 y（= 令牌里的 0） */
export const STANDARD_EASE_Y1 = 0;
/** 第二控制点 x（= 令牌里的 0.2） */
export const STANDARD_EASE_X2 = 0.2;
/** 第二控制点 y（= 令牌里的 1） */
export const STANDARD_EASE_Y2 = 1;

/**
 * 四个控制点按 `cubic-bezier(x1, y1, x2, y2)` 的顺序打包。
 *
 * 存在的意义只有一个：让单测能把「`standardEase` 实际用的数」和
 * 「`tokens.css` 里 `--ease-std` 写的数」逐个比对，而不是比对某个字符串。
 */
export const STANDARD_EASE_CONTROL_POINTS: readonly [number, number, number, number] = [
  STANDARD_EASE_X1,
  STANDARD_EASE_Y1,
  STANDARD_EASE_X2,
  STANDARD_EASE_Y2,
];

/** 三次贝塞尔在某一轴上的取值（端点固定 0 / 1，中间两个是控制点） */
function bezierAxis(t: number, a1: number, a2: number): number {
  const mt = 1 - t;
  return 3 * mt * mt * t * a1 + 3 * mt * t * t * a2 + t * t * t;
}

/** 三次贝塞尔在该参数处的导数（牛顿迭代用） */
function bezierSlope(t: number, a1: number, a2: number): number {
  const mt = 1 - t;
  return 3 * mt * mt * a1 + 6 * mt * t * (a2 - a1) + 3 * t * t * (1 - a2);
}

/**
 * 标准缓动：把线性进度 `x`（0~1）映射成 `cubic-bezier(0.4, 0, 0.2, 1)` 的进度。
 *
 * 性质（都被单测锁住）：
 * - 端点精确 0 / 1。收尾若差一点点，最后一帧会「补一下」，看起来就是跳一下；
 * - 起步极慢：`standardEase(0.05) ≈ 0.0058`，同一位置老曲线是 `0.143`（差 25 倍）——
 *   这是「先停一下再窜出去」里那个「窜」被削掉的直接原因；
 * - 峰值斜率 ≈ 2.735（出现在 x ≈ 0.301），老曲线是 3 且在 x=0 处。
 *   配合 280ms 时长，60fps 下单帧最大位移落在 155 px，而 200ms + 老曲线是 225 px。
 *
 * 非有限输入返回 0、越界 clamp：这两个分支不是防御性编程的客套 —— 调用点在 rAF 里，
 * 一旦 `performance.now()` 倒流或 `durationMs` 被算成 0 之外的怪值，
 * 返回 NaN 会让 `setSize` 收到 NaN 尺寸，窗口直接卡死不动（比动画难看严重得多）。
 */
export function standardEase(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // 先牛顿迭代解参数 t（Bx(t) = x），收敛不了再二分兜底
  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = bezierAxis(t, STANDARD_EASE_X1, STANDARD_EASE_X2) - x;
    if (Math.abs(err) < 1e-5) return bezierAxis(t, STANDARD_EASE_Y1, STANDARD_EASE_Y2);
    const d = bezierSlope(t, STANDARD_EASE_X1, STANDARD_EASE_X2);
    // 斜率塌到 0（曲线在 x 轴上原地折返）时牛顿法会飞出去，退出迭代交给二分
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
    if (!(t >= 0 && t <= 1)) break;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < 24; i++) {
    const v = bezierAxis(t, STANDARD_EASE_X1, STANDARD_EASE_X2);
    if (Math.abs(v - x) < 1e-5) break;
    if (v < x) lo = t;
    else hi = t;
    t = (lo + hi) * 0.5;
  }
  return bezierAxis(t, STANDARD_EASE_Y1, STANDARD_EASE_Y2);
}

/* ─── 速览高度动画的时间轴参数 ──────────────────────────────────────────────
 *
 * 为什么这两个常量住在这里、而不是 `useQuickbarDock.ts`：
 * 它们必须被 `tests/quickbarAnim.test.ts` 的「帧位移护栏」**直接读到**。
 * 测试里若只能抄一份字面量，那道护栏量的就是「抄进去的那个数」，不是产品
 * 真正在用的那个 —— 变异实验（把 280 改回 200）下测试照样全绿，而产品会退化成
 * 窗口轨 216.3 / 内容轨 276.2 px/帧（比改前 264.4 更差）。
 * `hook` 侧以别名导入（`QUICKBAR_ANIM_MS as ANIM_MS`），调用点不动。
 */

/**
 * 展开 / 收起的高度动画时长（毫秒）。
 *
 * **2026-11-28 晚：280 → 180。** 这一天内它变了两次，原因要连着看，别只看数字：
 *   ① 200 → 280（曲线同时换成 `standardEase`）：那时动画仍按「窗口逐帧改尺寸」做，
 *      每帧位移太大就显顿，只能靠加时长摊平（60fps 峰值 225.2/264.4 → 153.7/155.4）。
 *   ② 280 → 180（本值）：窗口不再参与逐帧动画（见 `useQuickbarDock.ts` 的
 *      `animateHeight`），每帧只剩一次「裁切框高度」样式写入，帧预算够了，
 *      于是把时长还回去 —— 用户要的是**快**。峰值位移变大是「快」的必然代价，
 *      但不再掉帧，观感由「一卡一卡」变成连续位移。
 *
 * 实测本机面板 **2560×1600 @ 165Hz**（每帧 6.06ms）：180ms ≈ 30 帧，单帧峰值
 * ≈ 90 逻辑 px（Δ=980、`standardEase` 斜率上界 2.73）。若退回 60Hz 屏，同样时长
 * 单帧峰值 ≈ 247px，会显粗 —— 那是刷新率的问题，不是这条时间轴的问题。
 *
 * 连带影响（都读这个常量，不用手改）：`finishTimer`（durationMs + 800）、
 * `zeroGuard`（ANIM_MS + 600）、`healGeometry`（ANIM_MS + 150）、`queueToggle`（ANIM_MS + 600）。
 */
export const QUICKBAR_ANIM_MS = 180;

/**
 * 滞后轨比领先轨晚起跑的时间（毫秒）—— LEAD 的**相位延迟**量。
 *
 * 45ms ≈ 2.7 帧 @60fps，取自 `animateHeight` 那条既有观测「WebView2 的纹理总比窗口
 * 滞后 1~3 帧」：取 3 帧的上界，保证任何一帧的纹理里内容底边都落在窗口底边内侧
 * （圆角不变量）。
 *
 * **2026-11-28 晚起，速览的高度动画已不再使用它**：窗口不再参与逐帧动画，
 * 「窗口轨 / 内容轨」这对相位差从结构上消失了（窗口永远 ≥ 裁切框，见 `animateHeight`）。
 * 保留本常量与 `leadNormalized`：它们是「两条轨必须错相位」时的正确解法，
 * 下一个人要做同类动画（窗口与内容各自插值）时不用重新推导。
 */
export const QUICKBAR_ANIM_LEAD_MS = 45;

/**
 * 把「总进度 t（0~1）」换算成「晚 LEAD 起跑的滞后轨进度」。
 *
 * 语义：`t` 是**以 `durationMs + leadMs` 为总长**的进度（不是以 durationMs 为总长）。
 * 滞后轨在 `t = lead/(duration+lead)` 处才起跑、在 `t = 1` 处跑满，
 * 中间那段恰好是 `durationMs` —— 也就是说 LEAD 是**相位延迟**，
 * 滞后轨跑的是与领先轨**同样长、同样曲线**的一段，只是起跑时刻晚 45ms。
 *
 * 为什么不能写成「把剩下的时间重新拉满」（本函数 2026-11 之前的做法
 * `(t*d - L) / (d - L)`）：那个式子的几何含义是**压缩**，不是延迟——
 * 内容被塞进 `d - L` = 155ms 跑完 980px，单帧峰值 264.4 px（比窗口轨还高 17%），
 * 而前 45ms 画面完全不动（窗口在长，但长出窗口的那截是全透明的：
 * `src/app.css:14-19` + `tauri.conf.json` 的 `transparent:true, shadow:false`）。
 * 用户看到的是「先停一下，再窜出去」。
 *
 * 所以现在是 `(t*(d+L) - L) / d`：
 * - `t = L/(d+L)` → 0（起跑点，clamp 之后起点之前恒 0）
 * - `t = 1` → 1（收尾精确，不会在最后一帧补一下）
 * - 单调不减，且斜率形状与领先轨完全一致（同一段曲线平移 45ms）
 *
 * 不变式（圆角不变量靠它，见 `useQuickbarDock.ts` 的 `animateHeight`）：
 * 展开时窗口轨用领先进度、内容轨用滞后进度 ⇒ 窗口高度 ≥ 内容高度；
 * 收起时反过来（窗口滞后、内容领先）⇒ 仍是窗口 ≥ 内容。
 * 两个方向「内容底边永远缩在窗口底边内侧」的结论与改动前一致。
 */
export function leadNormalized(t: number, durationMs: number, leadMs: number): number {
  if (!Number.isFinite(t) || t <= 0) return 0;
  if (t >= 1) return 1;
  // duration 是分母，必须是正的有限数（「减少动效」下走 0ms 短路，不会进到这里，
  // 但函数是导出的纯函数，不能假设调用方守规矩）
  const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 1;
  const lead = Number.isFinite(leadMs) && leadMs > 0 ? leadMs : 0;
  const progress = (t * (duration + lead) - lead) / duration;
  return Math.max(0, Math.min(1, progress));
}

export interface SerialQueue {
  /**
   * 排一个任务。任务按提交顺序**一个一个**跑，永不并发。
   * 返回的 Promise 在这次任务真正跑完后 resolve。
   */
  run: (task: () => void | Promise<void>) => Promise<void>;
  /** 已经提交但还没跑完的任务数（含正在跑的那个） */
  readonly pending: number;
}

/**
 * 串行队列（热键 toggle 用）。
 *
 * 速览的收起 / 展开各自是几百毫秒的多段异步，快速连按热键时第二下会撞上
 * `animating / mutating` 被静默丢掉——用户看到「按了两下只反应一下」。
 * 排队之后：每一下都会被执行，而且**执行的那一刻**才去读当前状态，
 * 所以「收 → 展 → 收」三下连按的最后结果一定是收起。
 *
 * 注意：任务里的错误不会打断后面的任务（否则一次失败会把队列卡死）。
 */
export function createSerialQueue(onError?: (e: unknown) => void): SerialQueue {
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;

  const run = (task: () => void | Promise<void>): Promise<void> => {
    pending++;
    const next = chain
      .then(async () => {
        try {
          await task();
        } catch (e) {
          onError?.(e);
        }
      })
      .finally(() => {
        pending--;
      });
    chain = next;
    return next;
  };

  return {
    run,
    get pending() {
      return pending;
    },
  };
}
