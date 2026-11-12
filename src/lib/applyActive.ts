import { toast } from "../design/primitives/Toast";
import { t } from "./i18n";
import { ipc, type AdobeApp } from "./ipc";
import { useFontStore } from "../state/fontStore";
import { pluginMenuItems } from "./pluginMenuBridge";

/**
 * 双击「点击复制」的位置 = 套用到最近在用的设计软件（1.9.12）。
 *
 * 优先交给「字体套用」插件的「自动」项：套用策略只有插件里一份。
 * 插件没装 / 没启用 / 没在跑时**静默兜底**走主程序自己的同一套引擎
 * （active_target + applyFaceInApp）—— 双击是复制位上的顺手操作，
 * 绝不能因为「你没装插件」弹一句像 bug 的提示。
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
      .catch(() => void applyDirect(family, faceId)); // 插件调用失败也要落到兜底
    return;
  }
  void applyDirect(family, faceId);
}

/** 兜底：与插件「自动」项同一条链路，只是由主程序自己发起 */
async function applyDirect(family: string, faceId: string): Promise<void> {
  const active = await ipc.activeApp().catch(() => null);
  if (!active?.app) {
    // 只有「三个软件都没开」才提示；这是用户能理解的状态，不是缺插件
    toast.info(t("apply.noTarget"));
    return;
  }
  await useFontStore.getState().applyFaceInApp(family, faceId, active.app as AdobeApp);
}
