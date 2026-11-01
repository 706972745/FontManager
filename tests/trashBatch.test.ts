import { test } from "node:test";
import assert from "node:assert/strict";
import { trashItems } from "../src/lib/applyPlan.ts";
import type { FontFace } from "../src/lib/ipc.ts";

/**
 * 批量「移到回收站」的条目生成（C8）。
 *
 * 这层以前不存在：前端是 `for (const f of names) void uninstallFamily(f)`，
 * 每个族再逐个文件调 `uninstall_font` —— 4020 个链接字体 → 4020 次整份 state.json 落盘
 * （2.27 MB × 4020 ≈ 9 GB 写盘）+ 4213 个并发 Promise（私有内存飙到 1 GB）。
 * 这些用例锁住三件事：一个路径只发一次、系统字体不发、不属于目标族的不要混进来。
 */

const face = (over: Partial<FontFace>): FontFace =>
  ({
    id: over.path ?? "id",
    family: "F",
    style: "Regular",
    path: "C:/x/a.ttf",
    source: "managed",
    active: false,
    ...over,
  }) as FontFace;

test("一条路径只发一次：TTC 多面共用文件不会重复搬运", () => {
  const faces = [
    face({ family: "Song", path: "C:/lib/song.ttc", id: "a" }),
    face({ family: "Song", path: "C:/lib/song.ttc", id: "b" }),
    face({ family: "Song", path: "C:/lib/song.ttc", id: "c" }),
    face({ family: "Song", path: "C:/lib/song-bold.ttf", id: "d" }),
  ];
  const items = trashItems(faces, ["Song"]);
  assert.deepEqual(items, [
    { path: "C:/lib/song.ttc", family: "Song" },
    { path: "C:/lib/song-bold.ttf", family: "Song" },
  ]);
});

test("系统字体一律不发：后端动不了它们", () => {
  const faces = [
    face({ family: "Arial", path: "C:/Windows/Fonts/arial.ttf", source: "system" }),
  ];
  assert.deepEqual(trashItems(faces, ["Arial"]), []);
});

test("只收目标族：同名字面散在别的族里不能被连带删除", () => {
  const faces = [
    face({ family: "Keep", path: "C:/lib/keep.ttf" }),
    face({ family: "Gone", path: "C:/lib/gone.ttf" }),
  ];
  assert.deepEqual(trashItems(faces, ["Gone"]), [
    { path: "C:/lib/gone.ttf", family: "Gone" },
  ]);
});

test("多族批量：保持入参顺序、路径各自带自己的族名", () => {
  const faces = [
    face({ family: "A", path: "C:/lib/a1.ttf" }),
    face({ family: "B", path: "C:/lib/b1.ttf" }),
    face({ family: "A", path: "C:/lib/a2.ttf" }),
  ];
  assert.deepEqual(trashItems(faces, ["A", "B"]), [
    { path: "C:/lib/a1.ttf", family: "A" },
    { path: "C:/lib/b1.ttf", family: "B" },
    { path: "C:/lib/a2.ttf", family: "A" },
  ]);
});

test("空清单与不存在的族：返回空数组，别发一次空请求", () => {
  assert.deepEqual(trashItems([], ["X"]), []);
  assert.deepEqual(trashItems([face({ family: "A" })], []), []);
  assert.deepEqual(trashItems([face({ family: "A" })], ["NotThere"]), []);
});
