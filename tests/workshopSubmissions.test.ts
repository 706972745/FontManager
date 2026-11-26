import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addTakedown,
  addUploads,
  dropTakedown,
  dropUpload,
  patchTakedown,
  patchUpload,
  pendingCount,
  readStore,
  resetStore,
} from "../src/workshop/submissions.ts";

/**
 * 2026-11-26 用户反馈的两条「体验」问题，根因都是**弹窗一关就失忆**：
 *
 * 1. 上传完关掉再开，等待审批的提示没了 → 用户以为没上架成功；
 * 2. 下架后关掉再开，灰条没了、按钮又变回可点 → 用户以为没下架成功。
 *
 * 对策：把这两类动作落进一份持久记录（`submissions.ts`），弹窗每次挂载都先读它。
 * 另外，下架是不是生效了要**自己每几秒探一次目录**（而不是只等清单），
 * 探到 404 就把标签从「待生效」换成「已下架」。
 */

const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

const upload = (dir: string, version = "1.0.0") => ({
  dir,
  id: dir.split("__")[0],
  name: "Demo",
  version,
  prNumber: 12,
  prUrl: "https://github.com/x/y/pull/12",
});

test("上传记录：同一目录以最新一次为准（重传就是覆盖，不叠两行）", () => {
  resetStore();
  addUploads([upload("demo__alice", "1.0.0")]);
  addUploads([upload("demo__alice", "1.1.0")]);
  const rows = readStore().uploads;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, "1.1.0");
  assert.equal(rows[0].state, "pending", "新记录默认是「等待审核」");
});

test("上传记录：合并 / 关闭要及时反映，生效后能删掉", () => {
  resetStore();
  addUploads([upload("demo__alice")]);
  assert.equal(pendingCount(), 1);
  patchUpload("demo__alice", { state: "merged" });
  assert.equal(readStore().uploads[0].state, "merged");
  assert.equal(pendingCount(), 0, "已合并的不再算「未落地」");
  dropUpload("demo__alice");
  assert.equal(readStore().uploads.length, 0);
});

test("下架记录：探到目录 404 后打 goneAt，界面据此把「待生效」换成「已下架」", () => {
  resetStore();
  addTakedown({ dir: "demo__alice", id: "demo", name: "Demo", mode: "issue", issueNumber: 7 });
  assert.equal(readStore().takedowns[0].goneAt, undefined);
  assert.equal(pendingCount(), 1);
  patchTakedown("demo__alice", { goneAt: 1_700_000_000_000 });
  assert.equal(readStore().takedowns[0].goneAt, 1_700_000_000_000);
  dropTakedown("demo__alice");
  assert.equal(readStore().takedowns.length, 0);
});

test("重复点下架不会堆记录（失败重试 = 覆盖同一条）", () => {
  resetStore();
  addTakedown({ dir: "demo__alice", id: "demo", name: "Demo", mode: "direct" });
  addTakedown({ dir: "demo__alice", id: "demo", name: "Demo", mode: "issue", issueNumber: 9 });
  const rows = readStore().takedowns;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mode, "issue");
});

test("弹窗：待下架状态从持久记录初始化，重开不再变回「可以下架」", () => {
  const dlg = read("src/workshop/UploadDialog.tsx");
  assert.match(
    dlg,
    /useState<string\[\]>\(\(\) =>\s*readStore\(\)\.takedowns\.map\(\(r\) => r\.dir\)/,
    "deleted 的初值要来自持久记录",
  );
  assert.match(dlg, /addTakedown\(\{/, "提交成功要记一笔");
  assert.match(dlg, /setSubs\(addTakedown\(\{ dir, id, name, mode: "direct"/, "直推成功也要记");
});

test("弹窗：上传成功落持久记录，重开还能看到「等待审核」", () => {
  const dlg = read("src/workshop/UploadDialog.tsx");
  assert.match(dlg, /addUploads\(/, "提交成功要落记录");
  const fn = dlg.slice(dlg.indexOf("const submit = useCallback"), dlg.indexOf("const phaseText"));
  assert.match(fn, /prNumber: out\.prNumber/, "记录要带 PR 号");
  assert.match(fn, /version: d\.form\.version\.trim\(\)/, "要带版本号（判断「已上架」用）");
  assert.match(dlg, /uploadSubsTitle/, "要有「我的提交」这一块");
  assert.match(dlg, /uploadSubsPending/, "等待审核的文案");
  assert.match(dlg, /uploadDeleteDoneTag/, "灰条要能变「已下架」");
});

test("弹窗：下架状态每 5 秒自查一次（404 = 真没了 → 立刻翻文案并请面板刷新）", () => {
  const dlg = read("src/workshop/UploadDialog.tsx");
  assert.match(dlg, /probePluginDir\(rec\.dir\)/, "用目录探测判断，而不是等清单");
  assert.match(dlg, /patchTakedown\(rec\.dir, \{ goneAt: Date\.now\(\) \}\)/, "探到 404 落 goneAt");
  assert.match(dlg, /window\.setInterval\(\(\) => void tick\(\), 5_000\)/, "5 秒一轮");
  assert.match(dlg, /onRefresh\(\)/, "确认没了要让面板强拉一次清单");
});

test("弹窗：PR 状态按分钟级轮询（github API 有限流，不能秒级打）", () => {
  const dlg = read("src/workshop/UploadDialog.tsx");
  assert.match(dlg, /pullStatus\(token, rec\.prNumber\)/);
  assert.match(dlg, /window\.setInterval\(\(\) => void tick\(\), 60_000\)/, "一分钟一轮");
  assert.match(dlg, /if \(state === "merged"\) onRefresh\(\)/, "合并后要让中心自己冒出来");
});

test("面板：宽限期「放回列表」必须再问一次 GitHub API（加速器会骗人）", () => {
  const app = read("src/workshop/App.tsx");
  assert.match(app, /async function stillInRepo\(/, "二次确认要独立成函数");
  assert.match(app, /probePluginDirApi\(dir\)/, "用 API 的 contents 判断目录还在不在");
  assert.match(app, /const reallyThere = await stillInRepo\(stillThere, dirOf\)/, "宽限期要用它");
  assert.match(app, /dropTakedown\(dir\)/, "真没删掉时持久记录也要撤，否则灰条永远不走");
  assert.match(app, /setNotice\(t\("takedownFailed"\)\)/, "要告诉用户「这次没生效」");
});

test("面板：有未落地的动作时持续拉清单，合并后自动出现", () => {
  const app = read("src/workshop/App.tsx");
  assert.match(app, /onChanged=\{onSubsChanged\}/, "弹窗要通知记录变化");
  assert.match(
    app,
    /const refreshIndex = useCallback\(\(\) => void load\(true\), \[load\]\)/,
    "onRefresh 必须是稳定回调（否则弹窗的轮询定时器每次重渲染都被重置）",
  );
  assert.match(app, /onRefresh=\{refreshIndex\}/, "弹窗要能请面板强拉");
  assert.match(
    app,
    /if \(!uploadOpen \|\| pendingSubs === 0\) return;[\s\S]{0,160}?15_000/,
    "弹窗开着且有待落地动作时，15 秒拉一次",
  );
});

test("下架记录可以打隐藏标记：不清状态、只不占位置", () => {
  resetStore();
  addTakedown({ dir: "demo__alice", id: "demo", name: "Demo", mode: "direct" });
  patchTakedown("demo__alice", { hidden: true });
  const rec = readStore().takedowns[0];
  assert.equal(rec.hidden, true);
  assert.equal(pendingCount(), 1, "记录还在，面板仍要盯着清单");
  dropTakedown("demo__alice");
  assert.equal(readStore().takedowns.length, 0);
});

test("弹窗：每条记录都能单独删掉，已完成的可一把清空", () => {
  const dlg = read("src/workshop/UploadDialog.tsx");
  assert.match(dlg, /const forgetUpload = useCallback\(/, "上传记录要能单独移除");
  assert.match(dlg, /setSubs\(dropUpload\(dir\)\)/, "移除 = 删本地记录（不撤 PR）");
  assert.match(dlg, /const clearDoneSubs = useCallback\(/, "要有「清空已完成」");
  assert.match(dlg, /uploadSubsClearDone/, "按钮文案走 i18n");
  assert.match(dlg, /const hideTakedown = useCallback\(/, "下架灰条也要能清掉");
  assert.match(dlg, /patchTakedown\(dir, \{ hidden: true \}\)/, "只打隐藏标记，不删记录");
  assert.match(dlg, /r\.hidden/, "「我上传的插件」要跳过被清掉的行");
});

test("新文案九套语言齐全", () => {
  const i18n = read("src/workshop/i18n.ts");
  for (const key of [
    "uploadSubsTitle",
    "uploadSubsHint",
    "uploadSubsPending",
    "uploadSubsMerged",
    "uploadSubsClosed",
    "uploadDeleteDoneTag",
    "takedownFailed",
    "uploadRecRemove",
    "uploadSubsClearDone",
  ]) {
    assert.equal((i18n.match(new RegExp(`"${key}"`, "g")) ?? []).length, 9, `${key} 要有九套语言`);
  }
});
