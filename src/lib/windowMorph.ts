import { invoke } from "@tauri-apps/api/core";
import { PhysicalPosition, PhysicalSize, getCurrentWindow } from "@tauri-apps/api/window";

/**
 * 窗口几何（物理像素）：
 * x / y 是窗口外框左上角（与 outerPosition / setPosition 一致），
 * width / height 是客户区尺寸（与 innerSize / setSize 一致）。
 * 两者语义不同，混用会让窗口每次切换都变大一圈。
 */
export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 速览 ↔ 完整界面切换的窗口形变时长（毫秒）。
 *
 * 参考 Windows 的窗口动画（最大化 / 还原 / 贴靠都在 300ms 这一档）：跨度这么大的形变
 * 用 260ms 会显得急，收尾那一下尤其明显。
 */
export const MORPH_MS = 300;

/**
 * 把窗口从 from 平滑推到 to（尺寸 + 位置同时插值）。
 *
 * 插值跑在原生线程里（`src-tauri/src/window_morph.rs`），不走前端的
 * requestAnimationFrame：切进速览时前端要渲染上千张字体卡片，主线程会被占住
 * 数百毫秒，动画挂在 rAF 上就会被一起堵住，表现为「点了没反应然后瞬间跳到位」。
 */
export async function morphWindow(
  from: WindowRect,
  to: WindowRect,
  ms: number = MORPH_MS,
): Promise<void> {
  const same =
    from.x === to.x && from.y === to.y && from.width === to.width && from.height === to.height;
  const duration = ms > 0 && !same ? ms : 0;
  try {
    await invoke<void>("morph_window", { from, to, ms: duration });
  } catch (e) {
    // 原生侧不可用（旧版本 / 命令未注册）时退化成直接落位，切换仍然可用
    console.warn("[morph] 原生形变不可用，直接落位", e);
    const win = getCurrentWindow();
    await win.setSize(new PhysicalSize(Math.round(to.width), Math.round(to.height))).catch(() => {});
    await win
      .setPosition(new PhysicalPosition(Math.round(to.x), Math.round(to.y)))
      .catch(() => {});
    return;
  }
  if (duration > 0) {
    // 命令是「发射后不管」，这里等到动画跑完，调用方才好接着改最小尺寸之类
    await new Promise<void>((resolve) => setTimeout(resolve, duration + 40));
  }
}
