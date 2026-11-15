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

/**
 * 蓝块高度（px）：**只跟字号走，不跟输入框高度走**（2026-11-15 用户口径「比字大一点就行」）。
 *
 * 用户给的参考截图里：36px 高的输入框、13px 字号，蓝块实测 ~15px 高、垂直居中，
 * 也就是说块只占输入框 42%。旧实现用 `top:0;bottom:0` 撑满输入框，字越大反而越突兀。
 * 这里取 `字号 + 2`，并给 14px 下限（9/10px 的小字控件也不至于细成一条线）。
 */
export function caretHeightFor(fontSizePx: number): number {
  const fs = Number.isFinite(fontSizePx) && fontSizePx > 0 ? fontSizePx : 13;
  return Math.max(14, Math.round(fs + 2));
}

/** 蓝块在输入框里垂直居中时的 top（px）。clamp 到 0，避免极小控件出现负偏移。 */
export function caretTopFor(inputHeightPx: number, caretHeightPx: number): number {
  const h = Number.isFinite(inputHeightPx) && inputHeightPx > 0 ? inputHeightPx : caretHeightPx;
  return Math.max(0, Math.round((h - caretHeightPx) / 2));
}

/** 块状光标的几何盒（坐标相对输入框内容区左缘，px）。 */
export interface CoveredCharBox {
  /** 块左缘：已做左缘裁切（滚出可视区左边的部分收回到 0）。 */
  left: number;
  /** 块宽：被左缘裁切后可能变小；右缘不裁，wrapper 的 overflow:hidden 兜住。 */
  width: number;
  /** 被覆盖的字符（含完整增补平面对）；空输入为 null。 */
  char: string | null;
  /** 白字形相对块左缘的偏移（可为负：滚出可视区左边的部分由块 overflow:hidden 裁掉）。 */
  glyphShift: number;
}

/**
 * 算块状光标的几何：盖住光标前面那个字符。
 *
 * 「清晰度优先于严丝合缝」（用户 2026-11-13 补充口径）：块比字符**宽一档**
 * （`blockPad` 左右各加几 px），白字四周留蓝边，一眼看清是哪个字。
 *
 * @param value       当前值
 * @param selectionStart 光标位置（code unit；越界先夹取）
 * @param startWidth  镜像实测宽：`value.slice(0, coveredIndex)` —— 字符左缘到内容区左缘的距离
 * @param charWidth   镜像实测宽：被覆盖的**单个字符**（中文 = 全宽、拉丁 = 窄宽，天然自适应）
 * @param scrollLeft  输入框已横向滚出的像素
 * @param _contentWidth 输入框内容区宽度。**当前未用**：右缘裁切交给 wrapper 的
 *   overflow:hidden（块允许部分可见），左缘裁切在函数内做；留参数位以便将来
 *   需要按右缘收窄时不用改调用方。
 * @param blockPad    块比字符左右各多出的内边距（px）；0 = 严丝合缝。
 * @returns 盒子；空输入时 char = null（组件渲染空块，宽度走 CSS）。
 */
export function coveredCharBox(
  value: string,
  selectionStart: number,
  startWidth: number,
  charWidth: number,
  scrollLeft: number,
  _contentWidth: number,
  blockPad = 0,
): CoveredCharBox {
  const idx = coveredIndexFor(value, selectionStart);
  if (idx < 0 || value.length === 0) {
    return { left: 0, width: 0, char: null, glyphShift: 0 };
  }
  const rawCharLeft = startWidth - scrollLeft;
  // 块左缘 = 字符左缘 − blockPad；滚出可视区左边的部分夹回 0
  const rawLeft = rawCharLeft - blockPad;
  const left = Math.max(0, rawLeft);
  // 白字形相对块左缘的偏移：可为负（字符滚出左边时白字也被块裁掉一半，
  // 与底下真实字形的可见部分保持一致）
  const glyphShift = rawCharLeft - left;
  // 块右缘 = 字符右缘 + blockPad；宽度 = 右缘 − 左缘
  const width = Math.max(0, glyphShift + charWidth + blockPad);
  const char = value.slice(idx, idx + charLengthAt(value, idx));
  return { left, width, char, glyphShift };
}
