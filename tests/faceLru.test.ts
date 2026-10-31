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

/**
 * 字节预算（0.9.9-23）：只按条数的 200 上限在真实字体库上会吃出 855 MB，
 * 因为 p90 的字体文件是 4 MB、还有 88 个超过 15 MB。这里锁住「先按体积淘汰」。
 */
test("字节超预算时淘汰最久没用的，即使条数还没到上限", () => {
  const col = fakeCollection<object>();
  const MB = 1024 * 1024;
  const lru = createFaceLru(col, { max: 200, maxBytes: 10 * MB });
  const a = {};
  const b = {};
  const c = {};

  lru.register("a", a, 4 * MB);
  lru.register("b", b, 4 * MB);
  assert.equal(lru.bytes, 8 * MB);

  lru.register("c", c, 4 * MB); // 12 MB > 10 MB
  assert.equal(lru.has("a"), false, "最久没用的 a 先走");
  assert.deepEqual(lru.names(), ["b", "c"]);
  assert.equal(lru.bytes, 8 * MB, "体积必须跟着降下来");
  assert.equal(col.live.has(a), false);
});

test("小字体不会因为字节预算被误杀（条数上限仍然生效）", () => {
  const col = fakeCollection<object>();
  const MB = 1024 * 1024;
  const lru = createFaceLru(col, { max: 3, maxBytes: 100 * MB });

  for (const name of ["a", "b", "c", "d"]) lru.register(name, {}, 60 * 1024);
  assert.deepEqual(lru.names(), ["b", "c", "d"], "总量才 240 KB，淘汰只由条数决定");
});

test("单个字体大于字节预算时仍然保留它（至少留 1 条）", () => {
  const col = fakeCollection<object>();
  const MB = 1024 * 1024;
  const lru = createFaceLru(col, { max: 200, maxBytes: 8 * MB });
  const huge = {};

  lru.register("huge", huge, 30 * MB);
  assert.equal(lru.size, 1, "否则大字体永远登不进来，卡片会一直空白");
  assert.equal(lru.get("huge"), huge);
});

test("同名重新登记会更新体积，不重复计账", () => {
  const col = fakeCollection<object>();
  const MB = 1024 * 1024;
  const lru = createFaceLru(col, { max: 200, maxBytes: 100 * MB });
  const a = {};

  lru.register("a", a, 3 * MB);
  assert.equal(lru.bytes, 3 * MB);
  lru.register("a", a, 5 * MB);
  assert.equal(lru.size, 1);
  assert.equal(lru.bytes, 5 * MB);
  // 不传 bytes 时不能把已知体积抹成 0
  lru.register("a", a);
  assert.equal(lru.bytes, 5 * MB);
});

/**
 * 0.9.9-23 的「淘汰风暴」回归：被淘汰的往往正是屏幕最上面那张卡片在用的字体，
 * 淘汰它 → 卡片重新加载 → 又超预算 → 再淘汰一条。这里锁住「屏上的不淘汰」。
 */
test("在屏上的条目跳过，淘汰下一条可淘汰的", () => {
  const col = fakeCollection<object>();
  const pinned = new Set<string>();
  const lru = createFaceLru(col, { max: 2, canEvict: (name) => !pinned.has(name) });
  const a = {};
  const b = {};
  const c = {};

  lru.register("a", a);
  lru.register("b", b);
  pinned.add("a"); // a 正在屏上渲染

  lru.register("c", c);
  assert.equal(lru.has("a"), true, "屏上的 a 不能被淘汰");
  assert.equal(lru.has("b"), false, "应该淘汰没在屏上的 b");
  assert.equal(lru.size, 2);
});

test("全都在屏上时宁可暂时超上限，也不淘汰（否则就是加载/淘汰风暴）", () => {
  const col = fakeCollection<object>();
  const lru = createFaceLru(col, { max: 1, canEvict: () => false });

  lru.register("a", {});
  lru.register("b", {});
  assert.equal(lru.size, 2);
  assert.deepEqual(lru.names(), ["a", "b"]);
});

test("字节预算同样跳过在屏上的条目", () => {
  const col = fakeCollection<object>();
  const MB = 1024 * 1024;
  const pinned = new Set(["big"]);
  const lru = createFaceLru(col, {
    max: 200,
    maxBytes: 10 * MB,
    canEvict: (name) => !pinned.has(name),
  });
  const big = {};
  const small1 = {};
  const small2 = {};

  lru.register("big", big, 8 * MB);
  lru.register("s1", small1, 4 * MB);
  lru.register("s2", small2, 4 * MB);

  assert.equal(lru.has("big"), true, "在屏的大字体保留");
  assert.equal(lru.has("s1"), false, "先淘汰没在屏上的");
  assert.equal(lru.has("s2"), true);
  assert.equal(lru.size, 2);
});
