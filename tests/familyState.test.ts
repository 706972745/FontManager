import { test } from "node:test";
import assert from "node:assert/strict";
import { familyActivation, pathsToToggle } from "../src/lib/familyState.ts";
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
