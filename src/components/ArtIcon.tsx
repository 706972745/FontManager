/**
 * 1.2.4 起，界面里的「导出文件 / 文件夹」不再借用通用线性图标，
 * 统一换成软件自己的一套黑白灰拼贴纸片图标。
 *
 * 1.7.3 换用 `icons-final` 交付板（撕纸毛边 / 叠纸层次 / 手写首字母）那一版：
 * 新版是位图，没有 SVG 源，只有各档 PNG；这里取 64px 档（界面上最大用到 36px）。
 * 与 exe / 文件关联用的是同一套母版，见 `docs/icons/`。
 *
 * 用 import.meta.env.BASE_URL 而不是写死 "/icons/..."：Tauri 是 tauri://localhost，
 * 将来若改 Vite base（例如把页面挂到子路径）也不会把图标丢掉。
 */
const BASE = import.meta.env.BASE_URL;

export const ART_ICONS = {
  /** 快照导出文件（S） */
  snapshot: `${BASE}icons/icon-snapshot.png`,
  /** 导出字体：整包 .FontManager（P） */
  exportPack: `${BASE}icons/icon-export-pack.png`,
  /** 不导出字体：仅整理数据 json（L） */
  exportData: `${BASE}icons/icon-export-data.png`,
  /** 选择文件库地址 / 文件夹（F） */
  folder: `${BASE}icons/icon-folder.png`,
} as const;

export type ArtIconName = keyof typeof ART_ICONS;

export function ArtIcon({ name, size = 15 }: { name: ArtIconName; size?: number }) {
  return (
    <img
      className="art-icon"
      src={ART_ICONS[name]}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
