import { create } from "zustand";
import { ipc, type PluginInfo } from "./ipc";

/**
 * 已安装插件清单的只读副本（1.8.1）。
 *
 * 为什么单独开一个 store 而不是塞进 `fontStore`：这份数据的生命周期跟着「插件目录」走，
 * 和字体库扫描没半点关系；`fontStore` 已经 4800 行，再挂一个跟字体无关的集合只会更难读。
 *
 * 谁在用：搜索建议（完整界面 + 速览都要能搜到插件）、设置页的插件分区（点完开关后刷新）。
 * 设置页原来自己维护一份 `useState`，现在两边共享这一份，不会出现「设置里刚关掉、
 * 搜索里还显示运行中」。
 */
interface PluginStore {
  plugins: PluginInfo[];
  /** 是否是第一次拉取（界面上判断要不要显示「读取中」） */
  loaded: boolean;
  load: (force?: boolean) => Promise<void>;
}

/** 并发去重：速览与主界面同时挂载时会各调一次，别真的发两遍 */
let inflight: Promise<void> | null = null;

export const usePluginStore = create<PluginStore>((set, get) => ({
  plugins: [],
  loaded: false,
  load: async (force = false) => {
    if (!force && get().loaded && !inflight) {
      // 已经有一份就先用着：搜索建议是「打字即用」，不该等 IO
      return;
    }
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const list = await ipc.pluginsList();
        set({ plugins: list, loaded: true });
      } catch {
        // 插件系统没起来（老版本 state / 目录不可读）不该让搜索框报错：静默留空。
        // 不标 loaded，下次挂载还能再试一次。
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },
}));

/** 组件外调用（比如设置页 toggle 完插件之后） */
export function refreshPlugins() {
  return usePluginStore.getState().load(true);
}
