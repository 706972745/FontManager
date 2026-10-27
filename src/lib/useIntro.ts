import { useRef } from "react";
import { useFontStore } from "../state/fontStore";

/**
 * 速览 ↔ 完整界面切换期间（窗口正在形变）不要播放入场动画。
 *
 * 切换的 260ms 里窗口几何每帧都在变，内容此时再各自滑入 / 淡入，两套运动叠在一起
 * 就是「抖 + 顿 + 不流畅」的观感。这里让形变期间挂载的组件一律直接就位
 * （initial=false，时长 0），只有窗口本身在动，内容像是被从窗口里「露出来」的。
 *
 * 返回值在组件挂载那一刻定死：形变结束后即使状态回到 null 也不会补播一次入场动画，
 * 否则又成了第二次动效。
 */
export function useIntro(): boolean {
  const allowRef = useRef<boolean | null>(null);
  if (allowRef.current === null) {
    allowRef.current = useFontStore.getState().morph == null;
  }
  return allowRef.current;
}

/** 形变期间把入场动画按 0 时长收掉（配合 useIntro 使用） */
export const INTRO_OFF = { duration: 0 };
