import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueueToast, type ToastLike } from "../src/lib/toastQueue.ts";

const t = (id: number, title: string, extra: Partial<ToastLike> = {}): ToastLike => ({
  id,
  kind: "error",
  title,
  count: 1,
  ...extra,
});

test("相同内容的提示合并成一条，计数 +1", () => {
  let list: ToastLike[] = [];
  list = enqueueToast(list, t(1, "无法移动到回收站", { detail: "文件被占用" }), 4).list;
  const r = enqueueToast(list, t(2, "无法移动到回收站", { detail: "文件被占用" }), 4);

  assert.equal(r.list.length, 1);
  assert.equal(r.list[0].count, 2);
  assert.equal(r.mergedId, 1);
  assert.deepEqual(r.dropped, []);
});

test("第三条相同内容继续累加", () => {
  let list: ToastLike[] = [];
  for (let i = 1; i <= 6; i++) {
    list = enqueueToast(list, t(i, "安装失败"), 4).list;
  }
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 6);
});

test("详情不同就不合并（同一个标题下的不同原因要分开看）", () => {
  let list: ToastLike[] = [];
  list = enqueueToast(list, t(1, "安装失败", { detail: "a.zip" }), 4).list;
  const r = enqueueToast(list, t(2, "安装失败", { detail: "b.zip" }), 4);
  assert.equal(r.list.length, 2);
  assert.equal(r.mergedId, null);
});

test("只跟最后一条比：中间夹了别的提示就不再合并", () => {
  let list: ToastLike[] = [];
  list = enqueueToast(list, t(1, "A"), 4).list;
  list = enqueueToast(list, { ...t(2, "B"), kind: "success" }, 4).list;
  const r = enqueueToast(list, t(3, "A"), 4);
  assert.equal(r.list.length, 3);
  assert.deepEqual(
    r.list.map((x) => x.title),
    ["A", "B", "A"],
  );
});

test("超过上限从最旧的开始丢，丢弃项单独返回", () => {
  let list: ToastLike[] = [];
  for (let i = 1; i <= 6; i++) {
    const r = enqueueToast(list, t(i, `第 ${i} 个`), 4);
    list = r.list;
    if (i >= 5) {
      assert.equal(r.dropped.length, 1);
      assert.equal(r.dropped[0].id, i - 4);
    }
  }
  assert.deepEqual(
    list.map((x) => x.id),
    [3, 4, 5, 6],
  );
});

test("合并不会把队列撑破上限", () => {
  let list: ToastLike[] = [];
  for (let i = 1; i <= 4; i++) list = enqueueToast(list, t(i, `第 ${i} 个`), 4).list;
  const r = enqueueToast(list, t(99, "第 4 个"), 4);
  assert.equal(r.list.length, 4);
  assert.equal(r.list[3].count, 2);
  assert.deepEqual(r.dropped, []);
});

test("max 至少留 1 条，避免配置成 0 时全部被丢光", () => {
  const r = enqueueToast([], t(1, "A"), 0);
  assert.equal(r.list.length, 1);
});
