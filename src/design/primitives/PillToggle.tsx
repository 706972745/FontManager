import { motion } from "motion/react";
import { useState, type CSSProperties } from "react";
import { playToggle } from "../../lib/sound";

interface Props {
  on: boolean;
  mixed?: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
  label: string;
  size?: "sm" | "lg";
}

export function PillToggle({ on, mixed = false, disabled, onChange, label, size = "sm" }: Props) {
  const isMixed = mixed && !on;
  const [pressed, setPressed] = useState(false);

  return (
    <motion.button
      role="switch"
      aria-checked={isMixed ? "mixed" : on}
      aria-label={label}
      disabled={disabled}
      className={`pill-toggle pill-${size} ${on ? "pill-on" : ""} ${isMixed ? "pill-mixed" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        playToggle(!on);
        onChange(!on);
      }}
      /*
       * 按下 / 抬起都要拦在开关自己身上。卡片的 whileTap 是绑在整张卡上的，
       * pointerdown 一旦冒泡上去，父级会把整卡缩到 0.99 —— 卡片中心缩放，
       * 贴右的开关跟着横移 4px 再弹回，就是「点按钮时按钮偏移」那一下。
       */
      onPointerDown={(e) => {
        e.stopPropagation();
        if (!disabled) setPressed(true);
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        setPressed(false);
      }}
      onPointerLeave={() => setPressed(false)}
      /*
       * 这里以前是 whileTap={{ scale: 0.94 }}。按下时按钮自己缩 6%，
       * 边缘 1~2px 的位置会从「按在开关上」变成「按在卡片上」：
       * 浏览器把 click 派发给 mousedown / mouseup 的最近公共祖先（卡片），
       * 于是点开关变成了选中卡片 → 详情面板打开 → 整列变窄 → 开关跳走。
       * 手感反馈改由滑块自己 scaleX 表达（见下面的 pill-thumb），
       * 按钮盒子在任何时候都不变，热区就不会在按下瞬间缩水。
       */
    >
      <span
        className="pill-thumb"
        /*
         * 滑块位置交给纯 CSS（`.pill-thumb` 的 translateX），不再用 motion 的 `layout`。
         *
         * 原来是 `<motion.span layout />`：layout 投影每次渲染量一次 box，再用 transform
         * 从「上一次的 box」动画到「这一次的 box」。而这个开关挂在**虚拟滚动**的行上
         * （`@tanstack/react-virtual`，行会被回收复用），又在详情面板宽度逐帧 0→348 的
         * 容器里，还会跟着窗口缩放 —— 这三种情况下「上一次的 box」属于别的行 / 别的宽度，
         * 滑块就从错误的位置飞过来、滞后于轨道，看起来就是「按钮不跟着自己那一行走」
         * （用户 2026-11 报，FontList / FamilyCard / DetailPanel / SettingsOverlay /
         * OnlineView 五处调用点全中）。
         * 轨道尺寸本来就是固定的（--pill-w / --pill-h），位移能用 calc 算出来，不需要量。
         *
         * 按下反馈（scaleX 1.25）保留，但和位移合成同一个 transform，
         * 原点用变量给：关态从左端拉伸、开态从右端拉伸，跟原来 originX 的行为一致。
         *
         * ⚠️ 原点必须带 `%`：`transform-origin` 要 `<length-percentage>`，
         * 裸数字只有 0 合法。原来写 `on ? 1 : 0`，开态算出 `1 50%` 是非法值，
         * 整条声明在计算值阶段被丢掉、回落 `50% 50%` → 开态按下变成**从中心**放大，
         * 滑块右缘挤进轨道 padding 1.6px(sm)/2.5px(lg)（QA 实测 `1 → 6.5px 6.5px`）。
         */
        style={
          {
            "--pill-sx": pressed ? 1.25 : 1,
            "--pill-origin": on ? "100%" : "0%",
          } as CSSProperties
        }
      />
    </motion.button>
  );
}
