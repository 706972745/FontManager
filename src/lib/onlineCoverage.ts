import type { FontFace } from "./ipc";

/**
 * 字库对在线字族的收录情况
 * - none：字库里没有这个字族
 * - partial：有，但缺字重（样式）或缺版权文件
 * - complete：样式齐全且带版权文件
 */
export type CoverageState = "none" | "partial" | "complete";

/** 在线字族期望存在的一个样式（字重 + 是否斜体） */
export interface ExpectedFace {
  style: string;
  weight: number;
  postScriptName?: string;
}

export interface FamilyCoverage {
  state: CoverageState;
  /** 字库已满足的样式数 */
  covered: number;
  /** 在线字族应有的样式数（0 = 无法判断，按不完整处理） */
  expected: number;
  /** 字库中该字族的字面数 */
  present: number;
  /** 字族目录里是否带版权信息文件（许可证/版权说明等） */
  hasLicense: boolean;
  /** 缺失的样式数 */
  missing: number;
  /** 是否存在可删除（非系统来源）的字面 */
  removable: boolean;
}

const ITALIC_RE = /italic|oblique|斜体/i;

export function isItalicStyle(style: string): boolean {
  return ITALIC_RE.test(style ?? "");
}

/** 字面是否覆盖某个字重：静态字面按值相等，可变字体按 wght 轴范围 */
function coversWeight(face: FontFace, weight: number): boolean {
  if (face.weight === weight) return true;
  if (!face.isVariable) return false;
  const axis = face.axes?.find((a) => a.tag?.toLowerCase() === "wght");
  if (!axis) return true;
  return weight >= axis.min && weight <= axis.max;
}

function satisfies(face: FontFace, exp: ExpectedFace): boolean {
  const wanted = exp.postScriptName?.trim();
  if (wanted && face.postscriptName && face.postscriptName.toLowerCase() === wanted.toLowerCase()) {
    return true;
  }
  if (face.italic !== isItalicStyle(exp.style)) return false;
  return coversWeight(face, exp.weight);
}

/** 由在线详情里的文件列表生成期望样式集合（按 斜体+字重 去重） */
export function expectationFromFiles(
  files: { style: string; weight: number; postScriptName?: string | null }[],
): ExpectedFace[] {
  const seen = new Set<string>();
  const out: ExpectedFace[] = [];
  for (const f of files) {
    const italic = isItalicStyle(f.style);
    const weight = Number.isFinite(f.weight) && f.weight > 0 ? Math.round(f.weight) : 400;
    const key = `${italic ? "i" : "n"}:${weight}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ style: f.style, weight, postScriptName: f.postScriptName ?? undefined });
  }
  return out;
}

/**
 * 由目录里的 weights / styles 生成期望样式集合。
 * 静态字族按 字重 × 样式 做笛卡尔积；可变字族每个样式只需一个文件（可变字体覆盖全部字重），
 * 避免目录信息较粗时把"其实已完整"的字族误判为缺字重。
 */
export function expectationFromCatalogue(
  weights: number[],
  styles: string[],
  opts: { variable?: boolean } = {},
): ExpectedFace[] {
  const ws = [...new Set(weights.filter((w) => Number.isFinite(w) && w > 0).map((w) => Math.round(w)))].sort(
    (a, b) => a - b,
  );
  const ss = [...new Set(styles.map((s) => (s ?? "").trim().toLowerCase()).filter(Boolean))];
  const norm = ss.length > 0 ? ss : ["normal"];
  const out: ExpectedFace[] = [];
  if (opts.variable) {
    for (const style of norm) out.push({ style, weight: 400 });
    return out;
  }
  for (const style of norm) {
    for (const weight of ws) out.push({ style, weight });
  }
  return out;
}

export function familyCoverage(
  faces: FontFace[],
  expected: ExpectedFace[],
  hasLicense: boolean,
): FamilyCoverage {
  const present = faces.length;
  const removable = faces.some((f) => f.source !== "system");
  if (present === 0) {
    return {
      state: "none",
      covered: 0,
      expected: expected.length,
      present,
      hasLicense: false,
      missing: expected.length,
      removable: false,
    };
  }
  if (expected.length === 0) {
    // 在线信息不足，无法判断是否完整 → 允许补全/重下
    return {
      state: "partial",
      covered: 0,
      expected: 0,
      present,
      hasLicense,
      missing: 0,
      removable,
    };
  }
  let covered = 0;
  for (const exp of expected) {
    if (faces.some((f) => satisfies(f, exp))) covered++;
  }
  const missing = expected.length - covered;
  return {
    state: missing === 0 && hasLicense ? "complete" : "partial",
    covered,
    expected: expected.length,
    present,
    hasLicense,
    missing,
    removable,
  };
}

/** 取路径的父目录（同时兼容 / 与 \） */
export function parentDir(path: string): string {
  if (!path) return "";
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : "";
}
