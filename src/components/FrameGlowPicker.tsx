import { FRAME_GLOW_DEFAULT, FRAME_GLOW_NONE, useFontStore } from "../state/fontStore";
import { useT, type TKey } from "../lib/i18n";

/**
 * 窗口边框颜色选择（2.7.5 起叫「阴影颜色」，2.7.6 改成 1px 边框）。
 *
 * 主界面与速览**分开**记（prefs.frameGlowMain / frameGlowQuick），各自给一排预设色块
 * （宝蓝 / 墨黑 / 纸白 / 中灰）一键切换；末尾再加一个「无边框」圆点（斜线表示取消），
 * 选中后 CSS 变量把边框宽度归零 —— 不是把颜色设透明（透明像素会被 DWM 填白）。
 * 选中的值写进 prefs 并即时生效 —— 设置页全部即时生效，不做「应用」按钮。
 */

/** 预设色板：accent = 跟主题宝蓝；其余是固定 hex（不分主题，用户选什么就是什么） */
const PRESETS: { value: string; key: TKey; swatch?: string }[] = [
  { value: FRAME_GLOW_DEFAULT, key: "settings.glowAccent", swatch: "var(--accent-a)" },
  { value: "#141412", key: "settings.glowInk", swatch: "#141412" },
  { value: "#ffffff", key: "settings.glowPaper", swatch: "#ffffff" },
  { value: "#8a8a86", key: "settings.glowGray", swatch: "#8a8a86" },
  { value: FRAME_GLOW_NONE, key: "settings.glowNone" },
];

export function FrameGlowPicker({
  pref,
}: {
  pref: "main" | "quick";
}) {
  const t = useT();
  const value = useFontStore((s) => (pref === "main" ? s.frameGlowMain : s.frameGlowQuick));
  const setter = useFontStore((s) =>
    pref === "main" ? s.setFrameGlowMain : s.setFrameGlowQuick,
  );

  return (
    <div
      className="glow-picker"
      role="radiogroup"
      aria-label={t(pref === "main" ? "settings.frameGlowMain" : "settings.frameGlowQuick" as TKey)}
    >
      {PRESETS.map((p) => {
        const on = value === p.value;
        const none = p.value === FRAME_GLOW_NONE;
        return (
          <button
            key={p.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={`glow-chip${none ? " none" : ""}${on ? " on" : ""}`}
            style={p.swatch ? { background: p.swatch } : undefined}
            onClick={() => setter(p.value)}
            title={t(p.key)}
            aria-label={t(p.key)}
          />
        );
      })}
    </div>
  );
}
