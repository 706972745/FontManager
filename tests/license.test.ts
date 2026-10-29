import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLicense, copyrightExpired, effectiveCopyrightClass } from "../src/lib/license.ts";

test("classifyLicense recognizes open, restrictive and unknown licenses", () => {
  assert.equal(classifyLicense("Licensed under the SIL Open Font License 1.1"), "open");
  assert.equal(classifyLicense("Personal use only, may not be redistributed"), "personal");
  assert.equal(classifyLicense("Some custom wording"), "unknown");
  // 个人免费 + 商用要买（Gobold 那类写法）→ 个人免费
  assert.equal(
    classifyLicense("Personal use: FREE. Commercial use: buy the commercial license."),
    "personal",
  );
  assert.equal(classifyLicense(null), "unknown");
});

test("weak evidence stays unknown (口径：宁可不说，也不能说错)", () => {
  // 只写「免费」，没说能不能商用
  assert.equal(classifyLicense("免费下载，欢迎分享"), "unknown");
  assert.equal(classifyLicense("This font is free."), "unknown");
  assert.equal(classifyLicense("Freely available from our site"), "unknown");
  // 「保留所有权利 / 不许转发」讲的是分发，不等于收费
  assert.equal(classifyLicense("All rights reserved. May not be redistributed."), "unknown");
  // 明确了才能下结论
  assert.equal(classifyLicense("完全免费，可商用"), "open");
  assert.equal(classifyLicense("本字体免费，禁止商用"), "personal");
});

test("explicit commercial grant beats the word non-commercial", () => {
  assert.equal(
    classifyLicense("This font is freeware. Free for commercial or non-commercial use."),
    "open",
  );
  assert.equal(classifyLicense("不可商用"), "personal");
});

test("short markers need word boundaries", () => {
  assert.equal(classifyLicense("Soflow Sans Display"), "unknown");
  assert.equal(classifyLicense("License: OFL"), "open");
  assert.equal(classifyLicense("GPL2 with font embedding exception"), "open");
  assert.equal(classifyLicense("License: GPLv3"), "open");
});

test("contradictory license text is not guessed", () => {
  assert.equal(
    classifyLicense("Licensed under the SIL Open Font License. Purchase a license for commercial use."),
    "unknown",
  );
});

test("effectiveCopyrightClass maps license text to a copyright class", () => {
  assert.equal(effectiveCopyrightClass("SIL Open Font License"), "free_commercial");
  assert.equal(effectiveCopyrightClass("Trial version, evaluation only"), "paid");
  assert.equal(effectiveCopyrightClass(null), "unknown");
});

test("manual copyright status overrides the auto-detected class", () => {
  assert.equal(effectiveCopyrightClass("SIL Open Font License", "paid"), "paid");
  assert.equal(effectiveCopyrightClass("Trial version", "timelimited"), "timelimited");
  assert.equal(effectiveCopyrightClass(null, "free"), "free_commercial");
});

test('"auto" and unknown override values fall back to auto detection', () => {
  assert.equal(effectiveCopyrightClass("SIL Open Font License", "auto"), "free_commercial");
  assert.equal(effectiveCopyrightClass("SIL Open Font License", undefined), "free_commercial");
  assert.equal(effectiveCopyrightClass(null, "bogus"), "unknown");
});

test("copyrightExpired judges the YYYY-MM-DD expiry date", () => {
  assert.equal(copyrightExpired(null), false);
  assert.equal(copyrightExpired(undefined), false);
  assert.equal(copyrightExpired(""), false);
  assert.equal(copyrightExpired("not-a-date"), false);
  // 过去的日期 → 已到期
  assert.equal(copyrightExpired("2000-01-01"), true);
  // 很远的未来 → 未到期
  assert.equal(copyrightExpired("9999-12-31"), false);
});
