import { test } from "node:test";
import assert from "node:assert/strict";
import { familyActivation, isEnabledNow, pathsToToggle } from "../src/lib/familyState.ts";
import { TEXT, library, of } from "./fixtures.ts";

test("a family is inactive, partly active or active", () => {
  const faces = of(library(), TEXT);
  assert.deepEqual(familyActivation(faces), { active: false, partial: false, activeCount: 0 });
  faces[0].active = true;
  assert.deepEqual(familyActivation(faces), { active: false, partial: true, activeCount: 1 });
  for (const f of faces) f.active = true;
  assert.deepEqual(familyActivation(faces), { active: true, partial: false, activeCount: 12 });
});

test("an empty family is not active", () => {
  assert.deepEqual(familyActivation([]), { active: false, partial: false, activeCount: 0 });
});

test("activating a partly active family sends only the missing files", () => {
  const faces = of(library(), TEXT);
  const regular = faces.find((f) => f.style === "Regular")!;
  regular.active = true;
  const paths = pathsToToggle(faces, true);
  assert.equal(paths.length, 11);
  assert.ok(!paths.includes(regular.path));
});

test("deactivating sends only the files that are on", () => {
  const faces = of(library(), TEXT);
  const regular = faces.find((f) => f.style === "Regular")!;
  regular.active = true;
  assert.deepEqual(pathsToToggle(faces, false), [regular.path]);
});

test("a collection file with several faces is sent once", () => {
  const faces = of(library(), TEXT).map((f) => ({ ...f, path: "/fonts/family.ttc" }));
  assert.deepEqual(pathsToToggle(faces, true), ["/fonts/family.ttc"]);
});

test("fonts the OS manages are never toggled", () => {
  const faces = of(library(), TEXT).map((f) => ({ ...f, deactivatable: false }));
  assert.deepEqual(pathsToToggle(faces, true), []);
});

/**
 * 速览的「已启用」口径（用户 2026-11-11）：速览的搜索框只能搜到已启用的字体。
 * 列表和搜索建议必须用同一个判定，否则建议里搜得到、点下去列表是空的。
 */
test("enabled-now covers whole family, partly active family and this session's activation", () => {
  const whole = { name: "Inter", active: true, partial: false };
  const partly = { name: "Helvetica", active: false, partial: true };
  const off = { name: "Arial", active: false, partial: false };
  assert.equal(isEnabledNow(whole, []), true);
  assert.equal(isEnabledNow(partly, []), true);
  assert.equal(isEnabledNow(off, []), false);
  // 只在这一节运行期间启用的族（重启就没了），速览也得当成「已启用」
  assert.equal(isEnabledNow(off, ["Arial"]), true);
  // 名字要完全一致：sessionActivated 里是别的族不算
  assert.equal(isEnabledNow(off, ["Arial Nova"]), false);
});
