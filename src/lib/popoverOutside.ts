/**
 * 「这次按下是不是落在弹层外面」——排序 / 筛选菜单的外部点击判定。
 *
 * 为什么不能只靠遮罩的 `onClick`（用户 2026-11 报：速览窗口里点面板外的列表区 / 空白处，
 * 筛选面板收不起来）：
 *
 * 1. 遮罩 `.menu-backdrop` 是 `.qb-head` 里面的裸 div；
 * 2. 速览的 `.qb-head` 上挂着窗口拖动（`useWindowDrag`），它只放过
 *    `input, textarea, select, button, a, [data-no-drag]`，遮罩不在白名单里；
 * 3. 于是按下遮罩时它走到 `e.preventDefault()` + `el.setPointerCapture(...)`，
 *    指针被捕获到 `.qb-head`，pointerup 的目标随之变成 `.qb-head`；
 * 4. 浏览器把 click 派发给 pointerdown / pointerup 目标的**最近公共祖先**，
 *    也就是 `.qb-head` —— 遮罩的 `onClick={close}` 永远不会触发。
 *
 * 所以判定要挂在 `document` 的**捕获阶段** `pointerdown` 上：它在事件流最前面跑，
 * 指针捕获改不了它的 target，也不依赖任何 click 合成规则。
 */

/** 判定只需要这两个 DOM 方法，所以单测里可以直接塞假对象（`node --test` 没有 DOM）。 */
interface NodeLike {
  contains?: (other: unknown) => boolean;
  closest?: (selector: string) => unknown;
}

/**
 * 弹层外面、但按下也不该关掉弹层的容器：筛选菜单的「范围」二级菜单。
 *
 * 它是 `position: fixed` 挂在菜单**外面**的（`.filter-menu` 自己 `overflow-y:auto`
 * 会把绝对定位的子面板裁掉，所以只能 fixed），结构上不属于菜单本体 `listRef`。
 *
 * 放在这里而不是 `usePopoverMenu.ts`，是因为它属于这个判定的契约、且本文件零依赖：
 * `usePopoverMenu.ts` 会 import `react` 且用无扩展名相对路径，`node --test` 直接
 * 加载不了；单测 import 本文件才跑得起来，改选择器测试就会跟着红。
 */
export const POPOVER_EXTRA = ".filter-submenu";

/**
 * `target` 是否算「点在弹层外面」（即：该关掉了）。
 *
 * @param target `pointerdown` 的事件目标。
 * @param keep 算「里面」的容器：菜单本体（`listRef`）与触发器按钮（`triggerRef`）。
 *   触发器必须排除，否则按下触发器会「先关再开」，净效果是菜单打不开。
 * @param extra 额外算「里面」的选择器。筛选菜单的「范围」二级菜单是 `position: fixed`
 *   挂在菜单**外面**的（`.filter-submenu`，见 `TopBar.tsx` 的 sub 逻辑），结构上不属于
 *   `listRef`；不加这一条，点二级菜单里的标签会先被关掉整个菜单。
 * @returns 需要关闭时 `true`。目标缺失（合成事件 / 没有 target）时返回 `false`：
 *   宁可让用户按 Esc，也不要因为一次来路不明的 pointerdown 把菜单关掉。
 */
export function isOutsidePopover(
  target: unknown,
  keep: readonly unknown[],
  extra: string,
): boolean {
  if (!target) return false;
  for (const box of keep) {
    const contains = (box as NodeLike | null)?.contains;
    if (typeof contains === "function" && contains.call(box, target)) return false;
  }
  const closest = (target as NodeLike).closest;
  if (typeof closest === "function" && closest.call(target, extra)) return false;
  return true;
}
