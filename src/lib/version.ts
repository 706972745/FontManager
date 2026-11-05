// 版本号直接取自 package.json：构建/打包升级版本只要改一处，
// 设置页与「关于」里显示的版本不会再和安装包版本对不上。
import pkg from "../../package.json";

export const APP_VERSION = pkg.version;
export const APP_LICENSE = "GPL-3.0";
/**
 * 发布通道标记。1.1.0 是第一个正式发布版（此前的 1.0.0-x 都是未发布的开发迭代版），
 * 所以起显示「正式版」；下一轮开发中的小修订发版前改回 null 即可不显示。
 * 「关于」页与设置页脚注共用，别再往别处硬编码版本串。
 *
 * 2026-11-05：1.3.0 是开发版（本地 API / 插件 / MCP 刚落地，还没对外发布），先置 null。
 */
export const APP_EDITION: "stable" | null = null;

/** 展示用版本串：正式版带通道标记（`1.1.0 正式版`），开发版只有版本号 */
export function displayVersion(t: (key: "about.edition") => string): string {
  return APP_EDITION ? `${APP_VERSION} ${t("about.edition")}` : APP_VERSION;
}
