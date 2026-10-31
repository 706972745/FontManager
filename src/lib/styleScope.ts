import type { FontFace } from "./ipc";

/**
 * 「N 种样式」这个数字到底按哪个范围算（用户 2026-10-31）。
 *
 * 场景：快照 / 分组里只放了这一族的某几个字重，卡片展开后只列出那几个。
 * 但头部原来固定写「4 种样式」（字族全部字重），列表却只有 1 行，看上去像列表丢了东西。
 * 用户要求：**收窄时写成「1/4 种样式」**，全部字重都在时才写「4 种样式」。
 *
 * 去重口径与 `fontStore` 构建 `uniqueFaces` 时**完全一致**（PostScript 名优先，没有就按样式名）：
 * 同一字面在系统和库里各一份时只算一种，否则会写「6 种样式」而实际只有 3 种。
 */
function faceIdentity(face: FontFace): string {
  const ps = (face.postscriptName ?? "").trim().toLowerCase();
  if (ps) return ps;
  return `style:${(face.style ?? "").trim().toLowerCase()}`;
}

function uniqueCount(faces: readonly FontFace[]): number {
  const seen = new Set<string>();
  for (const f of faces) seen.add(faceIdentity(f));
  return seen.size;
}

export interface StyleScope {
  /** 当前视图实际列出来的字重数（去重后） */
  shown: number;
  /** 这个字族一共有的字重数（去重后） */
  total: number;
  /** 是否被快照 / 分组收窄过 —— 决定头部写不写分数 */
  narrowed: boolean;
}

export function styleScope(
  shownFaces: readonly FontFace[],
  allFaces: readonly FontFace[],
): StyleScope {
  const total = uniqueCount(allFaces);
  // shown 不会超过 total：收窄只做过滤，不新增字面
  const shown = Math.min(uniqueCount(shownFaces), total);
  return { shown, total, narrowed: shown > 0 && shown < total };
}

/**
 * 头部那个数字的最终文字。
 *
 * 优先级：被收窄（写分数）> 只启用了部分字重（写「x/y 已启用」）> 全都在（写「N 种样式」）。
 * 收窄排最前，因为它是这次用户直接指出的问题：列表只有几行时要先解释「为什么只有几行」。
 */
export function styleScopeLabel(
  scope: StyleScope,
  partial: { active: number; total: number } | null,
  fmt: {
    scoped: (shown: number, total: number) => string;
    partial: (active: number, total: number) => string;
    count: (count: number) => string;
  },
): string {
  if (scope.narrowed) return fmt.scoped(scope.shown, scope.total);
  if (partial && partial.active > 0 && partial.active < partial.total) {
    return fmt.partial(partial.active, partial.total);
  }
  return fmt.count(scope.total);
}
