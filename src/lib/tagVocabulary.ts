/**
 * 自动标签的受控词表（唯一真源）。
 *
 * 为什么单独一个文件：词表会反复调，而调词表**不能**顺手改到判定逻辑；
 * 反过来，逻辑改动也不该悄悄多出几个关键词。两者分开放，评审时能一眼看清
 * 「这次是改了词，还是改了判定」。
 *
 * 与 Rust 侧 `parser.rs` 的关系（重要，别踩）：
 *   Rust 的 `*_KEYWORDS` 决定**一级分类**（衬线/无衬线/等宽/展示/手写），
 *   这里的词表只决定**附加标签**（中文书体、装饰工艺、形态、Vox 子类…）。
 *   两份词表**故意不共用**，因为目标不同：分类要「宁可给个兜底也不要 Unknown」，
 *   标签要「宁可不给也不要给错」。所以这里的中文书体词比 Rust 更窄
 *   （例如只认「明朝 / 明體 / mincho」而不认单字「明」，只认「仿宋」而不认单字「仿」）。
 *   但**同一个词在两边的含义必须一致** —— `tests/derivedTags.test.ts` 里有一条
 *   一致性断言：这里出现的每个中文书体词，必须能在 parser.rs 的词表里找到，
 *   防止前端凭空造出后端不承认的口径。
 */

/**
 * 命名空间白名单。不在表里的前缀一律不产。
 *
 * `class` 是 2.1.7 新增的：一级分类（衬线/无衬线/等宽/展示/手写）原来是筛选菜单里的
 * 一组只读选项，用户要求改成**可编辑的标签** —— 这样既能筛选，也能手工增删、能跟
 * 其它标签一样被否决与记忆。`cat:` / `lang:` / `origin:` 仍然不产（它们有别的落点）。
 */
export const NAMESPACES = {
  class: { label: "tag.ns.class", hint: "tag.ns.classHint" },
  cn: { label: "tag.ns.cn", hint: "tag.ns.cnHint" },
  vox: { label: "tag.ns.vox", hint: "tag.ns.voxHint" },
  decor: { label: "tag.ns.decor", hint: "tag.ns.decorHint" },
  form: { label: "tag.ns.form", hint: "tag.ns.formHint" },
  use: { label: "tag.ns.use", hint: "tag.ns.useHint" },
  tech: { label: "tag.ns.tech", hint: "tag.ns.techHint" },
  style: { label: "tag.ns.style", hint: "tag.ns.styleHint" },
  weight: { label: "tag.ns.weight", hint: "tag.ns.weightHint" },
} as const;

export type Namespace = keyof typeof NAMESPACES;

/**
 * 互斥命名空间：一个字族在一个命名空间里最多只有一个值。
 *
 * 中文书体（宋/黑/楷/隶）与 Vox 子类（garalde/didone）都是**同一维度上的不同取值**，
 * 一个字族不可能既是宋体又是黑体。装饰工艺（描边 + 阴影）和形态（紧凑 + 粗）
 * 则可以并存，所以不在此列。
 *
 * 落地效果：用户手工给某族打了 `cn:kai`，该族所有自动推导出的 `cn:*` 都要让位 ——
 * 这正是「用户手动改了标签，软件不能再用自己那套覆盖」的硬闸之一。
 */
export const EXCLUSIVE_NAMESPACES: ReadonlySet<Namespace> = new Set<Namespace>([
  "class",
  "cn",
  "vox",
]);

/**
 * 一级分类 → `class:*` 标签。
 *
 * 这些值本来就是 `familyClassification()` 算出来的结论（族内全部字面联合判定），
 * 以前只在筛选菜单里露一面，用户既改不了也记不住。改成标签之后：能筛、能手删、
 * 能被否决名单记住，也就能跟用户自己的标签体系混着用。
 *
 * **`form:display` / `form:script` / `tech:monospaced` 已经从规则里删掉** —— 它们与
 * `class:display` / `class:script` / `class:mono` 是同一件事，一个族同时挂「展示体」
 * 和「form:display」只会让标签云变吵。
 */
export const CLASS_TAGS: Readonly<Record<string, string>> = {
  serif: "class:serif",
  sans: "class:sans",
  mono: "class:mono",
  display: "class:display",
  script: "class:script",
};

/**
 * 中文书体（`cn:*`）。**顺序即优先级，先命中者胜**，因此只产一个。
 *
 * 排序依据是「谁更具体」：
 *  - 仿宋在宋之前（「仿宋」两个字里含「宋」）；
 *  - 行楷/行草在楷之前（「行楷」里含「楷」）；
 *  - 魏碑在楷/隶之前（魏碑常被写成「魏碑楷书」）；
 *  - 美术字最后（它的关键词最宽松，放前面会抢走本来就判得出的书体）。
 */
export const CN_STYLES: ReadonlyArray<{ value: string; words: readonly string[] }> = [
  { value: "cn:fangsong", words: ["仿宋", "仿宋体", "仿宋體", "fangsong"] },
  { value: "cn:xingcao", words: ["行书", "行書", "行草", "行楷", "草书", "草書", "caoshu", "xingshu"] },
  { value: "cn:weibei", words: ["魏碑", "北魏"] },
  { value: "cn:li", words: ["隶", "隸", "clerical", "lishu"] },
  { value: "cn:kai", words: ["楷", "kaiti", "楷体", "楷體"] },
  { value: "cn:song", words: ["宋", "明朝", "明體", "明体", "细明", "細明", "mincho", "songti", "song"] },
  { value: "cn:yuan", words: ["圆体", "圓體", "幼圆", "幼圓", "圓緣", "丸ゴ", "rounded", "yuanti"] },
  {
    value: "cn:hei",
    words: ["黑", "hei", "雅黑", "等线", "等線", "ゴシック", "gothic", "dengxian", "dotum", "gulim"],
  },
  {
    value: "cn:meishu",
    words: [
      "综艺", "综藝", "琥珀", "彩云", "彩雲", "娃娃", "布丁", "彩带", "彩帶", "卡通", "漫画", "漫畫",
      "像素", "描边", "描邊", "剪纸", "剪紙", "倩体", "倩體", "童体", "童體", "菱心", "版画", "版畫",
      "糖果", "花体", "花體",
    ],
  },
  { value: "cn:mono", words: ["等宽", "等寬"] },
];

/** 装饰工艺（`decor:*`）：现有筛选器完全没有的维度，可以多个并存 */
export const DECOR_WORDS: ReadonlyArray<{ value: string; words: readonly string[] }> = [
  { value: "decor:stencil", words: ["stencil", "模版", "模板"] },
  { value: "decor:inline", words: ["inline", "内嵌", "內嵌", "双线", "雙線"] },
  { value: "decor:shadow", words: ["shadow", "阴影", "陰影", "立体", "立體", "3d"] },
  { value: "decor:outline", words: ["outline", "描边", "描邊", "空心", "镂空", "鏤空"] },
  { value: "decor:pixel", words: ["pixel", "像素", "点阵", "點陣", "bitmap"] },
  { value: "decor:rounded", words: ["rounded", "幼圆", "幼圓", "圆体", "圓體"] },
  { value: "decor:layered", words: ["layered", "叠层", "疊層", "多层", "多層", "3d layered"] },
];

/** 用途（`use:*`）：主观判断，主要进「建议」档 */
export const USE_WORDS = {
  code: ["code", "coding", "program", "mono code", "编程", "編程", "代码", "代碼"],
  poster: ["poster", "headline", "title", "display", "海报", "海報", "标题", "標題", "招牌"],
  /** 公众号 / 电商banner 这类中文场景词，命中即「展示/海报」用途的弱证据 */
  banner: ["banner", "广告", "廣告", "宣传", "宣傳", "促销", "促銷"],
} as const;

/**
 * 西文子类（`vox:*`）→ `sFamilyClass` 的 `(classId, subclassId)` 映射。
 *
 * 这个字段就是同事文档里被当成「主证据」的那个，但实测有效值只覆盖 27.5% 的字族。
 * 在这里它**只作附加标签**、且只在有值时产，永远不参与分类决策。
 */
export const VOX_BY_CLASS: Readonly<Record<string, string>> = {
  "8/1": "vox:rounded-sans",
  "8/2": "vox:humanist-sans",
  "8/4": "vox:grotesque",
  "8/5": "vox:neo-grotesque",
  "1/1": "vox:venetian",
  "1/2": "vox:garalde",
  "1/3": "vox:modern-serif",
  "2/1": "vox:transitional",
  "3/1": "vox:didone",
  "5/0": "vox:slab",
  "7/0": "vox:freeform-serif",
};

/** 宽度词：字面样式名里出现就相当可靠（比 PANOSE 的 bProportion 可信） */
export const WIDTH_WORDS = {
  condensed: ["condensed", "narrow", "compressed", "紧凑", "緊湊", "窄"],
  extended: ["extended", "expanded", "wide", "宽体", "寬體"],
} as const;

/** 命名空间（`cn:song` → `cn`），没有冒号返回 null */
export function namespaceOf(tag: string): Namespace | null {
  const i = tag.indexOf(":");
  if (i <= 0) return null;
  const ns = tag.slice(0, i).toLowerCase();
  return ns in NAMESPACES ? (ns as Namespace) : null;
}

/**
 * 引擎能产出的**全部**标签 id。
 *
 * 用途只有一个：决定一个标签在界面上该画「魔棒」还是「标签」图标。
 * 这件事必须按**名字**判定，不能按「这条标签是存进 state.json 的、还是运行时推出来的」判定 ——
 * 用户 2026-11-14 明确要求：
 *   ① 用户把自动标签「认可」成手工标签之后，它仍然是软件词表里的名字，图标不能变回手工；
 *   ② 用户删掉某条自动标签、后来又手动打了一样的名字，也照样是魔棒。
 * 反过来，用户自己造的词（「品牌A专用」「待确认授权」）永远是标签图标。
 *
 * 词表驱动的部分（class / cn / decor / vox / use / form 宽度）直接从这里的数据算；
 * `derivedTags.ts` 里还有一批**字面量规则**（form 的 heavy / tech:* / style / weight），
 * 它们没法从数据推，只能列在这里 —— `tests/tagVocabulary.test.ts` 会扫 `derivedTags.ts`
 * 源码里的 `tag: "..."` 逐条断言没漏，漏一条就红。
 */
export const AUTO_TAG_IDS: ReadonlySet<string> = new Set<string>([
  ...Object.values(CLASS_TAGS),
  ...CN_STYLES.map((s) => s.value),
  ...DECOR_WORDS.map((d) => d.value),
  ...Object.values(VOX_BY_CLASS),
  ...Object.keys(USE_WORDS).map((k) => `use:${k}`),
  ...Object.keys(WIDTH_WORDS).map((k) => `form:${k}`),
  // ↓ 字面量规则（derivedTags.ts），新增规则时两条都要改
  "form:heavy",
  "form:high-contrast",
  "form:large-xheight",
  "form:low-contrast",
  "tech:weight-axis",
  "tech:width-axis",
  "tech:optical-size",
  "tech:small-caps",
  "tech:tabular-figures",
  "tech:oldstyle-figures",
  "tech:swash",
  "tech:monospaced-candidate",
  "style:italic",
  "weight:has-bold",
]);

/** 这个名字是不是软件自己的标签（决定用魔棒还是标签图标） */
export function isAutoTagId(tag: string): boolean {
  return AUTO_TAG_IDS.has(tag);
}
