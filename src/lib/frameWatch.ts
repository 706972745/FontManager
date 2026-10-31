/**
 * 帧间隔采样：主线程卡顿的直接证据。
 *
 * 为什么需要它：`FontFace.load()` 的 p95 只能说明「解码慢」，说明不了「用户感觉到卡」。
 * 卡顿的判定要看主线程有没有连续错过帧。文档 §10.2 的口径是 **> 50ms 记一次掉帧**
 * （60Hz 一帧 16.7ms，50ms ≈ 丢掉 3 帧，肉眼已经能看出停顿）。
 *
 * 纯逻辑与浏览器绑定分开：`createFrameStats()` 可以在 node 单测里直接喂间隔，
 * `startFrameWatch()` 才碰 requestAnimationFrame。
 */

export const DROP_THRESHOLD_MS = 50;

export type FrameSnapshot = {
  /** 采样到的帧数 */
  frames: number;
  /** 间隔 > 50ms 的次数 */
  drops: number;
  /** 最长一次间隔（ms） */
  worst: number;
  /** 采样覆盖的总时长（ms），用来算平均帧率 */
  spanMs: number;
  /** 平均帧间隔（ms）；没采样到时为 0 */
  avgMs: number;
};

export function createFrameStats(threshold = DROP_THRESHOLD_MS) {
  let frames = 0;
  let drops = 0;
  let worst = 0;
  let spanMs = 0;

  return {
    addInterval(ms: number): void {
      if (!Number.isFinite(ms) || ms < 0) return;
      frames += 1;
      spanMs += ms;
      if (ms > worst) worst = ms;
      if (ms > threshold) drops += 1;
    },
    snapshot(): FrameSnapshot {
      return {
        frames,
        drops,
        worst,
        spanMs,
        avgMs: frames > 0 ? spanMs / frames : 0,
      };
    },
    reset(): void {
      frames = 0;
      drops = 0;
      worst = 0;
      spanMs = 0;
    },
  };
}

export type FrameStats = ReturnType<typeof createFrameStats>;

/** 模块级单例：HUD 与实验脚本读同一份数据 */
export const frameStats = createFrameStats();

let running = false;

/**
 * 开始采样，返回停止函数（重复调用是幂等的）。
 *
 * 只在实验开关打开时由 HUD 调用 —— 常驻一个 rAF 循环本身有成本，
 * 不能让它变成「测量工具影响了被测量的东西」。
 */
export function startFrameWatch(stats: FrameStats = frameStats): () => void {
  if (typeof requestAnimationFrame !== "function") return () => {};
  if (running) return () => {};
  running = true;

  let last = 0;
  let id = 0;
  const tick = (now: number) => {
    if (last > 0) stats.addInterval(now - last);
    last = now;
    id = requestAnimationFrame(tick);
  };
  id = requestAnimationFrame(tick);

  return () => {
    if (id) cancelAnimationFrame(id);
    id = 0;
    last = 0;
    running = false;
  };
}
