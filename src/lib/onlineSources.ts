import type { TKey } from "./i18n";
import type { OnlineFamily } from "./ipc";

/**
 * 在线库的「来源」维度（2026-11-10）
 *
 * 原来 meta 行末尾是一行写死的字符串
 * `"api.fontsource.org · raw.githubusercontent.com · cdn.jsdelivr.net"`，
 * 三个地址糊成一坨，用户既看不出哪个是目录、哪个是文件，也没法按地址检索。
 * 现在拆成三个可点击的独立项，并且**每个地址都能被筛选和搜索**。
 *
 * 三个地址的真实分工（见 `src-tauri/src/net.rs`）：
 * - `api.fontsource.org` —— **目录源**：`/v1/fonts` 返回族清单（族名/字重/许可/子集），
 *   以及单族的 METADATA.pb 与许可证原文。**不提供字体文件**。
 * - `raw.githubusercontent.com` —— **原始文件源**：`google/fonts` 仓库里的完整原始字体
 *   （一个文件含全部字符，含中文等大字符集）。国内网络经常直连不通。
 * - `cdn.jsdelivr.net` —— **分片镜像源**：同一批文件的 jsDelivr 镜像；
 *   另外 fontsource 的 npm 通道（`/fontsource/fonts/...`）也在这里，
 *   它按 unicode-range 把字体切成**分片**（latin / latin-ext / vietnamese …），
 *   每片只有几 KB —— 「按子集取件」只在这个源成立。
 *
 * 所以「按来源筛选」在族这一层是均匀的（目录里的族全是 google 型，三个源都覆盖），
 * **真正的区分度在分片上**：选镜像源时按 unicode-range 子集筛（vietnamese 只有 531 个族，
 * chinese-simplified 只有 10 个），这才是有意义的筛选维度。
 */

export type OnlineSourceId = "catalogue" | "raw" | "mirror";

export interface OnlineSource {
  id: OnlineSourceId;
  /** 主机名，显示在 chip 上 */
  host: string;
  /** 打开这个地址看内容 */
  url: string;
  /** 这个源提供什么（chip 的 hint 文案） */
  roleKey: TKey;
  /** 是否提供字体文件（目录源不提供） */
  providesFiles: boolean;
  /** 是否提供按 unicode-range 切好的分片 */
  providesSubsets: boolean;
}

export const ONLINE_SOURCES: OnlineSource[] = [
  {
    id: "catalogue",
    host: "api.fontsource.org",
    url: "https://api.fontsource.org/v1/fonts",
    roleKey: "online.sourceRole.catalogue",
    providesFiles: false,
    providesSubsets: false,
  },
  {
    id: "raw",
    host: "raw.githubusercontent.com",
    url: "https://github.com/google/fonts/tree/main",
    roleKey: "online.sourceRole.raw",
    providesFiles: true,
    providesSubsets: false,
  },
  {
    id: "mirror",
    host: "cdn.jsdelivr.net",
    url: "https://cdn.jsdelivr.net/gh/google/fonts@main/",
    roleKey: "online.sourceRole.mirror",
    providesFiles: true,
    providesSubsets: true,
  },
];

export function sourceById(id: string | null): OnlineSource | null {
  if (!id) return null;
  return ONLINE_SOURCES.find((s) => s.id === id) ?? null;
}

/** 某个族在这个源下「有没有东西可取」 */
export function sourceHasFamily(f: OnlineFamily, source: OnlineSource): boolean {
  switch (source.id) {
    case "catalogue":
      // 目录里列出来的族都有
      return true;
    case "raw":
    case "mirror":
      // 目录里的族全是 google 型，两个地址都收录同一批完整字体
      return f.weights.length > 0;
    default:
      return true;
  }
}

/** 这个族在某个源下能取到的分片（只有镜像源的 npm 通道按子集提供） */
export function familySubsets(f: OnlineFamily, source: OnlineSource | null): string[] {
  if (!source || !source.providesSubsets) return [];
  return f.subsets ?? [];
}

/** 各 unicode-range 子集分别覆盖多少个族（用于子集 chip 上的计数） */
export function subsetCounts(families: OnlineFamily[] | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of families ?? []) {
    for (const s of f.subsets ?? []) {
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * 搜索用的附带词。
 *
 * 用户搜「jsdelivr」「raw」「fontsource」时应该能命中对应来源的族，
 * 搜「vietnamese」时应该能命中所有含该子集的族 —— 也就是说，
 * **地址与分片都是可检索的文本**。
 */
export function familySearchTokens(f: OnlineFamily): string[] {
  const tokens: string[] = [f.family, f.id];
  for (const s of f.subsets ?? []) tokens.push(s);
  return tokens;
}

/** 一个搜索词是否命中这个族（含来源主机名） */
export function matchesQuery(f: OnlineFamily, query: string, sources: OnlineSource[]): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  // 先看族名 / id / 子集
  if (familySearchTokens(f).some((t) => t.toLowerCase().includes(q))) return true;
  // 再看主机名：搜 "jsdelivr" / "cdn" / "raw" / "github" / "fontsource" 都能命中
  for (const s of sources) {
    if (s.host.toLowerCase().includes(q)) return true;
  }
  return false;
}
