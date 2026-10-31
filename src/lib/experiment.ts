/**
 * 实验开关：把「A/B 对比」做成改一个参数就能重启验证，而不是改代码再构建。
 *
 * 读取优先级：**URL 查询参数 > localStorage > 默认值**。
 * 默认值必须与 0.9.9-25 的现状**完全一致** —— 这个模块上线时不能改变任何现有行为。
 *
 * 用法（完整界面）：
 *   http://localhost:1420/?diag=1&overscan=8&prefetch=1
 * 或控制台：`localStorage.setItem("zfm.exp.overscan", "10")` 后重启。
 * 改完**重启应用**生效（参数在模块加载时缓存，避免每次渲染解析字符串）。
 */

const PREFIX = "zfm.exp.";

const cache = new Map<string, string | null>();

function readRaw(name: string): string | null {
  if (cache.has(name)) return cache.get(name) ?? null;

  let value: string | null = null;
  try {
    if (typeof window !== "undefined" && window.location?.search) {
      const parsed = new URLSearchParams(window.location.search);
      value = parsed.get(name);
    }
  } catch {
    /* 非浏览器环境 / 非法 URL：退回 localStorage */
  }
  if (value === null) {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        value = window.localStorage.getItem(`${PREFIX}${name}`);
      }
    } catch {
      /* 隐私模式或配额异常：当作没有配置 */
    }
  }
  cache.set(name, value);
  return value;
}

/** 数字型参数：非法值（空串 / NaN）一律回退，不抛错 */
export function parseExpNumber(
  raw: string | null,
  fallback: number,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 布尔型参数：`1 / true / on / yes` 为真，`0 / false / off / no` 为假，其余回退 */
export function parseExpBool(raw: string | null, fallback: boolean): boolean {
  if (raw === null) return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(v)) return true;
  if (["0", "false", "off", "no", ""].includes(v)) return false;
  return fallback;
}

export function expNumber(name: string, fallback: number, min?: number, max?: number): number {
  return parseExpNumber(readRaw(name), fallback, min, max);
}

export function expBool(name: string, fallback: boolean): boolean {
  return parseExpBool(readRaw(name), fallback);
}

export function expString(name: string, fallback: string): string {
  const raw = readRaw(name);
  return raw === null || raw.trim() === "" ? fallback : raw;
}

/** 仅供单测：清掉参数缓存，让下一次读取重新走 URL / localStorage */
export function resetExperimentCache(): void {
  cache.clear();
}

/**
 * 具体实验项。**默认值 = 现状**，所以不传参数时行为与 0.9.9-25 完全一致。
 */
export const experiment = {
  /** 完整界面网格的 overscan（现状 6；§11.1 建议对比 6 / 8 / 10） */
  gridOverscan: () => expNumber("overscan", 6, 1, 40),
  /** 速览的 overscan（现状 4） */
  quickbarOverscan: () => expNumber("qbOverscan", 4, 0, 20),
  /** 速览的 IO 预取边距（现状 240px；§11.2 试 360 / 480） */
  quickbarRootMargin: () => expString("qbRoot", "240px"),
  /**
   * 列表专用子集通道（§12）。**1.0.0-1 起默认开启。**
   *
   * 和上面几项不同，它不再是「默认等于现状」的实验项：产物只含屏上真正用到的字符，
   * 解码成本从「整个字体」降到「几十 KB」。任何一步失败都会自动回退完整链路
   * （`list_preview_font` 返回 null 或产物加载失败 → 走 `useFontCss`），
   * 所以关掉它只在排查「某字体卡片预览缺字」时用。
   */
  listSubset: () => expBool("listSubset", true),
  /**
   * 卡片缩略图缓存（§13）。**默认关闭。**
   *
   * 它把「实时渲染」换成静态图，字重切换 / 主题色 / 字号档 / 缩放比任一变化
   * 都可能暴露差异 —— 而 0.9.9-24 的教训正是「任何先不加载的优化都会显示成界面坏了」。
   * 按文档判定秩序，它要等 §10.5 的数据指向「回滚痛」才启用。
   */
  thumbnail: () => expBool("thumb", false),
  /** 主动预取（§14，默认关闭：前置条件尚未由数据确认） */
  prefetch: () => expBool("prefetch", false),
  /** 预取窗口：视口外各留几屏 */
  prefetchScreens: () => expNumber("prefetchW", 1, 1, 3),
  /** 诊断 HUD（§10.3） */
  diag: () => expBool("diag", false),
};
