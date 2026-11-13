import { test } from "node:test";
import assert from "node:assert/strict";
import { POPOVER_EXTRA, isOutsidePopover } from "../src/lib/popoverOutside.ts";

/**
 * 对应 2026-11 用户报的缺陷：速览窗口里打开筛选菜单后，点列表区 / 空白处收不起来。
 *
 * 真正的修复在 `usePopoverMenu` 的捕获阶段 pointerdown 上，这里只测「判定本身」的语义：
 * 菜单里 / 触发器上 / 二级菜单里 → 不关；其余 → 关。
 * `node --test` 没有 DOM，所以用最小假对象模拟 `contains` / `closest`。
 *
 * `EXTRA` 直接 import 生产常量，不再在测试里抄一份字面量 —— 改选择器时测试会跟着红。
 */
const EXTRA = POPOVER_EXTRA;

/** 造一个只认 `contains` 的容器节点 */
function box(members: unknown[] = []) {
  return { contains: (n: unknown) => members.includes(n) };
}

/** 造一个事件目标：`inSub` 为真时表示它能 `closest` 到二级菜单 */
function target(inSub = false) {
  return { closest: (sel: string) => (inSub && sel === EXTRA ? {} : null) };
}

test("点在菜单里不关：菜单项是 listRef 的后代", () => {
  const item = target();
  assert.equal(isOutsidePopover(item, [box([item]), null], EXTRA), false);
});

test("点在触发器上不关：否则按下漏斗会「先关再开」，净效果是打不开", () => {
  const trigger = target();
  assert.equal(isOutsidePopover(trigger, [null, box([trigger])], EXTRA), false);
});

test("点在「范围」二级菜单里不关：它是 fixed 渲染在菜单外面的", () => {
  const inSub = target(true);
  assert.equal(isOutsidePopover(inSub, [box(), box()], EXTRA), false);
});

test("点在列表区 / 空白处要关", () => {
  assert.equal(isOutsidePopover(target(), [box(), box()], EXTRA), true);
});

test("菜单还没挂载（ref 为 null）时照样能判定，不能抛异常", () => {
  // 打开动画第一帧、或 StrictMode 下 effect 重跑，ref 可能还没指到节点
  assert.equal(isOutsidePopover(target(), [null, null], EXTRA), true);
});

test("目标缺失时不关：宁可让用户按 Esc，也不要被来路不明的 pointerdown 关掉", () => {
  assert.equal(isOutsidePopover(null, [box()], EXTRA), false);
  assert.equal(isOutsidePopover(undefined, [], EXTRA), false);
});

test("文本节点这类没有 closest 的目标，按 contains 结果判定", () => {
  const text = {}; // 文本节点：没有 closest
  assert.equal(isOutsidePopover(text, [box([text])], EXTRA), false);
  assert.equal(isOutsidePopover(text, [box()], EXTRA), true);
});
