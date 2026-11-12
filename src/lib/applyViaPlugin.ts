import { pluginMenuItems } from "./pluginMenuBridge";
import { ipc } from "./ipc";
import { toast } from "../design/primitives/Toast";
import { t } from "./i18n";

/**
 * 双击「点击复制」的位置 = 交给「字体套用」插件的「自动」项（1.9.12）。
 *
 * 为什么是转发给插件而不是主程序直接套用：套用这件事的业务（选字重、认目标软件、
 * 把 9 种 outcome 翻成人话）属于插件，主程序只负责把**手势**翻译成一次插件调用。
 * 这样双击和「右键 → 自动：应用到最近使用的设计软件」走的是**同一条路径**，
 * 不会出现「双击和菜单行为不一致」这种两套逻辑各修一半的局面。
 *
 * 为什么按标题前缀认「自动」项：主程序不认识插件里的具体菜单，插件也可能改别的菜单；
 * 「自动：」这个前缀是插件 manifest 里约定的入口，主程序只认它，不认插件 id ——
 * 换一个实现了同样菜单的插件也能用。
 *
 * `faceId` 一起发过去：双击的是哪一行字重，插件就套哪个字重（插件 1.0.1+ 认这个字段，
 * 更早的版本会忽略它、按 Regular 走，不会报错）。
 */
export function applyViaPlugin(family: string, faceId: string): void {
  // pluginMenuItems() 是同步的（读 pluginMenuBridge 的缓存），所以只能放在事件回调里调，
  // 不能放进 render —— 缓存刷新时不会触发重渲染。
  for (const p of pluginMenuItems()) {
    const hit = p.menus.find((m) => m.on === "family" && m.title.startsWith("自动："));
    if (!hit) continue;
    void ipc
      .pluginInvoke(p.id, "context-menu", { family, menu: hit.title, faceId })
      .catch((e) => toast.error(String(e)));
    return;
  }
  // 插件没装 / 没启用：明确告诉用户。静默什么都不做是最糟的 ——
  // 用户会以为「双击坏了」，而不是「少装了一个插件」。
  toast.info(t("apply.pluginMissing"));
}
