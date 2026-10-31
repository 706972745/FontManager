import { test } from "node:test";
import assert from "node:assert/strict";
import { createFaceLru } from "../src/lib/faceRegistry.ts";

/**
 * 假 `document.fonts`：记住 add / delete 过的对象。
 * 关键是能断言「真的从集合里摘掉了」—— 0.9.9-13 的 P0 就是集合只增不减。
 */
function fakeCollection<T>() {
  const live = new Set<T>();
  const deleted: T[] = [];
  return {
    live,
    deleted,
    add(face: T) {
      live.add(face);
      return live;
    },
    delete(face: T) {
      live.delete(face);
      deleted.push(face);
      return live;
    },
  };
}

test("超过上限淘汰最久没用的那个，并从集合里摘掉", () => {
  const col = fakeCollection<object>();
  const lru = createFaceLru(col, { max: 3 });
  const a = {};
  const b = {};
  const c = {};
  const d = {};

  lru.register("a", a);
  lru.register("b", b);
  lru.register("c", c);
  assert.equal(lru.size, 3);
  assert.equal(col.live.size, 3);

  lru.register("d", d);

  assert.equal(lru.size, 3, "上限必须守住");
  assert.equal(lru.has("a"), false, "最久没用的 a 应被淘汰");
  assert.deepEqual(lru.names(), ["b", "c", "d"]);
  assert.equal(col.live.has(a), false, "a 必须真的从集合里删掉");
  assert.equal(col.live.size, 3, "集合不该只增不减");
});

test("touch 会改变淘汰顺序", () => {
  const col = fakeCollection<object>();
  const lru = createFaceLru(col, { max: 3 });
  const a = {};
  const b = {};
  const c = {};
  const d = {};

  lru.register("a", a);
  lru.register("b", b);
  lru.register("c", c);
  // 又用到 a，此时最久没用的是 b
  lru.touch("a");
  assert.deepEqual(lru.names(), ["b", "c", "a"]);

  lru.register("d", d);
  assert.equal(lru.has("b"), false);
  assert.deepEqual(lru.names(), ["c", "a", "d"]);
});

test("同名重新加载会替换旧 FontFace，不占两个名额", () => {
  const col = fakeCollection<object>();
  const lru = createFaceLru(col, { max: 5 });
  const first = {};
  const second = {};

  lru.register("a", first);
  lru.register("a", second);

  assert.equal(lru.size, 1);
  assert.equal(lru.get("a"), second);
  assert.equal(col.live.has(first), false, "旧引用必须摘掉，否则同族名会挂两份");
  assert.equal(col.live.size, 1);
});

test("同一个对象重复 register 不会把自己删掉", () => {
  const col = fakeCollection<object>();
  const lru = createFaceLru(col, { max: 5 });
  const a = {};

  lru.register("a", a);
  lru.register("a", a);

  assert.equal(lru.size, 1);
  assert.equal(lru.get("a"), a);
  assert.equal(col.live.has(a), true);
  assert.equal(col.deleted.length, 0);
});

test("淘汰回调拿到被淘汰的名字和对象", () => {
  const col = fakeCollection<object>();
  const evicted: string[] = [];
  const lru = createFaceLru(col, {
    max: 1,
    onEvict: (name) => evicted.push(name),
  });
  const a = {};
  const b = {};

  lru.register("a", a);
  lru.register("b", b);

  assert.deepEqual(evicted, ["a"]);
  assert.equal(lru.has("b"), true);
});

test("加载失败的字面不 register，就不占常驻名额（P0 回归）", () => {
  const col = fakeCollection<object>();
  const lru = createFaceLru(col, { max: 2 });
  // 失败路径（tryLoad 的 catch）不会调 register，只在内存里创建过 FontFace
  const failed = {};

  assert.equal(lru.size, 0);
  assert.equal(col.live.size, 0);
  assert.equal(col.live.has(failed), false);

  // touch 一个不存在的名字也不该凭空造条目
  lru.touch("never-registered");
  assert.equal(lru.size, 0);
});

test("被淘汰后重新 register 回到最近使用的位置", () => {
  const col = fakeCollection<object>();
  const lru = createFaceLru(col, { max: 3 });
  const a = {};
  const b = {};
  const a2 = {};

  lru.register("a", a);
  lru.register("b", b);
  lru.register("c", {});
  lru.register("d", {}); // 淘汰 a
  assert.equal(lru.has("a"), false);
  assert.deepEqual(lru.names(), ["b", "c", "d"]);

  // 重新加载回来：排在末尾（最近使用），挤掉最旧的 b
  lru.register("a", a2);
  assert.deepEqual(lru.names(), ["c", "d", "a"]);
  assert.equal(lru.get("a"), a2);
  assert.equal(col.live.has(a2), true);
});
