import type { MouseEvent as ReactMouseEvent } from "react";
import { FolderOpen, Settings } from "lucide-react";
import { openContextMenu, type MenuItem } from "../design/primitives/ContextMenu";
import { toast } from "../design/primitives/Toast";
import { t } from "./i18n";
import { ipc, type PluginInfo } from "./ipc";

/**
 * 插件行的右键菜单与「打开插件设置」的**唯一实现**（1.9.0 提取）。
 *
 * 原来这套逻辑只写在 `SettingsOverlay` 里，所以只有设置页能右键插件；
 * 搜索结果里出现插件之后，同一个插件在两处必须给同一套菜单 —— 复制一份迟早走样，
 * 所以抽到这里，设置页与搜索建议共用。
 *
 * 菜单项顺序与设置页保持一致：
 *   ① 插件自己在 `plugin.json` 的 `menus` 里声明 `"on": "plugin"` 的项
 *   ② 插件声明的设置面板（只有声明了 `settings` 才有）
 *   ③ 打开插件目录（永远有）
 */
export function buildPluginMenu(
  p: PluginInfo,
  opts: { source?: string } = {},
): MenuItem[] {
  const source = opts.source ?? "plugin-row";
  const items: MenuItem[] = [];
  for (const m of p.menus.filter((x) => x.on === "plugin")) {
    items.push({
      label: m.title,
      action: () =>
        void ipc
          .pluginInvoke(p.id, "context-menu", { menu: m.title, source })
          .catch((err) => toast.error(String(err))),
    });
  }
  if (items.length > 0) items.push({ kind: "separator" });
  if (p.settings) {
    items.push({
      label: p.settings.title ?? t("settings.pluginsSettings"),
      icon: <Settings size={14} strokeWidth={1.5} />,
      disabled: !p.running,
      action: () => void openPluginSettings(p),
    });
  }
  items.push({
    label: t("settings.pluginsOpenDir"),
    icon: <FolderOpen size={14} strokeWidth={1.5} />,
    action: () => void ipc.openFolder(p.dir).catch(() => {}),
  });
  return items;
}

export function openPluginMenu(e: ReactMouseEvent, p: PluginInfo, source?: string) {
  openContextMenu(e, buildPluginMenu(p, { source }));
}

/**
 * 让插件**自己**把设置面板弹出来。
 *
 * 插件是独立进程，主程序从不替它画界面 —— 这里只能把 `settings.hook`
 * （默认 `settings`）发过去。`source` 固定写 `settings`：这是「用户要看设置」的语义，
 * 从搜索结果点进来和从设置页点齿轮是同一件事，插件不该为此分叉。
 */
export async function openPluginSettings(p: PluginInfo): Promise<void> {
  if (!p.running) {
    toast.error(t("toast.pluginOfflineForSettings", { name: p.name }));
    return;
  }
  try {
    await ipc.pluginInvoke(p.id, p.settings?.hook ?? "settings", { source: "settings" });
    toast.success(t("toast.pluginSettingsSent", { name: p.name }));
  } catch (e) {
    toast.error(String(e));
  }
}
