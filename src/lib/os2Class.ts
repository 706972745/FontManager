/**
 * OS/2 `sFamilyClass` 的 classId → **官方类名**（只读展示用）。
 *
 * 这套类目不是我们编的，也不是苹果编的：苹果 `CTFontStylisticClass` 的文档原话是
 * “These values correspond closely to the font class values in the OpenType OS/2 table”，
 * 而 Extensis Suitcase Fusion 的 `Classification`（serif / sans serif / script / ornamental…）
 * 也是同一支（Vox → OS/2 sFamilyClass → 各家 UI）。
 *
 * 所以「对齐别家软件的字体分类」这件事，抓到头的就是这 10 个值。它的问题也是共通的：
 * 本机 5552 个字体文件里只有 1528 个（27.5%）填了 classId；1124 个中日韩文件里
 * 233 个被填成 `Script`，抽查是 `EU-B3` / `301-CAI978` 这类模板值 —— 拿它当分类依据
 * 会把一整批中文族错标成手写体。
 *
 * **因此这里只展示，不产标签**：同一个字段已经以 `vox:*` 的形式进过标签体系
 * （见 `tagVocabulary.ts::VOX_BY_CLASS`），再用官方名字进一次等于同一件事说两遍，
 * 还会把标签云撑大一倍。这条界线别越过去 —— 要展示名可以，要参与筛选不行。
 */

/** OS/2 sFamilyClass 的 classId（高位字节）。6 / 11 是保留位，0 是「未分类」 */
export const OS2_CLASS_NAMES: Readonly<Record<number, string>> = {
  1: "Oldstyle Serifs",
  2: "Transitional Serifs",
  3: "Modern Serifs",
  4: "Clarendon Serifs",
  5: "Slab Serifs",
  7: "Freeform Serifs",
  8: "Sans Serif",
  9: "Ornamental",
  10: "Script",
  12: "Symbolic",
};

/** 只要有 classId 就返回官方类名；0 / 保留位 / 未知值一律 null */
export function os2ClassName(classId: number | null | undefined): string | null {
  if (!classId) return null;
  return OS2_CLASS_NAMES[classId] ?? null;
}

/**
 * 从一个字族的全部字面里取 OS/2 分类。
 *
 * 取**第一个有值**的字面就够：同族各字面的 sFamilyClass 理论上一致，不一致时
 * 谁先谁后没有意义（都是厂商填的），没必要为此排序或投票。
 */
export function os2ClassOf(
  faces: readonly { sFamilyClass?: number | null }[],
): { id: number; label: string } | null {
  for (const f of faces) {
    const raw = f.sFamilyClass ?? 0;
    if (raw <= 0) continue;
    // 高 8 位是 classId、低 8 位是 subclassId（后端给的是原始 16 位值）
    const id = raw >> 8;
    const label = os2ClassName(id);
    if (label) return { id, label };
  }
  return null;
}
