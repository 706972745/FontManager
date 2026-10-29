import { test } from "node:test";
import assert from "node:assert/strict";
import { createSerialQueue, leadNormalized } from "../src/lib/quickbarAnim.ts";
import { DEFAULT_HOTKEY, matchesHotkey, normalizeHotkey } from "../src/lib/hotkey.ts";

/**
 * 这三个用例对应交接文档 §5.5 要求的「纯逻辑测试」：
 * 1) 展开方向的 LEAD 归一化不再在收尾跳一下；
 * 2) 热键连按会排队执行、且按最新状态合并；
 * 3) 快捷键匹配 / 规范化只认自己那一组键。
 */

test("LEAD 归一化在结尾精确到 1，起点之前为 0", () => {
  const D = 200;
  const L = 45;

  // 起点：还没轮到这个方向动
  assert.equal(leadNormalized(0, D, L), 0);
  assert.equal(leadNormalized(L / D / 2, D, L), 0);
  // 终点：必须精确到 1，否则收尾会补一帧、看起来跳一下（旧实现 t - L/D 只到 0.775）
  assert.equal(leadNormalized(1, D, L), 1);
  // 归一化之后，越接近结尾越接近 1（旧实现在 0.99 处还差 ~3%）
  assert.ok(leadNormalized(0.995, D, L) > 0.99);
  assert.ok(leadNormalized(0.99, D, L) < leadNormalized(0.995, D, L));
  // 极短时长（「减少动效」里 duration 可能小于 LEAD）不能除零 / 出 NaN
  assert.equal(leadNormalized(1, 10, 45), 1);
  assert.ok(Number.isFinite(leadNormalized(0.5, 10, 45)));
});

test("热键 toggle 串行执行，连按按最新状态收尾", () => {
  const queue = createSerialQueue();
  const log: string[] = [];
  let running = 0;
  let docked = false;

  const toggle = () =>
    queue.run(async () => {
      running++;
      // 同时只允许一个在跑
      assert.equal(running, 1);
      // 模拟「执行时才读状态」：这里改的是真实状态，而不是提交时快照
      docked = !docked;
      log.push("start");
      await new Promise((r) => setTimeout(r, 5));
      log.push("end");
      running--;
    });

  // 连按三下（相当于用户狂按热键）：每一拍都必须落地，不能有一下被静默丢掉
  void toggle();
  void toggle();
  const last = toggle();

  assert.equal(queue.pending, 3);
  return last.then(() => {
    assert.deepEqual(log, ["start", "end", "start", "end", "start", "end"]);
    assert.equal(queue.pending, 0);
    // 三下 = 收 → 展 → 收
    assert.equal(docked, true);
  });
});

test("快捷键匹配只认自己那一组键，脏数据退回默认", () => {
  const ev = (over: Partial<KeyboardEvent>) =>
    ({ keyCode: 192, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...over }) as KeyboardEvent;

  assert.equal(matchesHotkey(ev({ altKey: true }), DEFAULT_HOTKEY), true);
  // 少了 Alt / 换成 Ctrl / 多按了 Shift，都不算命中（否则会在别的软件里抢键）
  assert.equal(matchesHotkey(ev({}), DEFAULT_HOTKEY), false);
  assert.equal(matchesHotkey(ev({ ctrlKey: true }), DEFAULT_HOTKEY), false);
  assert.equal(matchesHotkey(ev({ altKey: true, shiftKey: true }), DEFAULT_HOTKEY), false);
  assert.equal(matchesHotkey(ev({ altKey: true, keyCode: 191 }), DEFAULT_HOTKEY), false);

  // 偏好里的脏数据（缺 vk / 类型不对 / null）一律退回默认，不能让设置页一存就崩
  assert.deepEqual(normalizeHotkey(null), DEFAULT_HOTKEY);
  assert.deepEqual(normalizeHotkey({ vk: "192" }), DEFAULT_HOTKEY);
  const custom = normalizeHotkey({ vk: 81, ctrl: true, alt: true, label: "Ctrl + Alt + Q" });
  assert.equal(custom.vk, 81);
  assert.equal(custom.shift, false);
  assert.equal(custom.label, "Ctrl + Alt + Q");
});
