import type { TKey } from "./i18n";

/**
 * 自动标签的**显示名**（2.1.7）。
 *
 * 内部标识永远是 `维度:取值`（`cn:song` / `class:serif`），它才是落盘、筛选、否决名单、
 * 搜索匹配用的东西；这里只负责「显示给人看的那一层」。分开的理由很实际：
 *  - 用户切语言时标签名要跟着变，但 `state.json` 里的 `cn:song` 不能变（否则等于换个语言
 *    就把标签全丢了，否决名单也全对不上）；
 *  - 同一条标签在不同语言下长度差很多，显示层可以随便改，匹配层一动不能动。
 *
 * **Vox 子类刻意不翻译**（`vox:neo-grotesque` → `Neo-grotesque`）：Garalde / Didone /
 * Neo-grotesque 是字体史里的专有名词，翻成「新怪诞体」反而让专业用户对不上文献和别家软件。
 * 这一条就是用户说的「除非一些名词必须是英文」。
 */
export const TAG_LABEL_KEYS: Readonly<Record<string, TKey>> = {
  // 一级分类：用户 2026-11-14 点名要的五个中文名（衬线体 / 无衬线体 / 等宽 / 展示体 / 手写体）
  "class:serif": "tagl.cls.serif",
  "class:sans": "tagl.cls.sans",
  "class:mono": "tagl.cls.mono",
  "class:display": "tagl.cls.display",
  "class:script": "tagl.cls.script",

  // 中文书体
  "cn:song": "tagl.cn.song",
  "cn:hei": "tagl.cn.hei",
  "cn:kai": "tagl.cn.kai",
  "cn:li": "tagl.cn.li",
  "cn:weibei": "tagl.cn.weibei",
  "cn:xingcao": "tagl.cn.xingcao",
  "cn:yuan": "tagl.cn.yuan",
  "cn:fangsong": "tagl.cn.fangsong",
  "cn:meishu": "tagl.cn.meishu",
  "cn:mono": "tagl.cn.mono",

  // 装饰工艺
  "decor:outline": "tagl.decor.outline",
  "decor:inline": "tagl.decor.inline",
  "decor:shadow": "tagl.decor.shadow",
  "decor:pixel": "tagl.decor.pixel",
  "decor:stencil": "tagl.decor.stencil",
  "decor:rounded": "tagl.decor.rounded",
  "decor:layered": "tagl.decor.layered",

  // 形态
  "form:heavy": "tagl.form.heavy",
  "form:condensed": "tagl.form.condensed",
  "form:extended": "tagl.form.extended",
  "form:high-contrast": "tagl.form.highContrast",
  "form:low-contrast": "tagl.form.lowContrast",
  "form:large-xheight": "tagl.form.largeXHeight",

  // 技术能力
  "tech:tabular-figures": "tagl.tech.tabularFigures",
  "tech:oldstyle-figures": "tagl.tech.oldstyleFigures",
  "tech:small-caps": "tagl.tech.smallCaps",
  "tech:swash": "tagl.tech.swash",
  "tech:weight-axis": "tagl.tech.weightAxis",
  "tech:width-axis": "tagl.tech.widthAxis",
  "tech:optical-size": "tagl.tech.opticalSize",
  "tech:monospaced-candidate": "tagl.tech.monospacedCandidate",

  // 用途 / 字面特征
  "use:code": "tagl.use.code",
  "use:poster": "tagl.use.poster",
  "use:banner": "tagl.use.banner",
  "style:italic": "tagl.style.italic",
  "weight:has-bold": "tagl.weight.hasBold",
};

/** `neo-grotesque` → `Neo-grotesque`：只提首字母，保留连字符（专有名词的就手写法） */
function prettyVox(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * 标签 → 给人看的名字。
 *
 * 回退顺序：词表 → Vox 专名 → **原样返回**。最后那条很重要：用户自己打的标签
 * 不是我们的词表值，任何「猜测式翻译」都会把 `我的宋体` 变成别的东西；
 * 未知的自动标签也宁可露原值，方便排查而不是悄悄显示成半截中文。
 */
export function tagLabel(tag: string, t: (key: TKey) => string): string {
  const key = TAG_LABEL_KEYS[tag];
  if (key) return t(key);
  const sep = tag.indexOf(":");
  if (sep < 0) return tag;
  const ns = tag.slice(0, sep);
  const value = tag.slice(sep + 1);
  if (ns === "vox") return prettyVox(value);
  return tag;
}

/** 排序用：按显示名排，中文按本地排序规则（`localeCompare` 在 zh 下是拼音序） */
export function tagSortKey(tag: string, t: (key: TKey) => string): string {
  return tagLabel(tag, t);
}
