/**
 * 列表子集通道要用到的字符集（交接文档 §12.6）。
 *
 * 卡片上真正**用这款字体渲染**的文字只有三类：
 *   1. 示例文字（主预览行 + 字重行）；
 *   2. 速览条目的 `Aa` 位与显示名；
 *   3. 字重行的 style 名（`Regular` / `粗体` …）。
 *
 * 卡片标题（字族名）其实是 UI 字体渲染的，本来不需要 —— **但它必须加进来**：
 * 纯汉字字体的 cmap 里一个拉丁字符都没有，只用默认示例文字会「0 命中」，
 * 整条子集路线对它直接失效，而中文大盘字恰好是库里最多、最贵的那批。
 * 多带几十个汉字只让产物多几十 KB，换来覆盖全库。
 *
 * 返回 `null` 表示**这条不走子集**：用户自定义了示例文字（§12.7-C）。
 * 字符集一改就得多一份产物，输入框还在 debounce 时变体会爆炸；
 * 这种情况下回退完整字体链路（现有行为），示例文字清空/复原后再回到子集。
 */
export type ListCharsFamily = {
  name: string;
  faces: { style?: string | null }[];
};

export function listChars(
  family: ListCharsFamily | null | undefined,
  sampleText: string,
  defaultSample: string,
): string | null {
  if (!family) return null;
  const typed = (sampleText ?? "").trim();
  const fallback = (defaultSample ?? "").trim();
  // 只认「没输入」和「还是默认那句」两种；自定义文字一律回退完整链路
  if (typed !== "" && typed !== fallback) return null;

  const parts: string[] = [typed, family.name ?? "", "Aa"];
  for (const f of family.faces ?? []) {
    if (f?.style) parts.push(f.style);
  }
  // 去重 + 按码点排序：后端也做同样的规范化，两边顺序一致才能命中同一份缓存
  const set = new Set<string>();
  for (const p of parts) for (const ch of p) set.add(ch);
  return [...set].sort().join("");
}
