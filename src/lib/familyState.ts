import type { FontFace } from "./ipc";

export interface FamilyActivation {
  active: boolean;
  partial: boolean;
  activeCount: number;
}

export function familyActivation(faces: FontFace[]): FamilyActivation {
  const activeCount = faces.filter((f) => f.active).length;
  const active = faces.length > 0 && activeCount === faces.length;
  return { active, partial: activeCount > 0 && !active, activeCount };
}

export function pathsToToggle(faces: FontFace[], active: boolean): string[] {
  const paths = faces
    .filter((f) => f.deactivatable && f.active !== active)
    .map((f) => f.path);
  return [...new Set(paths)];
}
