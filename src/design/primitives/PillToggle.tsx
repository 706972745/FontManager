import { motion } from "motion/react";
import { useState } from "react";
import { springBouncy } from "../springs";
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
      <motion.span
        className="pill-thumb"
        layout
        animate={{ scaleX: pressed ? 1.25 : 1 }}
        transition={springBouncy}
        style={{ originX: on ? 1 : 0 }}
      />
    </motion.button>
  );
}
