import type { FontFace } from "./ipc";

/**
 * 一个字重的「样式名」，用于显示（字重行 / 样张胶囊 / 字重菜单项）。
 *
 * 少数字体本身没写 style（或写成了空格），整行就只剩一个空白按钮 —— 退回 PostScript 名，
 * 再退回 "Regular"。这套退回链原来在**三处**各写一遍，口径还不一致：
 *   · `FaceLine` 的字重名：`face.style?.trim() || …`（带 trim）
 *   · 样张的样式胶囊：`previewFace?.style || …`（不带 trim）
 *   · 样张的样式菜单项：`face.style || …`（不带 trim，2026-11-12 QA 抓到的第三种）
 * 差别在「style 是纯空格」时才显形：带 trim 的退回 PostScript 名、不带 trim 的显示一行空白，
 * 于是同一个字面在按钮和菜单里能长得不一样。2026-11-12 全部收到这里，一处一份。
 */
export function faceStyleLabel(face: FontFace): string {
  return face.style?.trim() || face.postscriptName || "Regular";
}

/**
 * 一个字重的**字体全名**：`族名 + 空格 + 样式`，写进剪贴板的就是这一串。
 *
 * 为什么单独抽出来：右键菜单的「复制名字」（`menus.tsx`）和字重名点击复制要用
 * **完全同一份**拼法 —— 用户从两条路走一遍，粘出来的东西必须一模一样，否则
 * 「点了名字复制的却是另一个东西」这种 bug 极难被发现（2026-11-12）。
 *
 * 退回链：族名 + 样式都为空 → PostScript 名 → 文件名 → "—"（菜单标题总得有个东西）。
 * 注意用的是 `family.name`（数据主键）而不是界面语言显示名：剪贴板里的名字要能
 * 直接贴到 PS / AI 里用，跟界面语言无关。
 */
export function faceFullName(familyName: string, face: FontFace): string {
  return (
    `${familyName} ${face.style ?? ""}`.trim() ||
    face.postscriptName ||
    faceFileName(face.path) ||
    "—"
  );
}

/** 从路径里取文件名（全名退回链的最后一档，跨平台都要认正反斜杠） */
function faceFileName(path: string): string {
  return (path ?? "").split(/[\\/]/).pop() ?? "";
}
