/**
 * 「每天检查一次更新」的闸门。
 *
 * 为什么单独抽出来：这条规则有三处要一致（启动时、常驻期间的定时复查、设置页显示），
 * 写在组件里既测不到也容易改出一边 24 小时一边 12 小时。这里只留纯函数，没有 IPC、没有 React。
 *
 * 两条硬约束：
 *   1. **最多一天一次** —— GitHub 匿名接口是 60 次/小时/IP，多开几个实例很容易撞上限流；
 *   2. **常驻也不能永远不查** —— 原来只在启动时跑一次，托盘常驻的用户开着软件好几天，
 *      就再也不会被提醒（「每天一次」变成了「每次启动一次」）。
 */

/** 两次检查之间的最小间隔：24 小时 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 常驻期间多久看一眼「到点了没有」。取 6 小时：一天最多醒 4 次，
 * 判断本身只是读一次 prefs，几乎不耗电；间隔再长（比如 24 小时）就会让
 * 「昨天 9 点开的机」拖到今天 10 点才提醒。
 */
export const UPDATE_RECHECK_TICK_MS = 6 * 60 * 60 * 1000;

/**
 * 现在该不该检查。
 *
 * `last` 是 prefs 里的 `updateLastCheck`（毫秒时间戳），脏数据一律当成「没查过」：
 * 宁可多查一次，也不要因为一个坏值把提醒永久关掉。
 *
 * 时钟回拨（`last` 落在未来）也按「该查」处理：否则用户手动改一次系统时间，
 * 提醒就再也不出现了；查完 `last` 会被写成当前时间，下一轮自然恢复。
 */
export function dueForUpdateCheck(last: unknown, now: number = Date.now()): boolean {
  const t = typeof last === "number" && Number.isFinite(last) ? last : 0;
  if (t <= 0) return true;
  if (t > now) return true;
  return now - t >= UPDATE_CHECK_INTERVAL_MS;
}
