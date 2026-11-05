/**
 * 1.2.4 起，界面里的「导出文件 / 文件夹」不再借用通用线性图标，
 * 统一换成软件自己的一套黑白灰拼贴纸片图标（SVG 源同步放在 public/icons）。
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
