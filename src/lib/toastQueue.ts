/**
 * 提示条队列的纯逻辑（不碰 React / DOM，便于单测）。
 *
 * 为什么会需要它：批量操作是「一条一条报错」的 —— 导入 40 个 zip、把 60 个族
 * 丢进回收站，每个失败都 push 一条。之前 `toasts` 是一个无上限数组，
 * 屏幕上会一路堆到看不见的窗外，而且每条都响一次错误音。
 *
 * 这里只做两件事：
 * 1. **合并**：新来的和「最后一条」同类型、同标题、同详情时，不叠新的，
 *    把那条的 count +1（界面上显示成 `×N`）；
 * 2. **限长**：超过 `max` 条时从**最旧**的开始丢，丢掉的返回给调用方去清计时器。
 *
 * 只跟最后一条比，不是全表扫描：`toast.error("A") → toast.success("B") →
 * toast.error("A")` 应该是三条，合并成一条会让人以为中间那次成功没发生。
 */

export interface ToastLike {
  id: number;
  kind: string;
  title: string;
  detail?: string;
  count: number;
}

export interface EnqueueResult<T> {
  /** 处理后的队列（可能长度不变——发生了合并） */
  list: T[];
  /** 因超长被挤出去的条目（调用方负责清它们的计时器 / 暂停标记） */
  dropped: T[];
  /** 发生了合并时，被合并的那条 id；否则 null（调用方据此决定「不播声音、不新建计时器」） */
  mergedId: number | null;
}

export function enqueueToast<T extends ToastLike>(
  list: readonly T[],
  item: T,
  max: number,
): EnqueueResult<T> {
  const last = list[list.length - 1];
  if (
    last &&
    last.kind === item.kind &&
    last.title === item.title &&
    (last.detail ?? "") === (item.detail ?? "")
  ) {
    const merged = list.map((t) =>
      t.id === last.id ? { ...t, count: t.count + 1 } : t,
    ) as T[];
    return { list: merged, dropped: [], mergedId: last.id };
  }

  const next = [...list, item];
  const over = Math.max(0, next.length - Math.max(1, max));
  return {
    list: over > 0 ? next.slice(over) : next,
    dropped: over > 0 ? next.slice(0, over) : [],
    mergedId: null,
  };
}
