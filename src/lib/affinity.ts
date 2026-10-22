import type { FontFace } from "./ipc";

export interface AffinityFontNeed {
  name: string;
  installed: boolean;
}

export interface AffinityDoc {
  title: string;
  path: string;
  fonts: AffinityFontNeed[];
}

export interface AffinityEvent {
  kind: "needs" | "deactivated" | "error" | string;
  docs: AffinityDoc[];
  message: string | null;
}

const lower = (s: string | null | undefined) => (s ?? "").toLowerCase();
const squash = (s: string | null | undefined) => lower(s).replace(/[\s_-]+/g, "");

function familyFor(faces: FontFace[], want: string): string | null {
  const exact = faces.find((f) => lower(f.postscriptName) === lower(want));
  if (exact) return exact.family;
  const key = squash(want);
  const loose =
    faces.find((f) => squash(f.postscriptName) === key) ??
    faces.find((f) => squash(`${f.family}${f.style}`) === key) ??
    faces.find((f) => squash(f.family) === key);
  if (loose) return loose.family;
  const dash = want.indexOf("-");
  if (dash > 0) {
    const famKey = squash(want.slice(0, dash));
    const byPrefix = faces.find((f) => squash(f.family) === famKey);
    if (byPrefix) return byPrefix.family;
  }
  return null;
}

export function matchAffinityFonts(faces: FontFace[], needs: AffinityFontNeed[]): string[] {
  const families = new Set<string>();
  for (const need of needs) {
    if (need.installed) continue;
    const want = need.name.trim();
    if (!want) continue;
    const family = familyFor(faces, want);
    if (family !== null) families.add(family);
  }
  const paths = faces
    .filter((f) => families.has(f.family) && f.deactivatable && !f.active)
    .map((f) => f.path);
  return [...new Set(paths)];
}
