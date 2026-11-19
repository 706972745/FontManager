import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 「装不了」的提示必须分清是**我们没发包**还是**你连不上网**（2026-11-19）。
 *
 * 真实案例：客户在 2.3.1 点「下载并安装」，界面说「这一版发布里没有可直接安装的
 * setup.exe」—— 他以为我们漏打包，实际是他那边请求 api.github.com 被限流/拦截，
 * `check()` 走了 raw / jsDelivr 兜底源，而兜底源（package.json）只有版本号，
 * 没有资产地址与 sha256。两条完全不同的原因共用了 no-asset 的文案。
 *
 * 现在：兜底路径报 `offline`，只有「API 通了、release 里真没有 setup.exe」才报 no-asset。
 * 这里钉三点，少一处这次的误报就会回来。
 */

const read = (p: string) => readFileSync(p, "utf8");

test("后端兜底路径报 offline，不能报 no-asset", () => {
  const rs = read("src-tauri/src/update.rs");
  // 兜底函数的函数体：从 from_package_json 开始到下一个顶层 fn
  const body = rs.slice(rs.indexOf("async fn from_package_json"));
  const end = body.indexOf("\nasync fn ", 10);
  const scope = end === -1 ? body : body.slice(0, end);
  assert.match(scope, /auto_install_blocked:\s*"offline"/, "兜底源必须报 offline");
  assert.doesNotMatch(
    scope,
    /auto_install_blocked:\s*"no-asset"/,
    "兜底源又报成 no-asset 了 —— 用户会以为是我们没打包",
  );
});

test("前端把 offline 映射到独立文案", () => {
  const tsx = read("src/components/UpdateSection.tsx");
  assert.match(
    tsx,
    /offline:\s*"settings\.updateManualHintOffline"/,
    "BLOCKED_HINT 里没有 offline → 会退回那句含糊的「这一版没有包」",
  );
});

test("九种语言都有 updateManualHintOffline 且与 NoAsset 文案不同", () => {
  for (const loc of ["en", "de", "es", "fr", "ja", "pt-BR", "ru", "zh-CN", "zh-TW"]) {
    const dict = JSON.parse(read(`src/locales/${loc}.json`)) as Record<string, string>;
    const offline = dict["settings.updateManualHintOffline"];
    const noAsset = dict["settings.updateManualHintNoAsset"];
    assert.ok(offline, `${loc} 缺 settings.updateManualHintOffline`);
    assert.ok(noAsset, `${loc} 缺 settings.updateManualHintNoAsset`);
    assert.notEqual(offline, noAsset, `${loc} 两条文案一模一样 = 又回到「分不清原因」`);
  }
});
