import { ipc, type PluginInfo } from "./ipc";
import { usePluginStore } from "./pluginStore";

/**
 * 「快照缺字体」交给插件去补（1.8.3，2026-11-11）。
 *
 * 背景：快照只存字体清单、不存字体文件。在一台新机器上导入快照，往往有一批
 * 「本机没有」的条目；原来只弹一句「共 N 条，M 条本机没有」就结束了 ——
 * 用户知道缺了东西，却不知道下一步该点哪儿（待办清单 FS-3）。
 *
 * 这里刻意**不硬编码任何具体插件**（主程序不该知道 font-sync 的存在）。
 * 约定：插件在 `plugin.json` 的 `hooks` 里声明 `snapshot-missing`，
 * 就会在快照导入发现缺失时收到一条 invoke：
 *
 *   { "type": "invoke", "hook": "snapshot-missing",
 *     "payload": { "families": ["思源宋体", …], "missing": 42, "total": 320,
 *                  "snapshots": ["全量-2026-11"] } }
 *
 * 主程序只负责「喊一声」，怎么补（从 GitHub 拉、从在线库装、提示用户手动找）
 * 由插件自己决定。没有插件接这条 hook 时，toast 上不出现动作按钮，
 * 文案与以前完全一致。
 */
export const SNAPSHOT_MISSING_HOOK = "snapshot-missing";

/** 声明了「能补快照缺失」且正在运行的插件 */
export function snapshotRestorePlugins(): PluginInfo[] {
  return usePluginStore
    .getState()
    .plugins.filter((p) => p.running && (p.hooks ?? []).includes(SNAPSHOT_MISSING_HOOK));
}

/**
 * 先把插件清单拉一遍再判断。
 *
 * `pluginStore` 是懒加载的（第一次用搜索建议 / 打开设置时才拉）。用户如果开机
 * 直接导入快照，那份清单可能还是空的 —— 这时判断「有没有插件能补」会误判成「没有」，
 * 按钮就不出来了。导入快照本身是异步流程，多等这一下不影响手感。
 */
export async function ensurePluginList(): Promise<void> {
  if (usePluginStore.getState().loaded) return;
  try {
    await usePluginStore.getState().load();
  } catch {
    // 插件系统没起来：当没有插件处理，保持老文案
  }
}

/**
 * 把缺失字族广播给这些插件，返回成功送达的插件数（0 = 没有插件能接）。
 *
 * 逐个发、单个失败不影响其它：插件可能刚好在这一刻退出，stdin 已经关了。
 * 这里不弹 toast —— 插件收到后会自己开面板 / 给提示，主程序再插一句会变成两条。
 */
export async function askPluginsForMissingFamilies(
  families: string[],
  meta: { missing: number; total: number; snapshots: string[] },
): Promise<number> {
  const targets = snapshotRestorePlugins();
  let delivered = 0;
  for (const p of targets) {
    try {
      await ipc.pluginInvoke(p.id, SNAPSHOT_MISSING_HOOK, {
        families,
        missing: meta.missing,
        total: meta.total,
        snapshots: meta.snapshots,
      });
      delivered++;
    } catch {
      // 插件没在跑 / 管道已关：忽略，继续问下一个
    }
  }
  return delivered;
}
