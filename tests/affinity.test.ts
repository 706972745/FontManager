import { test } from "node:test";
import assert from "node:assert/strict";
import { matchAffinityFonts } from "../src/lib/affinity.ts";
import { DISPLAY, TEXT, library, need, of, pathsOf } from "./fixtures.ts";

test("a document using one style brings in the whole family, and only that family", () => {
  const faces = library();
  const paths = matchAffinityFonts(faces, [need("SourceSerif4-Regular")]);
  assert.equal(paths.length, 12);
  assert.deepEqual(new Set(paths), pathsOf(of(faces, TEXT)));
});

test("Text and Display are told apart", () => {
  const faces = library();
  const paths = matchAffinityFonts(faces, [need("SourceSerif4Display-SemiboldIt")]);
  assert.deepEqual(new Set(paths), pathsOf(of(faces, DISPLAY)));
});

test("names match with spaces and hyphens ignored", () => {
  const noPostScript = library().map((f) => ({ ...f, postscriptName: null }));
  assert.equal(matchAffinityFonts(noPostScript, [need("SourceSerif4-Semibold")]).length, 12);
  assert.equal(matchAffinityFonts(library(), [need("Source Serif 4 Display")]).length, 12);
});

test("a style the library lacks still finds its family", () => {
  assert.equal(matchAffinityFonts(library(), [need("SourceSerif4-Hairline")]).length, 12);
});

test("unknown and installed fonts match nothing", () => {
  assert.deepEqual(matchAffinityFonts(library(), [need("Montserrat-Bold")]), []);
  assert.deepEqual(matchAffinityFonts(library(), [need("SourceSerif4-Regular", true)]), []);
  assert.deepEqual(matchAffinityFonts(library(), [need("   ")]), []);
});

test("styles already on are left out so ending the session keeps them on", () => {
  const faces = library();
  for (const f of of(faces, TEXT).slice(0, 5)) f.active = true;
  assert.equal(matchAffinityFonts(faces, [need("SourceSerif4-Regular")]).length, 7);
});

test("fonts the OS manages are never sent", () => {
  const faces = library().map((f) => ({ ...f, deactivatable: false }));
  assert.deepEqual(matchAffinityFonts(faces, [need("SourceSerif4-Regular")]), []);
});

test("several needs from the same family give each file once", () => {
  const paths = matchAffinityFonts(library(), [
    need("SourceSerif4-Regular"),
    need("SourceSerif4-Bold"),
    need("SourceSerif4-It"),
  ]);
  assert.equal(paths.length, 12);
  assert.equal(new Set(paths).size, 12);
});
