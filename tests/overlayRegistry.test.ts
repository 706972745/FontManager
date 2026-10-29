import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acquireOverlay,
  openOverlays,
  overlayOpen,
  releaseOverlay,
} from "../src/lib/overlayRegistry.ts";

/**
 * 对应交接文档 BUG-B 的验收：排序 / 筛选菜单开着时，全局快捷键必须整体让路。
 * 这里只测登记表本身的语义——「谁开着」「同名重复登记会不会提前放行」
 * 「关掉一个不能把还开着的另一个一起放行」。
 */

test("登记即占用键盘，注销后立即释放", () => {
  assert.equal(overlayOpen(), false);
  acquireOverlay("test:single");
  assert.equal(overlayOpen(), true);
  assert.deepEqual(openOverlays(), ["test:single"]);
  releaseOverlay("test:single");
  assert.equal(overlayOpen(), false);
});

test("同名重复登记必须等量注销才释放", () => {
  // React 严格模式下 effect 会双跑；先注销的那个不能把还开着的一起放行
  acquireOverlay("test:dup");
  acquireOverlay("test:dup");
  releaseOverlay("test:dup");
  assert.equal(overlayOpen(), true, "还剩一层，不能放行");
  releaseOverlay("test:dup");
  assert.equal(overlayOpen(), false);
});

test("注销一个不影响其他仍打开的弹层", () => {
  acquireOverlay("test:a");
  acquireOverlay("test:b");
  releaseOverlay("test:a");
  assert.equal(overlayOpen(), true);
  assert.deepEqual(openOverlays(), ["test:b"]);
  releaseOverlay("test:b");
  assert.equal(overlayOpen(), false);
});

test("多注销一次不会变成「负数」把后续登记吃掉", () => {
  releaseOverlay("test:ghost"); // 迷之注销：不能留下负计数
  assert.equal(overlayOpen(), false);
  acquireOverlay("test:ghost");
  assert.equal(overlayOpen(), true, "重新登记必须能生效");
  releaseOverlay("test:ghost");
  assert.equal(overlayOpen(), false);
});
