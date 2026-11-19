import { useEffect, type RefObject } from "react";

/**
 * 让提示条（`.toaster`）从**顶栏下面**开始排。
 *
 * 事故（2026-11-19，用户截图）：2.5.1 的插件中心把面板做进主窗口之后，插件提示
 * 落在右上角，正好压在顶栏右侧那几个按钮（视图切换 / 筛选 / 排序）上面 ——
 * 提示还在的时候那排按钮点不动，看起来像「软件卡住了」。
 *
 * 为什么不是写死一个数：`.topbar` 是 `flex-wrap` 的（窗口变窄、详情面板展开都会换行），
 * 高度在 56 / 100 之间跳。写死 112 在换行后依旧会压住第二行。所以这里量它**真实的底边**，
 * 写进 `--toast-safe-top`，CSS 里 `.toaster-main` 只负责消费这个值。
 *
 * 两处细节：
 * ① 入场动画是 `y: -32 → 0` 的 transform —— `getBoundingClientRect()` 会把这段偏移算进去，
 *    首帧量到的底边偏小 32px。所以补一次延迟复量（动画 400ms + 余量），别只用首帧。
 * ② 宽度变化不一定改变高度（ResizeObserver 只报尺寸），窗口整体缩放时补一条 `resize`。
 */
export function useToasterSafeTop(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    let timer = 0;

    const apply = () => {
      const bottom = el.getBoundingClientRect().bottom;
      // 顶栏被隐藏（在线视图没有 TopBar）时 bottom 是 0，别把提示顶到屏幕最上面
      if (bottom > 0) root.style.setProperty("--toast-safe-top", `${Math.round(bottom + 8)}px`);
    };

    apply();
    timer = window.setTimeout(apply, 700);

    const ro = new ResizeObserver(apply);
    ro.observe(el);
    window.addEventListener("resize", apply);

    return () => {
      window.clearTimeout(timer);
      ro.disconnect();
      window.removeEventListener("resize", apply);
      // 顶栏卸载（切到在线视图）后回到 CSS 的兜底值，别留一个过期的高度
      root.style.removeProperty("--toast-safe-top");
    };
  }, [ref]);
}
