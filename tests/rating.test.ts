import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareActivated,
  isRating,
  meetsRating,
  normalizeRatings,
} from "../src/lib/rating.ts";

test("评分只认 1~5 的整数：0 分、小数、6 分、字符串一律不收", () => {
  for (const v of [1, 2, 3, 4, 5]) assert.equal(isRating(v), true);
  for (const v of [0, -1, 6, 1.5, NaN, Infinity, "4", null, undefined]) {
    assert.equal(isRating(v), false, String(v));
  }
});

test("normalizeRatings 逐条清洗坏值，不把整个表丢掉", () => {
  assert.deepEqual(
    normalizeRatings({ Inter: 5, Lora: 0, Roboto: 6, Mono: 2.5, Serif: "3", Sans: 1 }),
    { Inter: 5, Sans: 1 },
  );
  assert.deepEqual(normalizeRatings(null), {});
  assert.deepEqual(normalizeRatings([1, 2, 3]), {});
  assert.deepEqual(normalizeRatings("5"), {});
});

test("星级筛选是「至少 N 星」，不是「恰好 N 星」", () => {
  const ratings = { A: 5, B: 3, C: 1 };
  assert.equal(meetsRating(ratings, "A", 3), true);
  assert.equal(meetsRating(ratings, "B", 3), true);
  assert.equal(meetsRating(ratings, "C", 3), false);
  assert.equal(meetsRating(ratings, "未评分", 1), false);
  // 0 / 非法档位 = 不限，所有字体都过
  assert.equal(meetsRating(ratings, "未评分", 0), true);
  assert.equal(meetsRating(ratings, "未评分", 1.5), true);
});

test("按启用时间排序：最近启用的在前，没记录过的按名字排", () => {
  const at = { Zebra: 1000, Alpha: 3000, Middle: 2000 };
  const names = ["Yankee", "Zebra", "Alpha", "Bravo", "Middle"];
  const sorted = [...names].sort((a, b) => compareActivated(a, b, at));
  assert.deepEqual(sorted, ["Alpha", "Middle", "Zebra", "Bravo", "Yankee"]);
  // 没有任何记录时退化为按名字排序，不能退化成原始顺序或乱序
  assert.deepEqual(
    [...names].sort((a, b) => compareActivated(a, b, {})),
    ["Alpha", "Bravo", "Middle", "Yankee", "Zebra"],
  );
});
