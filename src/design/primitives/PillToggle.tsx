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
      onPointerDown={() => !disabled && setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      whileTap={disabled ? undefined : { scale: 0.94 }}
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
