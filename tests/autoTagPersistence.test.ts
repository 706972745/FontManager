import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveTags, normalizeTag, type FamilyFacts } from "../src/lib/derivedTags.ts";

/**
 * 自动标签 × 用户手工标签：跨字体库、删除/重装后的**记忆**测试。
 *
 * 用户 2026-11-14 点名的三条验收：
 *  1. 在不同文件夹之间切换，手动调整的标签不能被软件自定义标签盖回去；
 *  2. 移除文件夹，过一会儿再导入，手动调整必须还在；
 *  3. 删除字体后，从同事那里下载同一款再导入，回来的必须是用户原来的标签。
 *
 * store 依赖 Tauri `invoke`，Node 里不能 import 做行为测试，所以这里分两层：
 *  - 行为：用**真实的** deriveTags 跑同一套「族名 → 手工标签 / 否决名单」状态机，
 *    并且每条「记忆」用例都配一条**反证**（把记忆抹掉之后结果必须变），
 *    保证断言不是恒真 —— 2026-11-14 QA 复核发现过三条恒真断言（浅拷贝同引用、
 *    时间比较），那些写法已删除，别再写回来。
 *  - 结构：直接读 store 源码，按**函数边界**切出卸载相关动作，用**容忍空白**的正则
 *    钉住「卸载不清标签」。注释字符串只作提示，不当主证据。
 *
 * 持久化的口径（读代码得到，测试只能逼近不能替代真机）：
 *  - 手工标签存 `state.json.tags`，键是**字体自报族名**，与文件路径无关；
 *  - 否决名单存 `prefs.autoTagDenied`，键同样是族名；
 *  - 卸载字体只搬文件 + 清 favorites/collections，不碰 `tags`。
 */

const STORE = readFileSync(new URL("../src/state/fontStore.ts", import.meta.url), "utf8");
const ENGINE = readFileSync(new URL("../src/lib/derivedTags.ts", import.meta.url), "utf8");
const VOCAB = readFileSync(new URL("../src/lib/tagVocabulary.ts", import.meta.url), "utf8");

const song = (name = "方正宋体"): FamilyFacts => ({
  name,
  localizedNames: [name],
  styles: ["Regular", "Italic"],
  classification: "serif",
  scripts: ["han", "latin"],
  features: [],
  isVariable: false,
  axes: [],
  monospaced: false,
  weights: [400],
  italic: true,
  panose: [2, 0, 6, 9, 0, 0, 0, 0, 4, 0],
});

interface Memory {
  /** 对应 state.json.tags，只存用户手工标签 */
  tags: Record<string, string[]>;
  /** 对应 prefs.autoTagDenied */
  denied: Record<string, string[]>;
}

const blank = (): Memory => ({ tags: {}, denied: {} });

/** 落盘 → 读回。用真实 JSON 往返而不是 `{ ...m }`：浅拷贝是同引用，断言会恒真。 */
const roundTrip = (m: Memory): Memory => JSON.parse(JSON.stringify(m)) as Memory;

function view(f: FamilyFacts, m: Memory) {
  const manual = m.tags[f.name] ?? [];
  const derived = deriveTags(f, { manualTags: manual, denied: m.denied[f.name] });
  return {
    manual,
    auto: derived.filter((d) => d.state === "applied").map((d) => d.tag),
  };
}

/** 详情面板自动标签上的 ×：直接记否决，不写 state.json.tags（store 存归一化后的值） */
function deny(m: Memory, family: string, tag: string) {
  const n = normalizeTag(tag);
  if (!n) return;
  const old = m.denied[family] ?? [];
  if (!old.includes(n)) m.denied[family] = [...old, n];
}

/**
 * 与 store.setFamilyTags 同口径：用户摘掉一个标签，如果软件本来会推它，就记否决。
 *
 * store 的实现（`fontStore.ts::setFamilyTags`）先 `normalizeTag` 再查
 * `potentialAutoTags`，所以 `CN:Kai` 与 `cn:kai` 算同一条。这里必须对齐，
 * 否则模型比实现**宽松**，正好在「漏记否决」这个关键回归点上失效。
 */
function setManualTags(m: Memory, f: FamilyFacts, next: string[]) {
  const before = m.tags[f.name] ?? [];
  const potential = new Set(
    deriveTags(f, { denied: m.denied[f.name] }).map((d) => normalizeTag(d.tag)),
  );
  const keep = new Set(next.map(normalizeTag).filter(Boolean));
  for (const dropped of before) {
    const n = normalizeTag(dropped);
    if (n && !keep.has(n) && potential.has(n)) deny(m, f.name, n);
  }
  if (next.length === 0) delete m.tags[f.name];
  else m.tags[f.name] = next;
}

test("基线：手工标签与自动标签并存，手工修改书体后自动书体让位", () => {
  const m = blank();
  const f = song();
  const initial = view(f, m);
  assert.ok(initial.auto.includes("cn:song"));
  assert.ok(initial.auto.includes("style:italic"));

  setManualTags(m, f, ["海报用", "cn:kai"]);
  const after = view(f, m);
  assert.deepEqual(after.manual, ["海报用", "cn:kai"]);
  assert.equal(after.auto.includes("cn:song"), false, "手工书体必须压住自动书体");
  assert.equal(after.auto.some((t) => t.startsWith("cn:")), false);
});

test("场景 A：A/B 字体库来回切换，手动标签与否决都不回落", () => {
  const m = blank();
  const f = song();
  // 手工标签故意两种都放：一个自由标签（"我的宋体"）+ 一个互斥命名空间的值（cn:kai）。
  // 后者是核心：用户手动改过书体后，自动那套的 cn:* 必须整段让位 —— 换了字体库也一样。
  setManualTags(m, f, ["我的宋体", "cn:kai"]);
  deny(m, f.name, "style:italic");
  const beforeSwitch = view(f, m);

  // A → B：这个族暂时不在扫描结果里。state.json.tags / prefs.autoTagDenied 只有一份，
  // 切换字体库不写这两个文件 —— 用真实 JSON 往返模拟「落盘 → 换库 → 读回」。
  const onDisk = roundTrip(m);
  assert.deepEqual(onDisk.tags, m.tags, "切换库不得改动 tags 落盘内容");
  assert.deepEqual(onDisk.denied, m.denied, "切换库不得改动否决名单落盘内容");

  // B → A：重新扫描拿到同一族，路径 / 文件大小 / mtime 都可以不同；
  // 事实按**族名**重新喂给引擎，记忆按族名接上。
  const backInA = view(song(), onDisk);
  assert.deepEqual(backInA, beforeSwitch);
  assert.deepEqual(backInA.manual, ["我的宋体", "cn:kai"]);
  assert.equal(backInA.auto.includes("style:italic"), false, "否决过的标签不得复活");
  // 用户第 1 条需求的正面断言：切库回来后，软件自己的书体标签不许把用户改的那条盖回去。
  // （2026-11-14 QA 变异实验：漏掉这条时，把 manualTags 从引擎里摘掉的变异体照样全绿。）
  assert.equal(
    backInA.auto.some((t) => t.startsWith("cn:")),
    false,
    "手工书体必须压住自动书体，换库回来也一样",
  );

  // ── 反证 1：把落盘那份的该族标签删掉，manual 必须为空 ──
  // 若上面那条断言恒真，这一条就同样恒真；两条方向相反，才说明断言是活的。
  const wiped = roundTrip(m);
  delete wiped.tags["方正宋体"];
  const wipedView = view(song(), wiped);
  assert.deepEqual(wipedView.manual, [], "反证失败：删掉 tags 后不该还记着手工标签");
  // 同时证明「cn:* 一条都没有」上面那条不是空转：没有手工书体时它本来就会产 cn:song
  assert.ok(
    wipedView.auto.includes("cn:song"),
    "反证失败：手工书体被删掉后 cn:song 必须出现，否则前面「不许有 cn:*」的断言本身没有意义",
  );

  // ── 反证 2：把否决名单删掉，被否决的自动标签必须回来 ──
  const noDeny = roundTrip(m);
  delete noDeny.denied["方正宋体"];
  assert.ok(
    view(song(), noDeny).auto.includes("style:italic"),
    "反证失败：否决名单被删掉后 style:italic 必须重新出现（否则说明引擎压根不产它，前面的断言没有意义）",
  );
});

test("场景 B：移除文件夹 → 进程重启后重新导入，手动标签与否决仍在", () => {
  const dir = mkdtempSync(join(tmpdir(), "zfm-autotag-"));
  const file = join(dir, "state.json");
  try {
    const m = blank();
    const f = song();
    setManualTags(m, f, ["客户指定", "cn:kai"]);
    deny(m, f.name, "style:italic");
    const beforeRemove = view(f, m);

    // 移入回收站 / 移除文件夹之前，后端已经把这份数据写到盘上（tags 在 state.json，
    // 否决名单在 prefs.json；这里放同一个文件，只关心内容形状一致）。
    writeFileSync(file, JSON.stringify({ tags: m.tags, autoTagDenied: m.denied }), "utf8");

    // 移除文件夹 + 进程退出：内存全丢，只剩磁盘上这一份。
    // 再显式把文件 mtime 推到一分钟之后，证明**时间不参与任何判定**（没有「过期后重置」）。
    const oneMinuteLater = new Date(Date.now() + 60_000);
    utimesSync(file, oneMinuteLater, oneMinuteLater);

    // 重新启动 + 重新导入：从磁盘读回
    const disk = JSON.parse(readFileSync(file, "utf8")) as {
      tags: Record<string, string[]>;
      autoTagDenied: Record<string, string[]>;
    };
    const restored: Memory = { tags: disk.tags, denied: disk.autoTagDenied };

    const afterReimport = view(song(), restored);
    assert.deepEqual(afterReimport, beforeRemove, "重启 + 重导入后必须与移除前完全一致");
    assert.deepEqual(afterReimport.manual, ["客户指定", "cn:kai"]);
    assert.equal(afterReimport.auto.includes("style:italic"), false, "否决过的标签不得复活");
    assert.equal(
      afterReimport.auto.some((t) => t.startsWith("cn:")),
      false,
      "重启后手工书体仍要压住自动书体（记忆不只是显示，还要参与派生判定）",
    );

    // ── 反证 1：读回后手动清空 denied，被否决的自动标签必须回来 ──
    const noDeny = roundTrip(restored);
    noDeny.denied = {};
    assert.ok(
      view(song(), noDeny).auto.includes("style:italic"),
      "反证失败：denied 清空后 style:italic 必须回来，否则说明它本来就不受 denied 控制",
    );

    // ── 反证 2：读回后清空 tags，manual 必须为空 ──
    const noTags = roundTrip(restored);
    noTags.tags = {};
    const noTagsView = view(song(), noTags);
    assert.deepEqual(noTagsView.manual, [], "反证失败：tags 清空后不该还记着手工标签");
    assert.ok(
      noTagsView.auto.includes("cn:song"),
      "反证失败：手工书体没了之后 cn:song 必须出现，否则上面「重启后不许有 cn:*」是空转",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("场景 C：删除字体 → 导入同事发来的同一款，回来的是手动标签", () => {
  const m = blank();
  const f = song();
  setManualTags(m, f, ["已校对", "cn:kai"]);
  deny(m, f.name, "style:italic");
  const before = view(f, m);

  // 卸载只移除字体文件，不清 m.tags / m.denied（结构守卫见下面「卸载不清标签」两条）。
  // 同事那份文件的保存路径、文件大小、mtime 都可以不同；只要字体自报族名相同就接上记忆。
  const afterUninstall = roundTrip(m); // state.json / prefs.json 落盘内容不变
  const colleagueCopy = song();
  const after = view(colleagueCopy, afterUninstall);
  assert.deepEqual(after, before);
  assert.deepEqual(after.manual, ["已校对", "cn:kai"]);
  assert.equal(after.auto.includes("cn:song"), false);
  assert.equal(after.auto.includes("style:italic"), false);

  // 反证：真把这份记忆删掉，导入同事那份就只剩自动标签 —— 正是用户 2026-11-14 投诉的现象。
  const amnesia = roundTrip(m);
  amnesia.tags = {};
  const broken = view(colleagueCopy, amnesia);
  assert.deepEqual(broken.manual, []);
  assert.equal(broken.auto.includes("cn:song"), true, "没有手工书体时自动书体会重新占据 —— 反证成立");
});

test("同一款字体换了族名：不假装能识别，手工标签不会串到别的族", () => {
  const m = blank();
  setManualTags(m, song(), ["已校对"]);
  const renamed = song("FZSongTi");
  const other = view(renamed, m);
  assert.deepEqual(other.manual, [], "族名变了就是另一个键，不能凭文件名猜");
  assert.deepEqual(m.tags["方正宋体"], ["已校对"], "原族的记忆仍保留，改回原名还能接上");
});

test("口径：手工标签大小写/空格不同，摘掉时仍要记进否决名单", () => {
  const m = blank();
  const f = song();
  // 用户手工打的是 Style:Italic，软件推的是 style:italic —— 归一化后是同一条
  m.tags[f.name] = ["Style:Italic"];
  assert.ok(view(f, m).auto.includes("style:italic") === false, "手工已有同名标签，自动不得重复");

  setManualTags(m, f, []);
  assert.deepEqual(
    m.denied[f.name],
    ["style:italic"],
    "摘掉时必须归一化后再比对，否则软件下一帧就把标签推回来",
  );

  // 反证：不归一化就查不到 —— 这正是修正前的行为，说明这条断言是活的
  const unnormalized = new Set(deriveTags(f, {}).map((d) => d.tag));
  assert.equal(unnormalized.has("Style:Italic"), false, "未归一化的字符串在自动标签集合里查不到");
});

// ───────────────────────── 结构守卫：卸载不清标签 ─────────────────────────

/** 历史上「删掉再装回来只剩软件标签」的根因就长这样，容忍任意空白。 */
const CLEAR_TAGS_RE = /setFamilyTags\(\s*family\s*,\s*\[\s*\]\s*\)/;

/** 按顶层 action 边界切一段源码；切不到就返回空串（下面用长度断言兜住）。 */
function sliceAction(startMarker: string, endMarker: string): string {
  const start = STORE.indexOf(startMarker);
  const end = STORE.indexOf(endMarker);
  assert.ok(start > 0, `store 里找不到动作 ${startMarker} —— 改名了，守卫已失效，请同步更新`);
  assert.ok(end > start, `store 里找不到 ${startMarker} 的结束边界 ${endMarker} —— 守卫已失效`);
  return STORE.slice(start, end);
}

test("结构守卫：卸载（单个 / 批量）不清空用户标签", () => {
  // 正控：这条正则必须能命中「坏写法」，否则下面的否定断言没有意义
  assert.match(
    "if (!alive) void get().setFamilyTags( family , [ ] );",
    CLEAR_TAGS_RE,
    "正控失败：守卫正则写得太死，命不中带空白的坏写法",
  );

  const single = sliceAction("uninstallFontFile: async (path) => {", "installPaths: async (paths, mode) => {");
  const batch = sliceAction("uninstallFamilies: async (families, opts) => {", "confirmTrash: async () => {");

  // 切片必须非空且确实是那段函数，否则「没命中」只是切错了（空串恒不匹配的假绿）
  assert.ok(single.length > 500, `单个卸载切片过短（${single.length}）—— 边界标记变了？`);
  assert.ok(batch.length > 500, `批量卸载切片过短（${batch.length}）—— 边界标记变了？`);
  assert.ok(single.includes("ipc.uninstallFont("), "单个卸载切片里没有 ipc.uninstallFont，切错段了");
  assert.ok(batch.includes("ipc.uninstallFonts("), "批量卸载切片里没有 ipc.uninstallFonts，切错段了");

  assert.equal(CLEAR_TAGS_RE.test(single), false, "单个卸载不得 setFamilyTags(family, [])");
  assert.equal(CLEAR_TAGS_RE.test(batch), false, "批量卸载不得 setFamilyTags(family, [])");

  // 弱断言（只作提示，不当证据）：实现里应该留一句解释，别再被谁加回去。
  // 它证明不了行为，只是让下一个人改到这里时看得见结论。
  assert.match(single, /不清标签/, "单个卸载缺「不清标签」的说明注释（弱断言，仅提示）");
  assert.match(batch, /不清标签/, "批量卸载缺「不清标签」的说明注释（弱断言，仅提示）");
});

test("结构守卫：开关与否决名单都进 prefs，重启后不失忆", () => {
  assert.ok(STORE.includes("autoTagEnabled: s.autoTagEnabled"));
  assert.ok(STORE.includes("autoTagDenied: s.autoTagDenied"));
  assert.ok(STORE.includes("autoTagEnabled: prefs.autoTagEnabled !== false"));
  assert.ok(STORE.includes("const raw = prefs.autoTagDenied"));
  // 源码顺序：配置必须在第一个 familiesFor(...) 调用之前换掉，否则首屏会闪一次默认标签。
  // 这是文本序检查（不是运行时证明），但比单纯 indexOf > 0 有意义：它排除了「写在文件末尾」。
  const cfgAt = STORE.indexOf("setAutoTagConfig({ enabled: get().autoTagEnabled");
  const firstCall = STORE.indexOf("familiesFor(get().fonts");
  assert.ok(cfgAt > 0, "找不到启动时装载自动标签配置的调用");
  assert.ok(firstCall > 0, "找不到 familiesFor(get().fonts 的调用点");
  assert.ok(cfgAt < firstCall, "配置装载写在首次 familiesFor 之后 —— 首屏会用默认配置算一次");
});

test("结构守卫：自动标签只挂 Family.autoTags，筛选/搜索走统一口径", () => {
  assert.ok(STORE.includes("fam.autoTags = auto"));
  assert.equal(STORE.includes("fam.tags = [...fam.tags"), false);
  assert.ok(STORE.includes("tagFilter.every((tg) => familyHasTag(f, tg))"));
  assert.ok(STORE.includes("out = out.filter((f) => familyHasTag(f, tag))"));
  // 缓存第三维必须是自动标签配置，否则点「不再建议」后界面不变
  assert.ok(STORE.includes("byAuto.get(autoTagConfig)"));
});

test("文件安全：自动标签引擎没有任何文件/IPC 能力", () => {
  // 用户 2026-11-14：筛选和打标签不能动字体文件、不能在库里增删文件。
  // 引擎是纯函数，连 ipc/fs 都不能 import；持久化只发生在 prefs（数据目录，不在字体库）。
  for (const src of [ENGINE, VOCAB]) {
    assert.equal(src.includes("@tauri-apps"), false);
    assert.equal(src.includes("invoke("), false);
    assert.equal(src.includes("writeFile"), false);
    assert.equal(src.includes("removeFile"), false);
    assert.equal(src.includes("mkdir"), false);
    // 不断言 state.json / libraryDir 字面：设计注释里必须能解释这两个词
    assert.equal(src.includes("setTags("), false);
    assert.equal(src.includes("scanFonts("), false);
  }
  const denyBody = STORE.slice(
    STORE.indexOf("  denyAutoTag: (family, tag) => {"),
    STORE.indexOf("  allowAutoTag: (family, tag) => {"),
  );
  assert.ok(denyBody.length > 100, "denyAutoTag 切片过短 —— 动作改名了，守卫已失效");
  assert.ok(denyBody.includes("persistPrefs"));
  assert.equal(denyBody.includes("ipc."), false, "否决自动标签不能触发任何文件/字体 IPC");
});
