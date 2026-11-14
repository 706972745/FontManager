/**
 * 「从已有标签里选」面板的尺寸计算。
 *
 * 面板是跟着文档流展开的（不是绝对定位浮层），所以它的可用高度完全取决于
 * 「按钮下方到详情面板可视底边还剩多少」。列表是唯一可伸缩的一段，剩下的头部
 * （搜索框）和底部（确认按钮）都是定高 —— 于是把可视化的问题收敛成一道算术题：
 *
 *   剩余空间够  → 列表顶到上限，不动滚动条
 *   剩余空间不够 → 先把详情面板滚动「最小必要距离」，再把差值补进列表高度
 *   实在滚不动  → 列表压到下限，至少露出搜索框和两行
 *
 * 抽成纯函数是为了能单测：组件里只负责量 DOM，判断全在这里。
 */

/** 列表高度上限：再高就靠搜索框缩范围了（约 11 行） */
export const PICK_LIST_WANT = 320;
/** 列表高度下限：至少露出搜索框 + 两行 */
export const PICK_LIST_MIN = 96;
/** 面板底边与可视区底边之间留的呼吸 */
export const PICK_BOTTOM_PAD = 12;

export type PickFitInput = {
  /** 滚动容器可视区底边（getBoundingClientRect().bottom） */
  boxBottom: number;
  /** 「＋ 从已有标签选」按钮底边 */
  btnBottom: number;
  /** 头部 + 底部 + 边框等定高部分 */
  chrome: number;
  /** 面板与按钮之间的间距（.tag-picker 的 margin-top） */
  gap: number;
  /** 滚动容器还能往下滚多少（scrollHeight - clientHeight - scrollTop） */
  room: number;
};

export type PickFitResult = {
  /** 列表的 max-height */
  listMax: number;
  /** 需要把滚动容器再往下滚多少（0 = 不用动） */
  scrollBy: number;
};

export function fitPickPanel(i: PickFitInput): PickFitResult {
  let avail = i.boxBottom - PICK_BOTTOM_PAD - (i.btnBottom + i.gap) - i.chrome;
  let scrollBy = 0;

  if (avail < PICK_LIST_WANT) {
    // 缺多少补多少；补不满（已经到底了）就有多少算多少
    const d = Math.min(PICK_LIST_WANT - avail, Math.max(0, i.room));
    if (d > 0) {
      scrollBy = d;
      avail += d;
    }
  }

  const listMax = Math.max(PICK_LIST_MIN, Math.min(PICK_LIST_WANT, Math.floor(avail)));
  return { listMax, scrollBy };
}
