/**
 * 速览的唤出快捷键。
 *
 * 以前 Alt+` 是写死的：用户只要和别的软件撞了键，除了忍着没有别的办法。
 * 这里把它变成一份「虚拟键码 + 修饰键」的配置，前后端共用：
 * - 前端负责在设置里录键、在页面内匹配按键；
 * - 原生侧（window_dock.rs）用同一份数据去 RegisterHotKey。
 *
 * 用 `keyCode`（Virtual-Key）而不是 `key`：`key` 会随输入法 / 键盘布局变化
 * （中文输入法下按 ` 可能拿到别的字符），而 keyCode 就是 Win32 的 VK 码，
 * 直接能喂给 RegisterHotKey，两边语义完全一致。
 */

export interface HotkeySpec {
  /** Win32 Virtual-Key（KeyboardEvent.keyCode） */
  vk: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** 展示用文案（录键时按用户实际看到的样子存下来，如 "Alt + `"） */
  label: string;
}

/** 默认 Alt + `（VK_OEM_3 = 192） */
export const DEFAULT_HOTKEY: HotkeySpec = {
  vk: 192,
  ctrl: false,
  alt: true,
  shift: false,
  meta: false,
  label: "Alt + `",
};

/** 允许「不带修饰键」单独触发的键：功能键 F1–F24 */
const BARE_ALLOWED = new Set(
  Array.from({ length: 24 }, (_, i) => 112 + i), // VK_F1 = 112
);

/** 这些键不能单独当快捷键（会和打字 / 系统操作打架） */
const NEVER_ALONE = new Set([
  8, 9, 13, 16, 17, 18, 19, 20, 27, 32, 33, 34, 35, 36, 37, 38, 39, 40, // 退格/Tab/回车/修饰键/Esc/空格/翻页/方向键
  91, 92, // Win
]);

/** 修饰键自身的 VK：Shift / Ctrl / Alt / Win（左右都算） */
const MODIFIER_VKS = new Set([16, 17, 18, 91, 92, 93]);

/**
 * 把一个 keydown 事件读成快捷键。返回 null 表示这个组合不能当快捷键：
 * - 只按了修饰键本身；
 * - 既没有 Ctrl/Alt/Win，又不是功能键（否则等于把普通输入抢走了）。
 */
export function hotkeyFromEvent(e: KeyboardEvent): HotkeySpec | null {
  const vk = e.keyCode;
  if (!vk) return null;
  // 修饰键本身一律先等着，别急着确定。
  // 注意不能写成「按了 Ctrl 但 ctrlKey 为 false 才算单独修饰键」：按下 Ctrl 的那一刻
  // ctrlKey 已经是 true，于是 Ctrl 键自己的 keydown 会被当成一个完整组合采纳，
  // 录出来是「Ctrl + Control」这种没有主键的东西——用户想录 Ctrl+Shift+K 必然踩到。
  if (MODIFIER_VKS.has(vk)) return null;

  const ctrl = e.ctrlKey;
  const alt = e.altKey;
  const shift = e.shiftKey;
  const meta = e.metaKey;
  const hasMod = ctrl || alt || meta;
  if (!hasMod && !BARE_ALLOWED.has(vk)) return null;
  // Shift 单独 + 普通键仍会抢输入（比如 Shift+A），但 Shift+F8 这种可以
  if (!hasMod && shift && !BARE_ALLOWED.has(vk)) return null;
  if (NEVER_ALONE.has(vk) && !hasMod) return null;

  const parts: string[] = [];
  if (ctrl) parts.push("Ctrl");
  if (alt) parts.push("Alt");
  if (shift) parts.push("Shift");
  if (meta) parts.push("Win");
  parts.push(keyLabel(e));
  return { vk, ctrl, alt, shift, meta, label: parts.join(" + ") };
}

/** 按键的显示名：优先用用户实际按出来的字符，其次用 code */
function keyLabel(e: KeyboardEvent): string {
  const k = e.key;
  if (k === " ") return "Space";
  if (k === "Control" || k === "Alt" || k === "Shift" || k === "Meta") return k;
  if (k && k.length <= 3) return k.length === 1 ? k.toUpperCase() : k;
  // F1 / ArrowUp 之类
  if (k && k.startsWith("F") && k.length <= 3) return k;
  return e.code || "?";
}

/** 事件是否命中配置的快捷键（前后端语义一致） */
export function matchesHotkey(e: KeyboardEvent, hk: HotkeySpec): boolean {
  return (
    e.keyCode === hk.vk &&
    e.ctrlKey === hk.ctrl &&
    e.altKey === hk.alt &&
    e.shiftKey === hk.shift &&
    e.metaKey === hk.meta
  );
}

/** 把偏好里读出来的原始值规范化（缺字段 / 脏数据一律退回默认） */
export function normalizeHotkey(raw: unknown): HotkeySpec {
  if (!raw || typeof raw !== "object") return DEFAULT_HOTKEY;
  const r = raw as Partial<HotkeySpec>;
  if (typeof r.vk !== "number" || !Number.isFinite(r.vk)) return DEFAULT_HOTKEY;
  return {
    vk: r.vk,
    ctrl: r.ctrl === true,
    alt: r.alt === true,
    shift: r.shift === true,
    meta: r.meta === true,
    label: typeof r.label === "string" && r.label ? r.label : DEFAULT_HOTKEY.label,
  };
}
