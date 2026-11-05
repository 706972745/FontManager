import { test } from "node:test";
import assert from "node:assert/strict";
import {
  curationFile,
  emptyCuration,
  isPackPath,
  mergeCuration,
  parseCuration,
  type CurationData,
} from "../src/lib/libraryData.ts";
import { detectJsonKind } from "../src/lib/fileKinds.ts";

const data = (over: Partial<CurationData>): CurationData => ({ ...emptyCuration(), ...over });

test("导出文件带自描述头（用途 / 导入方式 / 推荐后缀），数据能原样读回来", () => {
  const file = curationFile(
    data({
      tags: { Lora: ["衬线"], Inter: ["无衬线", "界面"] },
      collections: { 项目A: ["Lora"] },
      collectionFaces: { 项目A: ["ps:lora-bold"] },
      favorites: ["Inter"],
      notes: { Lora: "手写备注" },
      copyrightStatus: { Lora: "paid" },
      copyrightExpiry: { Lora: "2027-01-01" },
    }),
    "2026-11-05T00:00:00.000Z",
  );
  // 文件自己要能说清「我是什么、怎么导回去」——即使后缀被用户改掉
  assert.equal(file.kind, "curation");
  assert.equal(file.suffix, ".L-FontManager");
  assert.equal(file.label, "字体整理数据");
  assert.ok((file.purpose ?? "").includes("整理成果"));
  assert.ok((file.howTo ?? "").includes("导入"));

  const parsed = parseCuration(JSON.parse(JSON.stringify(file)));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.data.tags, file.tags);
  assert.deepEqual(parsed.data.collectionFaces, file.collectionFaces);
  assert.deepEqual(parsed.data.copyrightStatus, { Lora: "paid" });
  assert.deepEqual(parsed.data.copyrightExpiry, { Lora: "2027-01-01" });
});

test("老备份照旧能导入：不看 app 字段、不看后缀，按内容结构认", () => {
  // 改名前导出的文件：app 是旧品牌名、version 1 没有 kind —— 全都拦不住它被认出来
  const parsed = parseCuration({
    app: "Legacy Font Tool",
    version: 1,
    tags: { Lora: ["衬线"] },
    collections: {},
    favorites: ["Lora"],
    notes: {},
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.data.tags, { Lora: ["衬线"] });
  assert.deepEqual(parsed.data.copyrightStatus, {});
  assert.deepEqual(parsed.data.collectionFaces, {});
  assert.deepEqual(parsed.data.ratings, {});
});

test("快照文件导错入口要能认出来（指引到「快照」那一行，而不是骂一句不是导出文件）", () => {
  const parsed = parseCuration({ app: "FontManager", kind: "snapshots", snapshots: [] });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.reason, "isSnapshot");
});

test("内容识别：kind 缺失 / 被改 / 后缀随便换，detectJsonKind 都按结构认", () => {
  // 没有 kind 的老备份
  assert.equal(detectJsonKind({ version: 2, tags: {}, favorites: [] }), "curation");
  // kind 被用户改坏了，但结构还在
  assert.equal(detectJsonKind({ kind: "????" , snapshots: [{ name: "A", entries: [] }] }), "snapshots");
  // 只有 tags 一个字段也认
  assert.equal(detectJsonKind({ tags: { Inter: ["界面"] } }), "curation");
  // 整包 manifest
  assert.equal(detectJsonKind({ kind: "library-pack" }), "library-pack");
  // 乱七八糟的东西不认
  assert.equal(detectJsonKind(null), "unknown");
  assert.equal(detectJsonKind([1, 2, 3]), "unknown");
  assert.equal(detectJsonKind({ hello: "world" }), "unknown");
});

test("不是本软件的文件 / 乱码结构一律拒绝", () => {
  assert.equal(parseCuration(null).ok, false);
  assert.equal(parseCuration("{}").ok, false);
  assert.equal(parseCuration({ app: "Other" }).ok, false);
  assert.equal(parseCuration([1, 2, 3]).ok, false);
});

test("标签、分组、字重级分组、收藏只增不减：本地已有的不会被导入覆盖", () => {
  const local = data({
    tags: { Lora: ["衬线", "本地标签"] },
    collections: { 项目A: ["Lora"] },
    collectionFaces: { 项目A: ["ps:lora-bold"] },
    favorites: ["Inter"],
  });
  const incoming = data({
    tags: { Lora: ["衬线", "导入标签"], Inter: ["无衬线"] },
    collections: { 项目A: ["Inter"], 项目B: ["Lora"] },
    collectionFaces: { 项目A: ["ps:lora-bold", "ps:lora-black"] },
    favorites: ["Inter", "Lora"],
  });
  const merged = mergeCuration(local, incoming);

  assert.deepEqual(merged.tags.Lora, ["衬线", "本地标签", "导入标签"]);
  assert.deepEqual(merged.addedTags, { Lora: ["导入标签"], Inter: ["无衬线"] });
  assert.deepEqual(merged.collections.项目A, ["Lora", "Inter"]);
  assert.deepEqual(merged.collections.项目B, ["Lora"]);
  assert.deepEqual(merged.collectionFaces.项目A, ["ps:lora-bold", "ps:lora-black"]);
  assert.deepEqual(merged.favorites, ["Inter", "Lora"]);
  assert.deepEqual(merged.addedFavorites, ["Lora"]);
  // 字族级与字重级必须分开报：后端 set_collection 只认字族名，
  // 把 face key 塞进字族清单会把分组写坏
  assert.deepEqual(merged.changedCollections, { 项目A: ["Inter"], 项目B: ["Lora"] });
  assert.deepEqual(merged.changedCollectionFaces, { 项目A: ["ps:lora-black"] });
});

test("备注、手动版权、到期日期：本地优先，只补空缺", () => {
  const local = data({
    notes: { Lora: "本机改过的备注" },
    copyrightStatus: { Lora: "free_commercial" },
  });
  const incoming = data({
    notes: { Lora: "旧备份里的备注", Inter: "只在本机没有时才写" },
    copyrightStatus: { Lora: "paid", Inter: "paid" },
    copyrightExpiry: { Lora: "2027-01-01" },
  });
  const merged = mergeCuration(local, incoming);

  assert.equal(merged.notes.Lora, "本机改过的备注");
  assert.equal(merged.notes.Inter, "只在本机没有时才写");
  assert.deepEqual(merged.addedNotes, { Inter: "只在本机没有时才写" });
  assert.equal(merged.copyrightStatus.Lora, "free_commercial");
  assert.equal(merged.copyrightStatus.Inter, "paid");
  assert.deepEqual(merged.adoptedCopyright, ["Inter"]);
  assert.deepEqual(merged.adoptedExpiry, ["Lora"]);
});

test("重复导入同一份文件第二次是空操作（touched = 0）", () => {
  const incoming = data({
    tags: { Lora: ["衬线"] },
    collections: { 项目A: ["Lora"] },
    collectionFaces: { 项目A: ["ps:lora-bold"] },
    favorites: ["Lora"],
    notes: { Lora: "备注" },
    copyrightStatus: { Lora: "paid" },
    copyrightExpiry: { Lora: "2027-01-01" },
  });
  const once = mergeCuration(emptyCuration(), incoming);
  const twice = mergeCuration(once, incoming);
  assert.ok(once.touched > 0);
  assert.equal(twice.touched, 0);
  assert.deepEqual(twice.addedTags, {});
  assert.deepEqual(twice.addedFavorites, []);
  assert.deepEqual(twice.changedCollections, {});
});

test("字段形状不对时逐条丢掉，不让一条脏数据把整个导入废掉", () => {
  const parsed = parseCuration({
    tags: { Lora: ["衬线", 3, ""], Broken: "not-an-array" },
    favorites: ["Inter", null, ""],
    notes: { Lora: 123, Inter: "正常" },
    copyrightStatus: { Lora: null },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.data.tags, { Lora: ["衬线"] });
  assert.deepEqual(parsed.data.favorites, ["Inter"]);
  assert.deepEqual(parsed.data.notes, { Inter: "正常" });
  assert.deepEqual(parsed.data.copyrightStatus, {});
});

test("整包内的整理数据与单独导出的 json 是同一份 schema，能互相顶替", () => {
  const file = curationFile(
    data({ tags: { Lora: ["衬线"] }, copyrightStatus: { Lora: "paid" } }),
    "2026-11-03T00:00:00.000Z",
  );
  const parsed = parseCuration(JSON.parse(JSON.stringify(file)));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.data.tags, { Lora: ["衬线"] });
  assert.deepEqual(parsed.data.copyrightStatus, { Lora: "paid" });
});

test("后缀辅助判定：三种后缀大小写都认，.json 与中间出现的字样不算", () => {
  assert.equal(isPackPath("D://备份//ZFonts-2026-11-03.P-FontManager"), true);
  assert.equal(isPackPath("D://备份//ZFonts-2026-11-03.p-fontmanager"), true);
  assert.equal(isPackPath("D://备份//backup.S-FontManager"), true);
  assert.equal(isPackPath("/home/u/2026-11-03.L-FontManager"), true);
  assert.equal(isPackPath("D://备份//fontmanager-library.json"), false);
  assert.equal(isPackPath("D://备份//FontManager"), false);
  // 名字里带后缀但结尾不是：防止把「打包日志.txt」认成导出文件
  assert.equal(isPackPath("D://备份//ZFonts.P-FontManager.txt"), false);
});

// ─────────────── 收藏评分（1.2.4） ───────────────

test("导出文件带上评分，读回来原样不变", () => {
  const file = curationFile(data({ favorites: ["Inter"], ratings: { Inter: 5, Lora: 2 } }), "2026-11-05T00:00:00.000Z");
  assert.equal(file.version, 4);
  const parsed = parseCuration(JSON.parse(JSON.stringify(file)));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.data.ratings, { Inter: 5, Lora: 2 });
});

test("老文件没有 ratings：当成全未评分，不是解析失败", () => {
  const parsed = parseCuration({
    kind: "curation",
    version: 2,
    tags: { Inter: ["界面"] },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.data.ratings, {});
});

test("评分里的坏值逐条丢掉，不污染其余整理数据", () => {
  const parsed = parseCuration({
    kind: "curation",
    ratings: { Inter: 0, Lora: 6, Roboto: 2.5, Mono: "4", Sans: 3 },
    tags: { Inter: ["界面"] },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.data.ratings, { Sans: 3 });
  assert.deepEqual(parsed.data.tags, { Inter: ["界面"] });
});

test("合并评分：本机改过的星级优先，只补本机没有的", () => {
  const local = data({ ratings: { Inter: 1 }, favorites: ["Inter"] });
  const incoming = data({ ratings: { Inter: 5, Lora: 4 }, favorites: ["Inter", "Lora"] });
  const merged = mergeCuration(local, incoming);
  assert.deepEqual(merged.ratings, { Inter: 1, Lora: 4 });
  assert.deepEqual(merged.adoptedRatings, ["Lora"]);
  // 第二次导入同一份文件不应再算「有更新」
  assert.equal(mergeCuration(merged, incoming).touched, 0);
});
