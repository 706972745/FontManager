/**
 * BlinkCaretInput 的纯逻辑（2026-11-13 自绘闪烁块状光标；同日重做为「蓝块包字+白字」）。
 *
 * 单独拆成无 JSX 的模块：`node --test` 只做类型剥离、不转 JSX，
 * 单测要直接 import 这些函数，就不能和组件同文件。
 */

/** 光标只在文本类输入框里有意义；其余类型退回普通 input，不自绘。
 *
 * **password 必须留在集合外**：镜像 span 会把 `value.slice(0, selectionStart)`
 * 渲染成明文塞进 DOM —— `visibility:hidden` 挡不住 devtools / 爬 DOM。
 * 密码框走退回路径（普通 input + 原生光标），绝不能自绘。 */
export const CARET_TYPES: ReadonlySet<string | undefined> = new Set([
  "text",
  "search",
  "url",
  "tel",
  undefined,
]);

function isHighSurrogate(c: string | undefined): boolean {
  return c !== undefined && c >= "\ud800" && c <= "\udbff";
}
function isLowSurrogate(c: string | undefined): boolean {
  return c !== undefined && c >= "\udc00" && c <= "\udfff";
}

/**
 * 被块状光标覆盖的字符的下标（code unit 口径）。
 *
 * 规则：盖住光标**前面**那个字符；光标在最前且有内容时盖住第一个字符；
 * 空输入返回 -1（组件退化为 0.55em 空块）。selectionStart 越界先夹进
 * [0, value.length]。
 *
 * 增补平面回退：`𝐀` 占两个 code unit，光标在它后面时 selectionStart-1 落在
 * **低位代理**上 —— 回退到高位代理，整对字符一起盖，否则镜像会渲染出半个字符。
 */
export function coveredIndexFor(value: string, selectionStart: number): number {
  const sel = Math.max(0, Math.min(selectionStart, value.length));
  let idx = sel > 0 ? sel - 1 : value.length > 0 ? 0 : -1;
  if (idx > 0 && isLowSurrogate(value[idx]) && isHighSurrogate(value[idx - 1])) {
    idx -= 1;
  }
  return idx;
}

/** `value[idx]` 处那个字符占几个 code unit（增补平面 = 2，其余 = 1）。 */
export function charLengthAt(value: string, idx: number): number {
  if (idx >= 0 && idx < value.length && isHighSurrogate(value[idx]) && isLowSurrogate(value[idx + 1])) {
    return 2;
  }
  return 1;
}

/** 块状光标的几何盒（坐标相对输入框内容区左缘，px）。 */
export interface CoveredCharBox {
  /** 块左缘：已做左缘裁切（滚出可视区左边的部分收回到 0）。 */
  left: number;
  /** 块宽：被左缘裁切后可能小于字符 advance；右缘不裁，wrapper 的 overflow:hidden 兜住。 */
  width: number;
  /** 被覆盖的字符（含完整增补平面对）；空输入为 null。 */
  char: string | null;
  /** 白字形相对块左缘的偏移（左缘被裁时 > 0，让白字贴回字符的真实位置）。 */
  glyphShift: number;
}

/**
 * 算块状光标的几何：盖住光标前面那个字符。
 *
 * @param value       当前值
 * @param selectionStart 光标位置（code unit；越界先夹取）
 * @param startWidth  镜像实测宽：`value.slice(0, coveredIndex)` —— 字符左缘到内容区左缘的距离
 * @param charWidth   镜像实测宽：被覆盖的**单个字符**（中文 = 全宽、拉丁 = 窄宽，天然自适应）
 * @param scrollLeft  输入框已横向滚出的像素
 * @param _contentWidth 输入框内容区宽度。**当前未用**：右缘裁切交给 wrapper 的
 *   overflow:hidden（块允许部分可见），左缘裁切在函数内做；留参数位以便将来
 *   需要按右缘收窄时不用改调用方。
 * @returns 盒子；空输入时 char = null（组件渲染 0.55em 空块）。
 */
export function coveredCharBox(
  value: string,
  selectionStart: number,
  startWidth: number,
  charWidth: number,
  scrollLeft: number,
  _contentWidth: number,
): CoveredCharBox {
  const idx = coveredIndexFor(value, selectionStart);
  if (idx < 0 || value.length === 0) {
    return { left: 0, width: 0, char: null, glyphShift: 0 };
  }
  const rawLeft = startWidth - scrollLeft;
  // 左缘裁切：字符滚出可视区左边的部分收回到 0，白字形用 glyphShift 贴回真实位置；
  // 右缘交给 wrapper 的 overflow:hidden（块可以部分可见）。
  const left = Math.max(0, rawLeft);
  const glyphShift = left - rawLeft;
  const width = Math.max(0, charWidth - glyphShift);
  const char = value.slice(idx, idx + charLengthAt(value, idx));
  return { left, width, char, glyphShift };
}
