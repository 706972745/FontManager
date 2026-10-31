/**
 * 加载链路的诊断样本采集（纯逻辑，不依赖 DOM）。
 *
 * 为什么要单独抽出来：0.9.9-25 的万级压测只量了「崩不崩 / 白不白 / 内存回不回落」，
 * 没有量「顿不顿」—— 而「滚动预取该不该做」的全部判断都依赖后者。
 * 这里只负责**记录**，不做任何决策；调用方（fontLoader）必须在成功路径上无条件写一条。
 *
 * 两条硬约束（见交接文档 §10）：
 * 1. **纯被动**：`record()` 不得改变任何加载行为。0.9.9-24 的回归就是「滚动时先不加载」，
 *    预览格退回 skeleton，用户直接判定「界面坏了」。
 * 2. **原始与修复分开统计**：`repairLoad()` 会走两次后端 IPC（TTC 抽面 / cmap 重建 / 去提示程序），
 *    耗时量级完全不同。混在一个 p95 里，会让「到底慢在解码还是慢在修」失去分辨力。
 */

/** 一次成功的 FontFace 加载样本 */
export type LoadSample = {
  /** `FontFace.load()` 的耗时（ms） */
  ms: number;
  /** 声明的字体文件体积（字节）；列表子集化后应传**产物**体积 */
  bytes: number;
  /** 是否走的修复链路（repairLoad 的第二、三档） */
  repaired: boolean;
  /** `document.fonts.add` 那一段的耗时（ms）。它是同步的，偶发长任务要能归因 */
  registerMs: number;
};

export type LoaderStatsSnapshot = {
  /** 原始加载（不含修复）样本数 */
  count: number;
  p50: number;
  p95: number;
  max: number;
  /** 修复链路单独统计 —— 数字大不代表解码慢 */
  repairCount: number;
  repairP95: number;
  /** `document.fonts.add` 的 p95 */
  registerP95: number;
  /** time-to-ink 样本数与其分位（加载完成 → 下一帧绘制） */
  inkCount: number;
  inkP50: number;
  inkP95: number;
};

export type PrefetchCounters = {
  /** 真正发起预取的数量 */
  queued: number;
  /** 预取完成后、被可见加载用上的数量 */
  hit: number;
  /** 因体积超限跳过 */
  skipSize: number;
  /** 因预算吃紧跳过 */
  skipBudget: number;
  /** 因在途任务已满跳过 */
  skipInflight: number;
  /** 因为已有状态（已加载/在加载/曾失败）跳过 */
  skipKnown: number;
};

/**
 * 最近秩分位（nearest-rank）。空数组返回 0。
 *
 * 不用插值：样本量本来就不大（上限 2000），插值只会让「p95 = 12.3ms」这种数字
 * 看起来比实测更精确，反而误导判定线。
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

function maxOf(values: readonly number[]): number {
  let m = 0;
  for (const v of values) if (v > m) m = v;
  return m;
}

export function createLoaderStats(maxSamples = 2000) {
  const cap = Math.max(1, maxSamples);
  const samples: LoadSample[] = [];
  const inkSamples: number[] = [];
  const prefetch: PrefetchCounters = {
    queued: 0,
    hit: 0,
    skipSize: 0,
    skipBudget: 0,
    skipInflight: 0,
    skipKnown: 0,
  };

  /** 环形：超上限丢最早的。丢的是最旧样本，对分位影响可忽略 */
  const push = <T,>(arr: T[], value: T): void => {
    arr.push(value);
    if (arr.length > cap) arr.shift();
  };

  return {
    record(ms: number, bytes: number, repaired = false, registerMs = 0): void {
      push(samples, { ms, bytes, repaired, registerMs });
    },

    /** 加载完成 → 首帧绘制。只在第一次拿到 fontFamily 时记，重复调用由调用方去重 */
    recordInk(ms: number): void {
      push(inkSamples, ms);
    },

    countPrefetch(kind: keyof PrefetchCounters): void {
      prefetch[kind] += 1;
    },

    snapshot(): LoaderStatsSnapshot {
      const raw = samples.filter((s) => !s.repaired);
      const repaired = samples.filter((s) => s.repaired);
      const rawMs = raw.map((s) => s.ms);
      return {
        count: raw.length,
        p50: percentile(rawMs, 50),
        p95: percentile(rawMs, 95),
        max: maxOf(rawMs),
        repairCount: repaired.length,
        repairP95: percentile(
          repaired.map((s) => s.ms),
          95,
        ),
        registerP95: percentile(
          samples.map((s) => s.registerMs),
          95,
        ),
        inkCount: inkSamples.length,
        inkP50: percentile(inkSamples, 50),
        inkP95: percentile(inkSamples, 95),
      };
    },

    prefetchCounters(): PrefetchCounters {
      return { ...prefetch };
    },

    /** 预取命中率；没发起过预取时返回 0（判定线里要区分「0 因为没跑」和「0 因为全打空」） */
    prefetchHitRate(): number {
      return prefetch.queued === 0 ? 0 : prefetch.hit / prefetch.queued;
    },

    reset(): void {
      samples.length = 0;
      inkSamples.length = 0;
      prefetch.queued = 0;
      prefetch.hit = 0;
      prefetch.skipSize = 0;
      prefetch.skipBudget = 0;
      prefetch.skipInflight = 0;
      prefetch.skipKnown = 0;
    },

    get size(): number {
      return samples.length;
    },
  };
}

export type LoaderStats = ReturnType<typeof createLoaderStats>;
