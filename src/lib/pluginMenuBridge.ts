import { ipc, type PluginInfo } from "./ipc";

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
  } catch {
    cache = [];
  }
}
