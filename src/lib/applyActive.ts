import { toast } from "../design/primitives/Toast";
import { ipc } from "./ipc";
import { pluginMenuItems } from "./pluginMenuBridge";

/**
 * 双击「点击复制」的位置 = 把这一下交给「字体套用」插件的「自动」项（1.9.12）。
 *
 * 主程序在这里**只做转发**：不判断目标软件、不调套用引擎、不写任何兜底逻辑。
 * 套用策略（挑字重 / 认目标 / 翻提示）只有插件里一份，主程序不认识任何具体插件，
 * 只按「菜单标题以『自动：』开头」这条约定找。
 *
 * 找不到插件时**什么都不做**：双击本身的「复制」已经生效，那就是这一下原本的行为。
 * 不能提示「去启用插件」——用户会以为是软件坏了。
 *
 * `pluginMenuItems()` 是同步的（读 pluginMenuBridge 的缓存），所以只能放在事件回调里调，
 * 不能放进 render —— 缓存刷新时不会触发重渲染。
 */
export function applyToActiveApp(family: string, faceId: string): void {
  for (const p of pluginMenuItems()) {
    const hit = p.menus.find((m) => m.on === "family" && m.title.startsWith("自动："));
    if (!hit) continue;
    void ipc
      .pluginInvoke(p.id, "context-menu", { family, menu: hit.title, faceId })
      .catch((e) => toast.error(String(e)));
    return;
  }
}
