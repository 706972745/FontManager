/**
 * BlinkCaretInput 的纯逻辑（2026-11-13 自绘闪烁块状光标）。
 *
 * 单独拆成无 JSX 的模块：`node --test` 只做类型剥离、不转 JSX，
 * 单测要直接 import 这些函数，就不能和组件同文件。
 */

/** 光标只在文本类输入框里有意义；其余类型退回普通 input，不自绘。 */
export const CARET_TYPES: ReadonlySet<string | undefined> = new Set([
  "text",
  "search",
  "url",
  "tel",
  "password",
  undefined,
]);

/** 把 selectionStart 夹进合法范围后切片（按 UTF-16 code unit，与 input 的 selectionStart 同一口径）。 */
export function sliceToCaret(value: string, selectionStart: number): string {
  const at = Math.max(0, Math.min(selectionStart, value.length));
  return value.slice(0, at);
}

/**
 * 算自绘光标的 x 坐标（相对输入框内容区左缘，px）。
 *
 * @param value          当前值（只用来夹取 selectionStart 的合法范围）
 * @param selectionStart 光标前的字符数（code unit 口径；越界时夹住，不产生 NaN）
 * @param mirrorWidth    镜像 span 实测宽度（`value.slice(0, selectionStart)` 的渲染宽度）
 * @param scrollLeft     输入框已横向滚出的像素
 * @param contentWidth   输入框内容区宽度（clientWidth − 左右 padding）
 * @returns 夹在 [0, contentWidth] 里的光标 x：文本滚到左边时光标贴左缘 0，
 *          选择点在末尾且文本超宽时贴右缘 contentWidth。
 */
export function computeCaretX(
  value: string,
  selectionStart: number,
  mirrorWidth: number,
  scrollLeft: number,
  contentWidth: number,
): number {
  // selectionStart 可能越界（程序化 setSelectionRange / 竞态）：夹进 [0, value.length]
  const at = Math.max(0, Math.min(selectionStart, value.length));
  // clamp 之后镜像文本最多 value.length 个字符，几何量不会为 NaN；at 只在这里用
  void at;
  if (!(contentWidth > 0)) return 0;
  const raw = mirrorWidth - scrollLeft;
  return Math.max(0, Math.min(raw, contentWidth));
}
