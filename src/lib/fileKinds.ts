/**
 * 1.2.4 导出文件的「自描述」协议。
 *
 * 三种导出物各有专属后缀，但**导入端一律不靠后缀判断**：每个文件内部都写清
 * `kind / suffix / label / purpose / howTo`，即使把后缀改掉、改成 .json、
 * 甚至改成完全没见过的名字，只要内容还在就能认出来并正确导入。
 *
 * 这也是双击关联能成立的前提 —— 资源管理器只负责把路径递给 FontManager，
 * 具体该按快照、整理数据还是整包处理，由文件内容说了算。
 */

export const APP_NAME = "FontManager";

/** 与历史文件格式保持一致的 kind 值，别改字符串，老文件还要认 */
export type ExportKind = "snapshots" | "curation" | "library-pack";

export interface ExportSpec {
  kind: ExportKind;
  /** 推荐后缀（写进文件里，供人和程序对照） */
  suffix: string;
  /** 文件对话框用的扩展名，不带点 */
  extension: string;
  label: string;
  /** 这个文件是干什么的 —— 原样写进导出文件 */
  purpose: string;
  /** 怎么把它导回去 —— 原样写进导出文件 */
  howTo: string;
}

export const EXPORT_SPECS: Record<ExportKind, ExportSpec> = {
  snapshots: {
    kind: "snapshots",
    suffix: ".S-FontManager",
    extension: "S-FontManager",
    label: "字体快照",
    purpose:
      "记录某一时刻启用/收藏的字体清单（只记字体身份，不含字体文件本体），用于在这台或另一台电脑一键恢复、批量套用这批字体。",
    howTo:
      "在 FontManager 侧栏「快照」区选择导入，或直接双击本文件；导入后会出现在快照列表里，不会覆盖已有快照。",
  },
  curation: {
    kind: "curation",
    suffix: ".L-FontManager",
    extension: "L-FontManager",
    label: "字体整理数据",
    purpose:
      "保存标签、分组、收藏与 1~5 星评分、备注、手动版权判定和版权到期日。只包含整理成果，不含字体文件本体，体积很小。",
    howTo:
      "在 FontManager 设置 →「字体库数据」点「导入」，或直接双击本文件；按「只增不减、本地优先补空缺」合并，不会抹掉本机已有成果。",
  },
  "library-pack": {
    kind: "library-pack",
    suffix: ".P-FontManager",
    extension: "P-FontManager",
    label: "字体库整包",
    purpose:
      "把字体文件本体和上面那份整理数据打成一个 zip 包，用于整台机器搬家；单卷超过 2 GiB 会自动按文件边界分卷，每卷都是独立可用的 zip。",
    howTo:
      "在 FontManager 设置 →「字体库数据」点「导入」，或直接双击本文件；多卷时打开任意一卷即可，程序会自动找同目录的兄弟卷。",
  },
};

/** 写进每个导出文件的自描述字段。zip 包里另有一份 README，见 library_pack.rs。 */
export function fileDescription(kind: ExportKind) {
  const s = EXPORT_SPECS[kind];
  return {
    app: APP_NAME,
    kind: s.kind,
    suffix: s.suffix,
    label: s.label,
    purpose: s.purpose,
    howTo: s.howTo,
  };
}

/** 三种后缀都归我们管（大小写不敏感）。仅用于文件对话框过滤，不用于导入判定。 */
export const OUR_EXTENSIONS = [
  EXPORT_SPECS.curation.extension,
  EXPORT_SPECS.snapshots.extension,
  EXPORT_SPECS["library-pack"].extension,
];

export const isOurSuffix = (path: string) =>
  /\.(s|p|l)-fontmanager$/i.test(path.trim());

/**
 * 只凭 JSON 内容判断导出物类型，一个字都不看文件名。
 * 老版本没有 `kind` 字段、或者 `app` 写着别的名字，也照样按结构认出来。
 */
export function detectJsonKind(raw: unknown): ExportKind | "unknown" {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "unknown";
  const d = raw as Record<string, unknown>;
  switch (d.kind) {
    case "snapshots":
    case "curation":
    case "library-pack":
      return d.kind;
  }
  // 结构兜底：老备份 / 被改过 kind 的文件
  if (d.snapshots && typeof d.snapshots === "object") return "snapshots";
  if (Array.isArray(d.favorites)) return "curation";
  for (const key of ["tags", "collections", "collectionFaces", "notes", "ratings"]) {
    if (d[key] && typeof d[key] === "object") return "curation";
  }
  return "unknown";
}
