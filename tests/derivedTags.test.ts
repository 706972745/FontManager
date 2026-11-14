import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  _clearDeriveCache,
  _deriveCacheStats,
  _resetDeriveCacheStats,
  deriveTags,
  effectiveTags,
  matchTagFilter,
  pinTag,
  rejectTag,
  removedAutoTags,
  type FamilyFacts,
} from "../src/lib/derivedTags.ts";
import { CN_STYLES, NAMESPACES, namespaceOf } from "../src/lib/tagVocabulary.ts";

/**
 * 自动标签（派生标签）。
 *
 * 这份测试盯死的不是「能产出多少标签」，而是同事文档里那几条**反指标**：
 * 中文不许吃 PANOSE、互斥维度只许有一个值、用户手工改过的标签不许被自动那套盖回去。
 * 覆盖率靠 `_tmp/font-auto-tag-proto` 的真库预演看，不放在单测里。
 */

const facts = (over: Partial<FamilyFacts> = {}): FamilyFacts => ({
  name: "Helvetica Neue",
  classification: "sans",
  scripts: ["latin"],
  features: [],
  isVariable: false,
  axes: [],
  monospaced: false,
  weights: [400],
  italic: false,
  ...over,
});

const tagsOf = (f: FamilyFacts, opts?: Parameters<typeof deriveTags>[1]) =>
  deriveTags(f, opts).map((d) => d.tag);

const appliedOf = (f: FamilyFacts, opts?: Parameters<typeof deriveTags>[1]) =>
  deriveTags(f, opts)
    .filter((d) => d.state === "applied")
    .map((d) => d.tag);

test("中文书体互斥：一个字族只出一个 cn:*", () => {
  // 「小标宋」里同时含「宋」，「宋体黑体混合名」里同时含宋和黑 —— 旧的原型会两个都给
  for (const name of ["方正小标宋简体", "汉仪旗黑宋体", "思源宋体 Heavy"]) {
    const cn = tagsOf(facts({ name, scripts: ["han", "latin"], classification: "serif" })).filter((t) =>
      t.startsWith("cn:"),
    );
    assert.equal(cn.length, 1, `${name} 产出了 ${cn.join(",")}`);
  }
});

test("伪书体优先级：仿宋不是宋、行楷不是楷、魏碑不是楷", () => {
  assert.deepEqual(
    tagsOf(facts({ name: "仿宋_GB2312", scripts: ["han"], classification: "serif" })).filter((t) =>
      t.startsWith("cn:"),
    ),
    ["cn:fangsong"],
  );
  assert.deepEqual(
    tagsOf(facts({ name: "方正行楷", scripts: ["han"], classification: "script" })).filter((t) =>
      t.startsWith("cn:"),
    ),
    ["cn:xingcao"],
  );
  assert.deepEqual(
    tagsOf(facts({ name: "华文魏碑", scripts: ["han"], classification: "script" })).filter((t) =>
      t.startsWith("cn:"),
    ),
    ["cn:weibei"],
  );
});

test("中文名比拼音更可信：本地化名命中加 0.02", () => {
  const byPinyin = deriveTags(facts({ name: "FZSongTi", scripts: ["han"], classification: "serif" }));
  const byLocal = deriveTags(
    facts({
      name: "FZSong",
      localizedNames: ["方正宋体"],
      scripts: ["han"],
      classification: "serif",
    }),
  );
  const pick = (list: typeof byPinyin) => list.find((d) => d.tag === "cn:song")!;
  assert.ok(pick(byLocal).confidence > pick(byPinyin).confidence);
  assert.equal(pick(byLocal).source, "localizedName");
});

test("gothic / rounded 按文字系统分流：西文的 Gothic 不是中文黑体", () => {
  assert.equal(tagsOf(facts({ name: "Century Gothic" })).includes("cn:hei"), false);
  assert.equal(
    tagsOf(facts({ name: "Gothic A1", scripts: ["hangul", "latin"], classification: "sans" })).includes(
      "cn:hei",
    ),
    true,
  );
  // 中文圆体走 cn:yuan；西文 Rounded 走 decor:rounded。两者不重复产
  const cn = tagsOf(facts({ name: "汉仪圆体", scripts: ["han"], classification: "display" }));
  assert.ok(cn.includes("cn:yuan"));
  assert.equal(cn.includes("decor:rounded"), false);
  assert.ok(tagsOf(facts({ name: "Nunito Rounded" })).includes("decor:rounded"));
});

test("中文的 PANOSE 一律不作数（familyKind / proportion 都是模板垃圾）", () => {
  const panose = [2, 0, 9, 9, 0, 0, 0, 0, 4, 0]; // 「拉丁文本 + 很重的字重 + 等宽 + 很大 x-height」
  const cn = deriveTags(
    facts({ name: "微软雅黑", scripts: ["han"], classification: "sans", panose, sFamilyClass: 0x0805 }),
  ).map((d) => d.tag);
  assert.equal(cn.includes("tech:monospaced"), false, "中文被 PANOSE 判成等宽是假象");
  assert.equal(cn.includes("vox:neo-grotesque"), false, "vox 只对西文");
  assert.equal(cn.includes("form:heavy"), true, "字重字节 >= 9 对中文仍算强信号");
});

test("等宽只认一级分类（PANOSE 那条已删），模板默认值那几条只进建议档", () => {
  // 2.1.7：`tech:monospaced` 删掉了 —— 等宽已经是 `class:mono`，再挂一条英文别名
  // 只会让同一个族在标签云里出现两次「等宽」。PANOSE 的 bProportion=9 仍然是
  // 不可信的（中文 41.7% 填 9），所以这里断言「什么等宽标签都不产」。
  const mono = deriveTags(facts({ name: "Pragmata", panose: [2, 0, 5, 9, 4, 0, 0, 0, 2, 0] }));
  assert.equal(mono.some((d) => d.tag.includes("mono")), false);
  // 一级分类说了算
  const realMono = deriveTags(facts({ name: "Pragmata", classification: "mono" }));
  assert.equal(realMono.find((d) => d.tag === "class:mono")?.state, "applied");

  const narrow = deriveTags(facts({ name: "Roboto Narrowish", panose: [2, 0, 5, 3, 4, 0, 0, 0, 2, 0] }));
  assert.equal(narrow.find((d) => d.tag === "form:condensed")?.state, "suggested");

  // 样式名写明的宽度比 PANOSE 可信，可以自动生效
  const styled = deriveTags(facts({ name: "Roboto Condensed", styles: ["Regular", "Condensed"] }));
  assert.equal(styled.find((d) => d.tag === "form:condensed")?.state, "applied");
});

test("P 级闸门：PANOSE 全 0 / 全 1 等于没填", () => {
  const zeros = deriveTags(facts({ name: "Mystery Sans", panose: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }));
  assert.equal(zeros.some((d) => d.tag.startsWith("form:")), false);
  const ones = deriveTags(facts({ name: "Mystery Sans", panose: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] }));
  assert.equal(ones.some((d) => d.tag.startsWith("form:")), false);
});

test("证据叠加：use:code 的置信度是证据的函数", () => {
  const plain = deriveTags(
    facts({ name: "Code Plain", classification: "mono", weights: [400] }),
  ).find((d) => d.tag === "use:code");
  assert.equal(plain?.confidence, 0.76);
  assert.equal(plain?.state, "suggested");

  const full = deriveTags(
    facts({
      name: "Source Code Pro Variable",
      classification: "mono",
      features: ["liga", "calt"],
      isVariable: true,
      axes: ["wght"],
    }),
  ).find((d) => d.tag === "use:code");
  assert.equal(full?.confidence, 0.9);
  assert.equal(full?.state, "applied");
});

test("手工标签优先：同名不重复产，互斥命名空间整段让位", () => {
  // 手工已经打了同样的标签 → 不再派生一份
  const dup = tagsOf(facts({ name: "Futura", italic: true }), { manualTags: ["style:italic"] });
  assert.equal(dup.includes("style:italic"), false);

  // 手工打了 cn:kai，软件不许再推 cn:song（用户 2026-11-14 的硬要求）
  const cjk = facts({ name: "方正宋体", scripts: ["han"], classification: "serif" });
  assert.ok(tagsOf(cjk).includes("cn:song"));
  const withManual = tagsOf(cjk, { manualTags: ["cn:kai"] });
  assert.deepEqual(withManual.filter((t) => t.startsWith("cn:")), []);
  // 非互斥命名空间不受影响（装饰 + 手工 cn 可以并存）
  const mixed = tagsOf(facts({ name: "方正宋体描边", scripts: ["han"], classification: "display" }), {
    manualTags: ["cn:kai"],
  });
  assert.ok(mixed.includes("decor:outline"));
});

test("否决名单：命中即不产，且不影响别的族与别的标签", () => {
  const f = facts({ name: "方正宋体", scripts: ["han"], classification: "serif" });
  const out = tagsOf(f, { denied: ["cn:song"] });
  assert.equal(out.includes("cn:song"), false);
  assert.equal(tagsOf(f).includes("cn:song"), true);
});

test("每个标签都带来源与理由，且命名空间在白名单内", () => {
  const list = deriveTags(
    facts({
      name: "Source Han Sans Variable",
      localizedNames: ["思源黑体"],
      scripts: ["han", "latin"],
      classification: "sans",
      isVariable: true,
      axes: ["wght", "opsz"],
      features: ["smcp", "tnum"],
      weights: [400, 700],
      italic: true,
      panose: [2, 0, 8, 4, 5, 0, 0, 0, 3, 5],
      sFamilyClass: 0x0805,
    }),
  );
  assert.ok(list.length >= 6);
  for (const d of list) {
    assert.ok(d.source.length > 0, `${d.tag} 没有 source`);
    assert.ok(d.reason.length > 0, `${d.tag} 没有 reason`);
    assert.ok(d.confidence > 0 && d.confidence <= 1);
    const ns = namespaceOf(d.tag);
    assert.ok(ns !== null && ns in NAMESPACES, `${d.tag} 的命名空间不在白名单`);
  }
});

test("废标签永不出现：情绪类没有词表，也没有 cat:/lang:/origin:", () => {
  const list = deriveTags(facts({ name: "Retro Vintage Grotesk Poster" }));
  for (const d of list) {
    assert.equal(d.tag.startsWith("mood:"), false);
    assert.equal(d.tag.startsWith("cat:"), false);
    assert.equal(d.tag.startsWith("lang:"), false);
    assert.equal(d.tag.startsWith("origin:"), false);
  }
});

test("空名 / 残缺事实不抛异常", () => {
  assert.deepEqual(deriveTags({ ...facts(), name: "" }), []);
  assert.doesNotThrow(() =>
    deriveTags({ name: "X", classification: "unknown" } as unknown as FamilyFacts),
  );
});

test("有效标签 = 手工 ∪ applied，suggested 不进筛选", () => {
  const f = facts({ name: "Code Plain", classification: "mono" });
  const derived = deriveTags(f);
  const eff = effectiveTags([], derived);
  assert.equal(eff.includes("use:code"), false, "建议档不参与筛选");
  const manualEff = effectiveTags(["我的标签"], derived);
  assert.ok(manualEff.includes("我的标签"));
});

test("AND / OR 筛选语义", () => {
  const tags = ["cn:hei", "form:heavy"];
  assert.equal(matchTagFilter(tags, []), true);
  assert.equal(matchTagFilter(tags, ["cn:hei"]), true);
  assert.equal(matchTagFilter(tags, ["cn:hei", "form:heavy"]), true);
  assert.equal(matchTagFilter(tags, ["cn:hei", "cn:song"]), false);
  assert.equal(matchTagFilter(tags, ["cn:song"], "or"), false);
  assert.equal(matchTagFilter(tags, ["cn:song", "form:heavy"], "or"), true);
  // 大小写不敏感，但用户的中文标签保持原样
  assert.equal(matchTagFilter(["CN:Hei"], ["cn:hei"]), true);
});

test("pinTag / rejectTag 幂等", () => {
  assert.deepEqual(pinTag([], "cn:hei"), ["cn:hei"]);
  assert.deepEqual(pinTag(["cn:hei"], "CN:Hei"), ["cn:hei"]);
  assert.deepEqual(rejectTag([], "cn:hei"), ["cn:hei"]);
  assert.deepEqual(rejectTag(["cn:hei"], "cn:hei"), ["cn:hei"]);
  assert.deepEqual(rejectTag([], ""), []);
});

test("删掉自动标签 → 记进否决名单；删掉手工标签不记", () => {
  const f = facts({ name: "方正宋体", scripts: ["han"], classification: "serif", italic: true });
  const derived = deriveTags(f, { manualTags: ["我的"] });
  const before = effectiveTags(["我的"], derived);
  // 用户只留下手工标签，自动的都被删了
  const removed = removedAutoTags(before, ["我的"], derived);
  // `class:serif` 现在也是自动标签（一级分类变成可编辑标签），所以要一起被记进否决
  assert.deepEqual(removed.sort(), ["class:serif", "cn:song", "style:italic"].sort());
  // 反过来：删的是手工标签，不该被记成「否决自动标签」
  assert.deepEqual(removedAutoTags(["我的"], [], derived), []);
});

/**
 * 4000 族两轮推导：第一轮全量真算（只留一条很宽松的预算防止性能崩掉），
 * 第二轮必须**全部命中事实缓存**。
 *
 * 为什么不判耗时比值（QA 负控实验结论）：以前断言「第二轮 < 首轮一半」，
 * 把缓存整个清空、每轮全未命中时比值同样是 0.2 —— 它测的是 JIT 预热；
 * 而 `node --test` 并行跑 40 多个文件时，负载抖动又会让它偶发红
 * （实测 6 次红 2 次，`首轮 197ms，第二轮 248ms`）。改成数命中：
 * 只要缓存失效，`misses` 立刻变成 4000，跟机器快慢无关。
 */
test("缓存：4000 族第二轮全部命中事实缓存，不再重跑规则", () => {
  _clearDeriveCache();
  _resetDeriveCacheStats();
  const list: FamilyFacts[] = [];
  for (let i = 0; i < 4000; i += 1) {
    list.push(
      facts({
        name: `Family ${i} ${i % 7 === 0 ? "Condensed" : "Text"}`,
        localizedNames: i % 3 === 0 ? [`测试字体 ${i}`] : [],
        scripts: i % 4 === 0 ? ["han", "latin"] : ["latin"],
        classification: (["serif", "sans", "display", "mono", "script"] as const)[i % 5],
        panose: i % 2 === 0 ? [2, 0, 6, 5, 4, 0, 0, 0, 3, 5] : null,
        sFamilyClass: i % 3 === 0 ? 0x0805 : null,
        weights: [400, i % 6 === 0 ? 700 : 400],
        features: i % 5 === 0 ? ["smcp"] : [],
      }),
    );
  }
  const t0 = Date.now();
  for (const f of list) deriveTags(f);
  const first = Date.now() - t0;
  assert.ok(first < 3000, `首轮 ${first}ms 太慢（4000 族冷推推导不该到这个量级）`);

  // 只清计数、不清缓存：这一轮该是纯命中
  _resetDeriveCacheStats();
  for (const f of list) deriveTags(f);
  const stats = _deriveCacheStats();
  assert.equal(stats.misses, 0, `第二轮仍重跑了 ${stats.misses} 个族的规则，事实缓存没生效`);
  assert.equal(stats.hits, list.length, `第二轮命中 ${stats.hits} / ${list.length}，缓存键不稳定`);
});

test("词表一致性：中文书体词必须在 Rust 的一级分类词表里出现过", () => {
  // 前端不许凭空造出后端不承认的口径。这里读 parser.rs 源码做字面校验，
  // 是同事文档 §6.4 给的「方案③ 弱保证」：改动成本低，但能挡住「前端自己发明一个词」。
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../src-tauri/src/parser.rs"), "utf8");
  const tables = [
    "MONO_KEYWORDS",
    "DISPLAY_KEYWORDS",
    "SCRIPT_KEYWORDS",
    "SERIF_KEYWORDS",
    "SANS_KEYWORDS",
    "LATIN_SUBSTRING_KEYWORDS",
  ];
  const slice = tables
    .map((name) => {
      const at = src.indexOf(`const ${name}`);
      assert.ok(at > 0, `parser.rs 里找不到 ${name}`);
      const end = src.indexOf("];", at);
      return src.slice(at, end);
    })
    .join("\n");

  // 后端词表里出现过的中文词（去引号）
  const rustWords = [...slice.matchAll(/"([\u3040-\u30ff\u3400-\u9fff]+)"/g)].map((m) => m[1]);
  assert.ok(rustWords.length > 20, "词表切片没读到东西，断言会变成假绿灯");

  const missing: string[] = [];
  for (const entry of CN_STYLES) {
    for (const word of entry.words) {
      // 只校验中文词：拉丁词（song / gothic / hei）在后端是分类口径的一部分，
      // 且大小写与写法不一，做字面比对没有意义。
      if (!/[\u3040-\u30ff\u3400-\u9fff]/.test(word)) continue;
      // 约束是**只能收窄、不能凭空发明**：前端的词里必须含有一个后端认识的中文词。
      // 例：后端有「仿」没有「仿宋」，前端把「仿宋体」收窄成 fangsong 是允许的；
      // 但后端根本没有「彩云」这个词时，前端就不能自己造一个 cn:meishu 的口径出来。
      if (!rustWords.some((rw) => word.includes(rw))) missing.push(`${entry.value} ${word}`);
    }
  }
  // 一次报全，改词表时不用一条条试
  assert.deepEqual(missing, [], "这些前端词在后端词表里找不到对应项（只能收窄，不能发明）");
});
