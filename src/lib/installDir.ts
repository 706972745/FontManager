/**
 * 安装目录的归一化（用户 2026-11-14）。
 *
 * 安装界面的「浏览…」让用户挑一个目录，但安装目录必须是 `<所选目录>\FontManager` ——
 * 用户点「桌面\新建文件夹」时想要的是「装到那儿」，不是「把那堆文件直接摊在桌面上」，
 * 也不是「在桌面根目录建 FontManager」。所以：
 *   · 选到的目录本身就叫 FontManager（大小写不敏感）→ 原样用，不再套一层；
 *   · 其它情况一律在后面接 `\FontManager`（目录不存在没关系，NSIS 装的时候会建）。
 *
 * 只用一次的地方也要抽出来：这条规则以后还会被「换盘迁移」「卸载时推断目录」用到，
 * 散在事件回调里就再也测不到边界了（盘符根、UNC、尾部斜杠）。
 */

const SEP = /[\\/]/;

export function normalizeInstallDir(picked: string): string {
  const raw = picked.trim();
  if (!raw) return raw;

  // 去掉尾部斜杠；盘符根 `E:\` 去掉后是 `E:`，下面单独补
  const stripped = raw.replace(/[\\/]+$/, "");
  if (!stripped) return raw; // 只剩分隔符（"\\" / "/"）这种脏输入，原样退回

  const base = stripped.split(SEP).pop() ?? "";
  if (base.toLowerCase() === "fontmanager") return stripped;

  // 只有 `E:` 这种盘符根没有反斜杠，但它仍然是 Windows 路径 —— 分隔符按盘符判，
  // 不能只看 `raw.includes("\\")`（否则 `E:` 会拼成 `E:/FontManager`）
  const sep = raw.includes("\\") || /^[A-Za-z]:/.test(stripped) ? "\\" : "/";
  // 盘符根：`E:` → `E:\FontManager`
  if (/^[A-Za-z]:$/.test(stripped)) return `${stripped}${sep}FontManager`;
  return `${stripped}${sep}FontManager`;
}
