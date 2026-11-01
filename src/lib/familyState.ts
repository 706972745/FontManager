import type { Classification, FontFace } from "./ipc";
// 带 .ts 扩展：本模块被 tests/ 用 node --test（原生 ESM）直接引入，
// 扩展名省略的话 Node 解析不到（Vite 能解析，Node 不能）。
import { leadFace } from "./license.ts";

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

/**
 * 字族的分类，口径与卡片预览 / 详情面板一致：看**代表字面**（`leadFace`：优先 Regular）。
 *
 * 以前的写法是在聚合循环里「碰见第一个非 unknown 的字面就定」，而卡片看的是代表字面，
 * 两者不一致时就出现**勾了「衬线」，列表里却出现无衬线字体的卡片**
 * （用户 2026-11-01 报；和 2026-10-31 修的版权徽标口径分裂是同一类问题）。
 * 典型场景：一个中东混排字族里 Regular 是无衬线、别的字面被判成衬线，
 * 谁先被扫到谁说了算，于是同一张卡在两处显示成两种分类。
 *
 * 代表字面自己也没判出来时，退到「全族出现最多的非空分类」，
 * 免得 Regular 字面缺 OS/2 / PANOSE 元数据就把整族归成 unknown。
 * 注意：调用方必须在字面按 style 排序**之后**再算，代表字面认的是 Regular。
 */
export function familyClassification(faces: readonly FontFace[]): Classification {
  const lead = leadFace(faces)?.classification;
  if (lead && lead !== "unknown") return lead;
  const tally = new Map<Classification, number>();
  for (const f of faces) {
    const c = f.classification;
    if (!c || c === "unknown") continue;
    tally.set(c, (tally.get(c) ?? 0) + 1);
  }
  let best: Classification = "unknown";
  let bestN = 0;
  for (const [c, n] of tally) {
    if (n > bestN) {
      best = c;
      bestN = n;
    }
  }
  return best;
}
