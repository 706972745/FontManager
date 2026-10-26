import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLicense, effectiveCopyrightClass } from "../src/lib/license.ts";

test("classifyLicense recognizes open, restrictive and unknown licenses", () => {
  assert.equal(classifyLicense("Licensed under the SIL Open Font License 1.1"), "open");
  assert.equal(classifyLicense("Personal use only, may not be redistributed"), "restrictive");
  assert.equal(classifyLicense("Some custom wording"), "unknown");
  assert.equal(classifyLicense(null), "unknown");
});

test("effectiveCopyrightClass maps license text to a copyright class", () => {
  assert.equal(effectiveCopyrightClass("SIL Open Font License"), "free");
  assert.equal(effectiveCopyrightClass("Trial version, evaluation only"), "paid");
  assert.equal(effectiveCopyrightClass(null), "unknown");
});

test("manual copyright status overrides the auto-detected class", () => {
  assert.equal(effectiveCopyrightClass("SIL Open Font License", "paid"), "paid");
  assert.equal(effectiveCopyrightClass("Trial version", "timelimited"), "timelimited");
  assert.equal(effectiveCopyrightClass(null, "free"), "free");
});

test('"auto" and unknown override values fall back to auto detection', () => {
  assert.equal(effectiveCopyrightClass("SIL Open Font License", "auto"), "free");
  assert.equal(effectiveCopyrightClass("SIL Open Font License", undefined), "free");
  assert.equal(effectiveCopyrightClass(null, "bogus"), "unknown");
});
