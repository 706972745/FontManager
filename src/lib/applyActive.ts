import { toast } from "../design/primitives/Toast";
import { t } from "./i18n";
import { ipc, type AdobeApp } from "./ipc";
import { useFontStore } from "../state/fontStore";

/**
 * 双击「点击复制」的位置 = 套用到**最近在用的设计软件**（1.9.12）。
 *
 * 为什么是「最近在用的那个」而不是让用户先点一下目标窗口：1.9.10 试过两步流程
 * （双击示例文字 → 再点一下目标窗口），实际用起来那「第二下」既难记又容易点错，
 * 而且它和普通双击复制是两套语义。现在统一成「双击 = 直接套用」，
 * 目标由主程序判断（`active_target`：前台是 FontManager 自己或任务栏时，
 * 沿 Z 序往下翻第一个 PS/AI/CDR 窗口），和插件「自动」项走的是同一条链路。
 *
 * 套用本身仍然交给 `applyFaceInApp`：启用检查、CJK 提醒、9 种 outcome 的中文提示
 * 都在里面，这里不重复实现任何一条。
 */
export async function applyToActiveApp(family: string, faceId: string): Promise<void> {
  // 探测失败（后端没起来 / 老版本没有这个命令）等同于「没找到」：
  // 双击复制的主功能已经完成了，套用失败不该变成一次报错弹窗
  const active = await ipc.activeApp().catch(() => null);
  if (!active?.app) {
    toast.info(t("apply.noTarget"));
    return;
  }
  await useFontStore.getState().applyFaceInApp(family, faceId, active.app as AdobeApp);
}
