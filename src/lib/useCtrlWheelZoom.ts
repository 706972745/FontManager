import { useEffect } from "react";
import { MIN_PREVIEW_SIZE_INDEX, SIZES, useFontStore } from "../state/fontStore";
import { clampIndex, wheelStep } from "./previewWheel";

/**
 * 按住 Ctrl（macOS 上 ⌘ 同样认）滚动鼠标滚轮，调整字体预览文本的大小。
 *
 * 三个界面共用同一套逻辑，因为三处看的其实是同一个偏好：
 * - 完整界面的卡片 / 列表 → `sizeIndex`（滑条上的那档）
 * - 完整界面的样张视图 → `specimenSizeIndex`（样张单独一档，最低 8px）
 * - 速览界面 → `sizeIndex`
 *
 * 滚完把结果丢进 `zoomHint`，由 <ZoomHud /> 在窗口底部闪一下：
 * 滑条在顶栏，滚轮操作时光标可能在窗口另一头，没有反馈就不知道现在到底多大了。
 *
 * WebView2 自己会吃掉 Ctrl+滚轮做整页缩放（整个界面包括侧栏一起变大，
 * 重新打开又恢复），那种「缩页面」不是用户要的 —— 所以只要按着 Ctrl 就
 * preventDefault，把滚动全部接管过来（哪怕这一下没换档）。
 */
export function useCtrlWheelZoom(skip?: () => boolean) {
  useEffect(() => {
    let acc = 0;
    let hideTimer = 0;

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) {
        acc = 0;
        return;
      }
      // 按着 Ctrl 一律接管：不接管的话 WebView2 会整页缩放，界面就「花」了
      e.preventDefault();
      if (skip?.()) {
        acc = 0;
        return;
      }

      const st = useFontStore.getState();
      // 速览窗口里没有样张视图，字号走卡片那一档
      const inSpecimen = !st.quickbar && st.viewMode === "specimen";
      const min = inSpecimen ? 0 : MIN_PREVIEW_SIZE_INDEX;
      const current = inSpecimen ? st.specimenSizeIndex : st.sizeIndex;

      const next = wheelStep(acc, e.deltaY, e.deltaMode);
      acc = next.acc;
      if (next.steps === 0) return;

      const index = clampIndex(current, next.steps, min, SIZES.length - 1);
      if (index !== current) {
        // setter 内部还会按视图再夹一次（命令面板 / 旧偏好可能绕过滑条）
        if (inSpecimen) st.setSpecimenSizeIndex(index);
        else st.setSizeIndex(index);
      }
      // 顶到上下限也照样显示「96px / 24px」：让人知道已经到头了，而不是以为滚轮失灵
      st.setZoomHint(SIZES[index]);
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => st.setZoomHint(null), 900);
    };

    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.clearTimeout(hideTimer);
      useFontStore.getState().setZoomHint(null);
    };
  }, [skip]);
}
