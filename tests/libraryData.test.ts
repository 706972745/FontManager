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

const data = (over: Partial<CurationData>): CurationData => ({ ...emptyCuration(), ...over });

test("导出文件能原样读回来（v2：含字重级分组、手动版权、到期日期）", () => {
  const payload = {
    app: "ZFontManager",
    kind: "curation",
    version: 2,
    tags: { Lora: ["衬线"], Inter: ["无衬线", "界面"] },
    collections: { 项目A: ["Lora"] },
    collectionFaces: { 项目A: ["ps:lora-bold"] },
    favorites: ["Inter"],
    notes: { Lora: "手写备注" },
    copyrightStatus: { Lora: "paid" },
    copyrightExpiry: { Lora: "2027-01-01" },
  };
  const parsed = parseCuration(payload);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.data.tags, payload.tags);
  assert.deepEqual(parsed.data.collectionFaces, payload.collectionFaces);
  assert.deepEqual(parsed.data.copyrightStatus, { Lora: "paid" });
  assert.deepEqual(parsed.data.copyrightExpiry, { Lora: "2027-01-01" });
});

test("老版本（version 1、没有 kind）仍然认，缺的字段当空", () => {
  const parsed = parseCuration({
    app: "ZFontManager",
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
});

test("快照文件导错入口要能认出来（指引到「快照」那一行，而不是骂一句不是导出文件）", () => {
  const parsed = parseCuration({ app: "ZFontManager", kind: "snapshots", snapshots: [] });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.reason, "isSnapshot");
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
    app: "ZFontManager",
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

test("整包路径判定：大小写都认，别把 .json 当整包", () => {
  assert.equal(isPackPath("D://备份//ZFonts-2026-11-03.ZFontManager"), true);
  assert.equal(isPackPath("D://备份//ZFonts-2026-11-03.zfontmanager"), true);
  assert.equal(isPackPath("/home/u/ZFonts-2026-11-03-part2.ZFontManager"), true);
  assert.equal(isPackPath("D://备份//zfontmanager-library.json"), false);
  assert.equal(isPackPath("D://备份//ZFontManager"), false);
  // 名字里带 .ZFontManager 但结尾不是：防止把「打包日志.txt」认成整包
  assert.equal(isPackPath("D://备份//ZFonts.ZFontManager.txt"), false);
});
