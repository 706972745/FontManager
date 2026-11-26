import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { requestTakedown, dirNameOf } from "../src/workshop/upload.ts";

/**
 * 下架（2026-11-25 用户报「仓库里的插件并没有删除」）。
 *
 * 根因：`index.json` 的 `dir` 是**仓库相对路径** `plugins/<id>__<作者>`，下架代码却把它
 * 直接塞进 `plugins/${dir}/`，拼成 `plugins/plugins/...` —— 一条 blob 都匹配不上，
 * 于是插件明明还在仓库里，面板却报「仓库里已经没有这个插件目录了」。
 *
 * 这里钉两件事：① 归一化只取最后一段且拒绝越界；② 删除路径与面板入口都必须走它。
 */

const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

test("dirNameOf：仓库相对路径只取最后一段", () => {
  assert.equal(dirNameOf("plugins/FM-ADOBE-FONT__helloooooseff"), "FM-ADOBE-FONT__helloooooseff");
  assert.equal(dirNameOf("plugins/FM-FONT-RENAME__alice"), "FM-FONT-RENAME__alice");
  assert.equal(dirNameOf("plugins/my.plugin__alice"), "my.plugin__alice");
  // 裸目录名（面板自己拼的那种）原样保留
  assert.equal(dirNameOf("FM-FONT-RENAME__alice"), "FM-FONT-RENAME__alice");
  assert.equal(dirNameOf("  plugins/a__b  "), "a__b", "前后空白要容忍");
});

test("dirNameOf：越界 / 非法输入一律 null（与 Rust 的 dir_name_of 同口径）", () => {
  assert.equal(dirNameOf("plugins/../evil"), null);
  assert.equal(dirNameOf("../evil"), null);
  assert.equal(dirNameOf("plugins/./evil"), null);
  assert.equal(dirNameOf(".."), null);
  assert.equal(dirNameOf("."), null);
  assert.equal(dirNameOf("plugins\\..\\evil"), null);
  assert.equal(dirNameOf("plugins\\evil"), null);
  assert.equal(dirNameOf("C:/evil"), null);
  assert.equal(dirNameOf("evil:stream"), null);
  assert.equal(dirNameOf("plugins/.hidden"), null);
  assert.equal(dirNameOf("plugins/"), null, "末段为空 → null，不回落成 plugins");
  assert.equal(dirNameOf(""), null);
  assert.equal(dirNameOf("   "), null);
  assert.equal(dirNameOf("plugins/a b"), null);
});

test("两个下架入口都先用 dirNameOf 归一化，不再直接拿 dirs 拼路径", () => {
  const src = read("src/workshop/upload.ts");
  assert.match(src, /function removeTargets\(/, "缺少归一化入口");
  assert.match(src, /dirNameOf\(d\)/);
  // 直推（维护者）与 issue（作者）两条路都必须用归一化后的 names 去匹配 blob
  const matches = src.match(/names\.some\(\(d\) => e\.path\.startsWith\(`plugins\/\$\{d\}\/`\)\)/g) ?? [];
  assert.equal(matches.length, 1, "直推那条路要按目录名匹配 blob");
  assert.match(src, /const names = removeTargets\(args\);[\s\S]{0,400}?plugins\/\$\{d\}/, "issue 通道也要用归一化后的目录名");
  assert.equal(
    /dirs\.some\(\(d\) => e\.path\.startsWith/.test(src),
    false,
    "还有一处拿原始 dirs 拼 `plugins/${dir}/` —— 会拼出 plugins/plugins/…",
  );
});

test("面板交给下架的目录来自 communityDirFor（末段），不是 registry 的整条路径", () => {
  const src = read("src/workshop/UploadDialog.tsx");
  assert.match(src, /communityDirFor\(e\)/);
  assert.equal(/dir: e\.dir!/.test(src), false, "不能再把 registry 的 dir 原样传给下架");
});

/**
 * 2026-11-25 第二轮：普通作者点下架 → 「上传失败 — Not Found」。
 *
 * 原因是面板无条件先试**直推 main**。没有仓库写权限的账号，GitHub 回的状态码并不固定
 * （403 认得出来，**404 就变成一句 Not Found**），而 404 不在退回 PR 的名单里，
 * 于是既没下架、也没提交请求。
 */
test("非维护者不再先撞直推：直接开 [takedown] issue", () => {
  const src = read("src/workshop/UploadDialog.tsx");
  const at = src.indexOf("const removeOne");
  assert.ok(at > 0, "找不到 removeOne");
  const body = src.slice(at, src.indexOf("const author", at));
  assert.match(body, /if \(isMaintainer\)/, "直推必须先按维护者身份分流");
  // 直推那段的 catch 里，404 也要能退回（GitHub 用它表示没写权限）
  assert.match(body, /\[403, 404, 409, 422\]/);
  assert.match(body, /requestTakedown\(/, "普通作者走 issue 通道");
  assert.match(body, /uploadDeleteSubmitted/, "普通作者要看到「已提交下架请求 #N」");
  assert.equal(
    /deletePlugins\(/.test(body),
    false,
    "不能再走 fork+PR：fork 落后时同步必失败（并且会 404 成「没有权限」）",
  );
});


test("空 fork 时能自己把 main 建出来（上传共用一份 forkBase）", () => {
  const src = read("src/workshop/upload.ts");
  assert.match(src, /async function forkBase/, "同步/建 fork 的逻辑必须只有一份");
  assert.equal(
    (src.match(/await forkBase\(/g) ?? []).length,
    1,
    "上传走 forkBase；下架已改为 issue 通道（不碰 fork）",
  );
  assert.match(src, /ref: "refs\/heads\/main", sha: upSha/, "空 fork → 按上游 sha 建 main");
});



/**
 * 2026-11-25 真机根因（helloooooseff 下架 Adobe 套字器 → 「上传失败 — Not Found」）：
 *
 * 下架 PR 要求先把 fork 同步到上游，而上游 main 含 `.github/workflows/*`；
 * 令牌缺 `workflow` scope 时 GitHub 回 **404**（不是 403）。fork 只要落后一次，
 * 下架就永远失败，界面还只给一句「Not Found」。
 *
 * 新通道：开一个 `[takedown]` issue，由仓库 Action 校验「发起人 == 目录署名者」后直删。
 * 这里钉死：只发一个 issue、标题机器可读、不碰 fork、不改别人的目录。
 */
test("下架走 [takedown] issue：只发一个 issue，不碰 fork / PR", async () => {
  const calls: { method: string; url: string; body: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any = {}) => {
    calls.push({ method: init.method ?? "GET", url: String(url), body: init.body ? JSON.parse(init.body) : null });
    return {
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ number: 42, html_url: "https://github.com/x/y/issues/42" }),
    };
  }) as unknown as typeof fetch;

  let out;
  try {
    out = await requestTakedown({
      token: "t",
      login: "alice",
      dirs: ["plugins/FM-ADOBE-FONT__alice"],
      onPhase: () => {},
      allowAny: false,
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(out.issueNumber, 42);
  assert.equal(calls.length, 1, "下架只该有一次请求（issue）；碰 fork 就会重新掉进 404 坑");
  const req = calls[0];
  assert.equal(req.method, "POST");
  assert.equal(req.url, "https://api.github.com/repos/706972745/FontManager-Workshop/issues");
  assert.equal(req.body.title, "[takedown] plugins/FM-ADOBE-FONT__alice");
  assert.match(req.body.body, /@alice/);
  assert.match(req.body.body, /plugins\/FM-ADOBE-FONT__alice/);
});

test("下架归属：登录名大小写不敏感；别人的目录本地就拦住", async () => {
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (async () => {
    called += 1;
    return { ok: true, status: 201, text: async () => JSON.stringify({ number: 1, html_url: "u" }) };
  }) as unknown as typeof fetch;
  try {
    // GitHub 登录名大小写不敏感：清单写 Helloooooseff、token 回 helloooooseff 是同一个人
    await requestTakedown({
      token: "t",
      login: "helloooooseff",
      dirs: ["plugins/x__Helloooooseff"],
      onPhase: () => {},
      allowAny: false,
    });
    assert.equal(called, 1, "大小写不同也是本人，应当放行");

    await assert.rejects(
      () =>
        requestTakedown({
          token: "t",
          login: "someone-else",
          dirs: ["plugins/x__alice"],
          onPhase: () => {},
          allowAny: false,
        }),
      (e: any) => e?.name === "UploadMessage" && e.key === "uploadErrNotOwner",
    );
    assert.equal(called, 1, "别人的目录本地就拦住，不发请求");
  } finally {
    globalThis.fetch = realFetch;
  }
});

/**
 * 「已下架（待生效）」：提交成功后**不能**立刻把这一行从「我的插件」里剔掉。
 *
 * 以前剔掉之后，列表凭空少一条、只剩底下那行小字，用户没法确认自己刚点的是哪一条，
 * 也就分不清「成功了」和「点空了」。现在保留这一行、压灰挂标签，等清单重算后
 * 条目真的消失，这行才跟着走 —— 同时要把消失后的孤儿标记清掉，否则维护者
 * 手动恢复上架，那一行会永远只剩灰条、下架按钮回不来。
 */
test("已下架的行保留为待生效灰条，且清单重算后自动摘掉标记", () => {
  const src = read("src/workshop/UploadDialog.tsx");

  // ① 不再「提交即移除」
  assert.equal(
    /if \(!dir \|\| deleted\.includes\(dir\)\) continue/.test(src),
    false,
    "不能在下架后立刻把条目过滤掉——那一行要留成灰条",
  );
  assert.match(src, /pending: deleted\.includes\(dir\)/, "保留的条目要带上待生效标记");

  // ② 右侧按钮换成灰标签，不给「再点一次」
  assert.match(src, /ws-up-tag-pending/, "待生效要用专属灰标签，不能复用删除按钮");
  assert.match(src, /uploadDeletePendingTag/, "文案走 i18n，不能硬写中文");
  assert.match(src, /pending \? \(/, "待生效与可下架必须是两条渲染分支");

  // ③ 孤儿标记清理（恢复上架后按钮能回来）
  assert.match(src, /const kept = deleted\.filter\(\(d\) => present\.has\(d\)\)/, "要按 entries 清掉已消失的标记");
  assert.match(src, /if \(kept\.length !== deleted\.length\) setDeleted\(kept\)/, "只在真有变化时 setState，否则无限重渲染");

  // ④ 9 种语言都要有这条文案（check-locales 只看 key 齐不齐，值写错它不管）
  const i18n = read("src/workshop/i18n.ts");
  assert.equal(
    (i18n.match(/"uploadDeletePendingTag"/g) ?? []).length,
    9,
    "九套语言各一条 uploadDeletePendingTag",
  );
});
