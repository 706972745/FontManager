/**
 * 主题偏好的类型与「默认值迁移」的纯逻辑（不碰 DOM，便于单测）。
 * 真正作用到界面的是 `lib/theme.ts` 的 `applyTheme`。
 */

export type ThemePref = "dark" | "light" | "system";

/**
 * 主题默认值从「深色」改成「跟随系统」（用户 2026-11-11）。
 *
 * 只改默认值对老用户没用：prefs 里有值就直接用存值，而 `persistPrefs` 会在
 * **任何**偏好变化时把 themePref 一起写盘 —— 所以「state.json 里是 dark」
 * 并不等于「用户主动选了深色」，绝大多数情况只是旧默认被顺手刷了进去。
 * 于是做一次性迁移：**没有迁移标记**且**存值仍是旧默认 dark** 时才改成 system。
 * 用户之后自己选回深色，标记会一起落盘，不会被每次启动改回去。
 */
export const THEME_MIGRATED_KEY = "themeDefaultMigratedToSystem";
export const LEGACY_THEME_PREF: ThemePref = "dark";

function isThemePref(v: unknown): v is ThemePref {
  return v === "dark" || v === "light" || v === "system";
}

/**
 * 从 prefs 里定出这次启动用哪个主题。
 * `migrated` = 这一趟真的把旧默认改掉了（调用方据此把结果立刻落盘）。
 */
export function pickThemePref(prefs: Record<string, unknown> | null | undefined): {
  pref: ThemePref;
  migrated: boolean;
} {
  const stored = prefs?.themePref;
  // 没有值（新装 / 老版本没存过）= 跟随系统
  if (!isThemePref(stored)) return { pref: "system", migrated: false };
  if (prefs?.[THEME_MIGRATED_KEY] !== true && stored === LEGACY_THEME_PREF) {
    return { pref: "system", migrated: true };
  }
  return { pref: stored, migrated: false };
}
