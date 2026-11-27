/**
 * 网格视图的行高（一条 .grid-row = 一张 .family-card + 行底间距）。
 *
 * 为什么需要这个模块：`@tanstack/react-virtual` 在**第一次**渲染某个位置时必须先给一个
 * 估高（`estimateSize`），之后才由 `measureElement` 逐行校正。估高偏小 → 总高虚小 →
 * 滚动条拇指在滚动过程中被逐行「补高」而变长，`scrollToIndex` 的远距跳转也会「先落错再挪」。
 * 所以这里的唯一目标是：让初值与真实行高对齐（对齐后仍由 measureElement 做最终校正）。
 *
 * 单独成文件（不是写在 FontGrid.tsx 里）是为了能被 `node --test` 直接 import：
 * 测试跑的是 Node 的类型擦除，只能吃 `.ts`，吃不了 `.tsx`。
 *
 * ── 算式推导（逐项对应 CSS，全部是实测行号的现状值，不许写魔法数）────────────
 *
 * 盒模型前提：`src/design/tokens.css:212-215` 的 `* { margin: 0; padding: 0;
 * box-sizing: border-box }` —— 所有元素 border-box，`min-height` 含内边距与边框。
 *
 * 1) 行 `.grid-row`（`src/app.css:1098-1100`）：只有 `padding-bottom: 14px`，
 *    没有上下内边距之外的东西 → 行高 = 卡片高 + 14。
 *
 * 2) 卡片 `.family-card`（`src/app.css:8131-8141`）：
 *      `padding: 20px 24px 22px 26px` → 上 20 / 下 22（左右不参与纵向）；
 *      `border: 0` 之后又给了 `border-bottom: 1px` → 纵向边框合计 1px；
 *      `min-height: 196px`（border-box，含内边距与边框）→ 卡片高 = max(196, 内容高 + 20 + 22 + 1)。
 *
 * 3) 卡片内容默认只有两块（见 `src/components/FamilyCard.tsx` 的 JSX）：
 *      `<header class="card-head">` + `<div class="card-preview">`。
 *      `.card-members`（`app.css:5951-5956`）与 `.card-styles`（`app.css:8266-8270`）
 *      都是**条件渲染**：前者要有快照/分组归属徽标，后者要用户点开
 *      （`FamilyCard.tsx:469-495` 里是 `{expanded && ...}`，默认不挂载）
 *      → 默认态两者都不占高，所以算式里没有 `border-top: 1px` + `padding-top: 6px`
 *      这一对（合计 7px）。展开后卡片会变高，但那是 **measureElement 按实测值重新量**
 *      的范围，初值只需要对准默认态；§校验段给了 64px 档的余量，说明这 7px 也不会
 *      把「默认态行高」推出 2px 的验收线。
 *
 * 4) 头部 `.card-head`（`app.css:8214-8218`，`display: flex; align-items: center`）：
 *      **28px，由行内最高的控件决定，不是 CSS 里那条 `min-height: 16px`** ——
 *      16 只是下限，被内容顶开了。真正定高的是收藏星标：
 *      `.star-btn { width: var(--ctl-h); height: var(--ctl-h) }`（`app.css:12271-12280`），
 *      `--ctl-h: 28px`（`tokens.css:131`，深色主题在 `:180` 同为 28px），
 *      而它就在 `card-head` 里（`FamilyCard.tsx:352-360` 的 `<StarRating />`，
 *      按钮本体见 `StarRating.tsx`）→ 头部 = 28。
 *      对照一下同排的其它元素，都够不到 28：`.card-name`（`app.css:8219-8224`）
 *      `line-height: 16px`；`.badge`（`app.css:8226-8236`）14 + 上下各 1px 描边 = 16；
 *      展开按钮 `.card-expand`（`app.css:8237-8242`）9px / line-height 1.5 / padding 2px /
 *      1px 描边 ≈ 19.5；开关 `.pill-toggle`（`app.css:1378-1384`）`--pill-h: 19px`；
 *      冲突徽标 `.conflict-badge`（`app.css:3956-3961`）里只有一个 13px 图标。
 *      （2026-11-27 QA 复核更正：本条最初按 `min-height: 16px` 取 16，漏了星标的 28，
 *      于是 96px 档被算成 210、真机是 214.6。头部这种「下限 + 内容撑开」的盒子必须
 *      按最高的子元素取，不能按 min-height 取。）
 *
 * 5) 预览 `.card-preview`（`app.css:8256-8260` + `app.css:1229-1235`）：
 *      `padding-top: 10px`（8256 段覆盖了 1229 段的 14px），
 *      `display: flex; align-items: center`（1229 段，纵向居中，不额外加高）；
 *      另有内联 `min-height`（`FamilyCard.tsx:384` 的 `style={{ minHeight: size * 1.35 }}`）
 *      —— **内联样式直接顶掉 CSS 里那条 `min-height: 46px`**（8259），所以 46 这个数
 *      在真机上根本不参与计算，不能再写进算式（这是本模块最容易被写错的一项）。
 *
 * 6) 预览文字 `.preview-text`（`app.css:8261-8264`）：`line-height: 1.15`，
 *      字号由内联 `fontSize: size` 给（`FamilyCard.tsx:418` / `:454`）→ 行盒高 = size × 1.15。
 *
 *    ⇒ 预览块高 = max(size × 1.35, 10 + size × 1.15)
 *       （前者是内联 min-height 的下限，后者是 padding-top + 一行文字）
 *
 * ── 校验（8..64 档被 196 兜住，96 档外推）──────────────────────────────────
 *
 *   SIZES = [8, 14, 18, 24, 32, 48, 64, 96]（`src/state/fontStore.ts:128`）
 *   预览块高：8→19.2 · 14→26.1 · 18→30.7 · 24→37.6 · 32→46.8 · 48→65.2 · 64→86.4 · 96→129.6
 *   内容高  ：8→47.2 · 14→54.1 · 18→58.7 · 24→65.6 · 32→74.8 · 48→93.2 · 64→114.4 · 96→157.6
 *   内容+43 ：8→90.2 · 14→97.1 · 18→101.7 · 24→108.6 · 32→117.8 · 48→136.2 · 64→157.4 · 96→200.6
 *   ⇒ 8/14/18/24/32/48/64 七档都小于 196 ⇒ 卡片 196 ⇒ 行高 **210**；
 *     96 档 200.6 > 196 ⇒ 卡片 200.6 ⇒ 行高 **214.6**（旧算式 264，高估 49.4px）。
 *   越界临界点：内容高 ≥ 153（预览块 ≥ 125）才会顶破 196，125 ÷ 1.35 ≈ 92.6
 *   ⇒ 92 档（内容 152.2）仍是 210，93 档（153.55 → 196.55 → 210.55）起才开始外推，
 *     所以 8 档里只有 96 一档走外推分支。
 *   64 档余量 196 − 157.4 = 38.6px：足够吸收 §3 里「点开字重区」的 7px（1 + 6）与
 *   §4 里展开按钮的约 3.5px —— 那两种都只在交互后出现，且届时 measureElement 会
 *   按实测值重量，初值只对默认态负责。
 *   注：7 个档位同为 210 不是「常函数」，而是 `min-height: 196` 这个 CSS 下限在起作用；
 *   测试另用 92/93/120/400 四档钉住外推分支，防止有人把它简化成 `return 210`。
 */

/** `.family-card` 的 `padding: 20px 24px 22px 26px`（app.css:8134）中的上内边距。 */
const CARD_PADDING_TOP = 20;
/** 同上：下内边距 22。 */
const CARD_PADDING_BOTTOM = 22;
/** `.family-card { border: 0; border-bottom: 1px }`（app.css:8137-8138）：纵向只占 1px。 */
const CARD_BORDER_BOTTOM = 1;
/** `.family-card { min-height: 196px }`（app.css:8135，border-box 含内边距与边框）。 */
const CARD_MIN_HEIGHT = 196;
/** `.grid-row { padding-bottom: 14px }`（app.css:1098-1100）：卡片下方的行间距。 */
const ROW_PADDING_BOTTOM = 14;
/**
 * 头部 `.card-head` 的**实际**高度 28px —— 不是 `app.css:8214-8218` 那条
 * `min-height: 16px`（min-height 只是下限，会被行内最高的控件顶开）。
 * 定高的是收藏星标 `.star-btn { width/height: var(--ctl-h) }`（`app.css:12271-12280`）
 * 配 `--ctl-h: 28px`（`tokens.css:131` / `:180`），它由 `FamilyCard.tsx:352-360`
 * 的 `<StarRating />` 渲染在头部里。其余同排元素都更矮，见文件顶部 §4。
 */
const CARD_HEAD_HEIGHT = 28;
/** `.card-preview { padding-top: 10px }`（app.css:8257；覆盖了 1229 段的 14px）。 */
const PREVIEW_PADDING_TOP = 10;
/** 预览容器**内联** `minHeight: size * 1.35`（FamilyCard.tsx:384）——顶掉了 CSS 的 46px。 */
const PREVIEW_MIN_SIZE_RATIO = 1.35;
/** `.preview-text { line-height: 1.15 }`（app.css:8262），字号由内联 fontSize 给。 */
const PREVIEW_LINE_HEIGHT = 1.15;

/**
 * 一个字号的档位（px）对应的网格行高（px）。
 *
 * 纯函数：不读 DOM、不读 store，同样输入必得同样输出 —— 这样 `node --test` 才能钉住数字。
 * 返回值可能带小数（93px 档 210.55、96px 档 214.60000000000002 这类），虚拟列表与浏览器
 * 都接受小数高度，这里刻意不取整：取整会把「从 CSS 推导」这件事藏起来，看不出算式对不对。
 *
 * @param sizePx 示例文字字号（`SIZES[sizeIndex]`），单位 px。
 * @returns 一条 `.grid-row` 的高度（卡片 + 行底 14px）。
 */
export function gridRowHeight(sizePx: number): number {
  // 非法输入（NaN / Infinity / 负数 / 0）退到最小字号 0：此时下限 196 仍然成立，
  // 结果等于最小行高。静默回退不可取，但这里没有可上报的通道（纯计算、无 IO），
  // 且虚拟列表本来就要求 estimateSize 永远返回有限正数，否则总高会变成 NaN。
  const size = Number.isFinite(sizePx) && sizePx > 0 ? sizePx : 0;

  // §5 + §6：预览块 = max(内联 min-height, padding-top + 一行文字高)
  const previewTextHeight = size * PREVIEW_LINE_HEIGHT;
  const previewHeight = Math.max(size * PREVIEW_MIN_SIZE_RATIO, PREVIEW_PADDING_TOP + previewTextHeight);

  // §3 + §4：默认态内容只有头部与预览两块（card-members / card-styles 都是条件渲染）
  const contentHeight = CARD_HEAD_HEIGHT + previewHeight;

  // §2：auto 高度 = 内容 + 内边距 + 纵向边框；再与 min-height 取大（border-box 口径一致）
  const autoHeight =
    contentHeight + CARD_PADDING_TOP + CARD_PADDING_BOTTOM + CARD_BORDER_BOTTOM;
  const cardHeight = Math.max(CARD_MIN_HEIGHT, autoHeight);

  // §1：行高 = 卡片 + 行底内边距
  return cardHeight + ROW_PADDING_BOTTOM;
}
