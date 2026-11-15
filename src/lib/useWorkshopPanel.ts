import { useEffect, useState } from "react";
import { ipc } from "./ipc";

/**
 * 插件中心面板装了没有。
 *
 * 2026-11-15 用户把入口从侧栏挪到了标题栏（纯图标、悬停出提示），
 * 两处都要同一个判断口径，所以抽成 hook，别各写一份 useEffect。
 *
 * 真相来自后端 `workshop_panel_status`（`prefs.workshopInstalled` **且**
 * 目录里真有 `workshop.html` —— 用户手删目录也算没装，见 workshop.rs）；
 * 设置页装完/卸掉会广播 window 事件，这里跟着刷一次。
 */
export function useWorkshopInstalled(): boolean {
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      ipc
        .workshopPanelStatus()
        .then((s) => {
          if (alive) setInstalled(s.installed);
        })
        .catch(() => {
          // 后端还没起来（老版本 state / 目录不可读）：当作没装
          if (alive) setInstalled(false);
        });
    };
    refresh();
    window.addEventListener("workshop-panel-changed", refresh);
    return () => {
      alive = false;
      window.removeEventListener("workshop-panel-changed", refresh);
    };
  }, []);
  return installed;
}
