import { useMemo } from "react";
import { Camera, FolderOpen, Tag, Type } from "lucide-react";
import { familiesFor, useFontStore } from "../state/fontStore";
import { useT } from "../lib/i18n";

/**
 * 搜索时的下拉建议（用户 2026-11-10）。
 *
 * 「搜索结果里出现一个名字里没有关键词的字体」最容易让人以为搜错了 —— 所以每条建议
 * **必须带类型图标**：字体用 `Aa` 字形格、标签用 Tag、分组用文件夹、快照用相机。
 * 用户原话：「如果是标签要加入标签 icon，不要让用户有误解」，图标就画在这个下拉框里。
 *
 * 排序刻意把**标签 / 分组 / 快照排在字体前面**：字体动辄四千条，一搜一大片；
 * 标签和分组是用户自己建的三五个，命中往往就是他要找的那个。
 */

export type Suggestion = {
  kind: "family" | "tag" | "collection" | "snapshot";
  /** 唯一键：`kind:name` */
  key: string;
  label: string;
  /** 右侧灰色小字（条数 / 类型） */
  meta?: string;
};

const LIMIT_PER_KIND = { tag: 6, collection: 6, snapshot: 6, family: 6 } as const;

export function SearchSuggest({
  query,
  onPick,
}: {
  query: string;
  onPick: (s: Suggestion) => void;
}) {
  const t = useT();
  const fonts = useFontStore((s) => s.fonts);
  const tags = useFontStore((s) => s.tags);
  const collections = useFontStore((s) => s.collections);
  const snapshots = useFontStore((s) => s.snapshots);

  const q = query.trim().toLowerCase();

  const items = useMemo<Suggestion[]>(() => {
    if (!q) return [];
    const out: Suggestion[] = [];
    let n = 0;
    for (const [tag, members] of Object.entries(tags)) {
      if (n >= LIMIT_PER_KIND.tag) break;
      if (!tag.toLowerCase().includes(q)) continue;
      out.push({ kind: "tag", key: `tag:${tag}`, label: tag, meta: String(members.length) });
      n++;
    }
    n = 0;
    for (const name of Object.keys(collections)) {
      if (n >= LIMIT_PER_KIND.collection) break;
      if (!name.toLowerCase().includes(q)) continue;
      out.push({
        kind: "collection",
        key: `col:${name}`,
        label: name,
        meta: String((collections[name] ?? []).length),
      });
      n++;
    }
    n = 0;
    for (const snap of snapshots) {
      if (n >= LIMIT_PER_KIND.snapshot) break;
      if (!snap.name.toLowerCase().includes(q)) continue;
      out.push({ kind: "snapshot", key: `snap:${snap.name}`, label: snap.name, meta: String(snap.entries.length) });
      n++;
    }
    n = 0;
    // 字体最后：四千多个名字里 contains 一遍不贵（纯字符串比较），但只取前几条
    for (const name of familiesFor(fonts, tags).keys()) {
      if (n >= LIMIT_PER_KIND.family) break;
      if (!name.toLowerCase().includes(q)) continue;
      out.push({ kind: "family", key: `fam:${name}`, label: name });
      n++;
    }
    return out;
  }, [q, fonts, tags, collections, snapshots]);

  if (!q) return null;

  return (
    <ul className="suggest-list" role="listbox" aria-label={t("search.suggestAria")}>
      {items.length === 0 ? (
        <li className="suggest-empty">{t("search.noHits")}</li>
      ) : (
        items.map((it) => (
          <li key={it.key}>
            <button
              role="option"
              aria-selected={false}
              className="suggest-item"
              data-kind={it.kind}
              // 用 mousedown 而不是 click：输入框 blur 会先把面板关掉，click 就点不到了
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(it);
              }}
            >
              <span className="suggest-icon" aria-hidden="true">
                {it.kind === "family" ? (
                  <Type size={12} strokeWidth={1.6} />
                ) : it.kind === "tag" ? (
                  <Tag size={12} strokeWidth={1.6} />
                ) : it.kind === "collection" ? (
                  <FolderOpen size={12} strokeWidth={1.6} />
                ) : (
                  <Camera size={12} strokeWidth={1.6} />
                )}
              </span>
              <span className="suggest-label">{it.label}</span>
              <span className="suggest-kind">
                {it.meta ?? ""}
                {it.meta ? " · " : ""}
                {t(`search.kind.${it.kind}` as Parameters<typeof t>[0])}
              </span>
            </button>
          </li>
        ))
      )}
    </ul>
  );
}
