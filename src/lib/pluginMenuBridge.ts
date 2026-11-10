import { ipc, type PluginInfo } from "./ipc";
import { usePluginStore } from "./pluginStore";

/**
 * 插件右键菜单的本地缓存（1.3.0）。
 *
 * 右键菜单是纯函数 `buildFamilyMenu(family)` 构建的，拿不到 React 状态，
 * 所以插件清单先缓存到这里：软件启动时刷一次、设置里启停插件后刷一次。
 * 缓存是空的就什么都不加，菜单与 1.2.x 完全一样。
 */
let cache: PluginInfo[] = [];

export function pluginMenuItems(): PluginInfo[] {
  return cache.filter((p) => p.running && p.menus.length > 0);
}

export async function refreshPluginMenus(): Promise<void> {
  try {
    cache = await ipc.pluginsList();
    // 顺手把同一份清单喂给搜索建议（1.9.0）：两处用同一份数据，启动时只发一次 IPC。
    // `plugins_list` 每个插件都要做一次运行时探活，没必要为了「菜单」和「搜索」各跑一遍。
    usePluginStore.setState({ plugins: cache, loaded: true });
  } catch {
    cache = [];
    // 失败时不要标成「已加载」：搜索建议那边还有机会自己再拉一次
    usePluginStore.setState({ loaded: false });
  }
}
