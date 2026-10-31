/**
 * 列表子集通道要用到的字符集（交接文档 §12.6）。
 *
 * 卡片上真正**用这款字体渲染**的文字只有三类：
 *   1. 示例文字（主预览行 + 字重行）；
 *   2. 速览条目的 `Aa` 位与显示名；
 *   3. 字重行的 style 名（`Regular` / `粗体` …）。
 *
 * 卡片标题（字族名）在完整界面是 UI 字体渲染的，本来不需要 —— **但它必须加进来**：
 *   1. 纯汉字字体的 cmap 里一个拉丁字符都没有，只用默认示例文字会「0 命中」，
 *      整条子集路线对它直接失效；而中文大盘字恰好是库里最多、最贵的那批。
 *   2. **速览的族名是用该字体渲染的**（`displayName(family)`），不是 UI 字体。
 *      而 `displayFamilyName` 会按界面语言从 `localizedNames` 里挑一条 ——
 *      只放 `family.name` 的话，中文界面下那串中文名就不在子集里，
 *      表现为「速览里的族名回退成系统字体」（用户 2026-11-01 报的正是这个）。
 *      所以这里把**所有语言的名字**都收进来：既覆盖当前语言，也保证切语言时
 *      字符集不变、不会白生成一份新子集。
 *
 * 返回 `null` 表示**这条不走子集**，只有两种情况：
 *   1. 没有字族（列表还没就绪）；
 *   2. 自定义示例文字**过长**（> {@link MAX_CUSTOM_SAMPLE} 字符）。
 *
 * 2026-11-01 改了一条旧规则：原来只要是「自定义示例文字」就整条回退完整链路（§12.7-C），
 * 理由是「输入框 debounce 期间变体爆炸」。实际后果是**用户一改示例文字，这条优化就永久关掉**，
 * 而且没有任何提示 —— 用户把默认的 `Hello IIEOzo` 改成 `Hello IIEOzoa` 之后，
 * 所有大字体又回到 15ms 级首帧。现在改为：自定义文字照常走子集，只用长度上限兜住
 * 「整段句子/多行文本」那种明显不是预览用途的输入。变体数量靠 LRU 自然收敛。
 */
export const MAX_CUSTOM_SAMPLE = 32;

export type ListCharsFamily = {
  name: string;
  faces: {
    style?: string | null;
    postscriptName?: string | null;
    localizedNames?: { lang: string; name: string }[] | null;
  }[];
};

export function listChars(
  family: ListCharsFamily | null | undefined,
  sampleText: string,
  defaultSample: string,
): string | null {
  if (!family) return null;
  const typed = (sampleText ?? "").trim();
  const fallback = (defaultSample ?? "").trim();
  if ([...typed].length > MAX_CUSTOM_SAMPLE) return null;
  // 空输入时用默认示例渲染（与界面一致），否则用用户输入的那串
  const sample = typed !== "" ? typed : fallback;

  const parts: string[] = [sample, family.name ?? "", "Aa"];
  for (const f of family.faces ?? []) {
    if (f?.style) parts.push(f.style);
    // style 为空时字重行会退到 PostScript 名，那也是要渲染的
    if (f?.postscriptName) parts.push(f.postscriptName);
    // 速览的族名按界面语言取，可能和 family.name 不是同一串
    for (const entry of f?.localizedNames ?? []) {
      if (entry?.name) parts.push(entry.name);
    }
  }
  // 去重 + 按码点排序：后端也做同样的规范化，两边顺序一致才能命中同一份缓存
  const set = new Set<string>();
  for (const p of parts) for (const ch of p) set.add(ch);
  return [...set].sort().join("");
}
