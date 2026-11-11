import { useEffect, useMemo } from "react";
import { Camera, FolderOpen, Puzzle, Tag, Type } from "lucide-react";
import { allTags, familiesFor, useFontStore } from "../state/fontStore";
import { isEnabledNow } from "../lib/familyState";
import { activeLocale, useT } from "../lib/i18n";
import { displayFamilyName, familyNameVariants } from "../lib/fontNames";
import { usePluginStore } from "../lib/pluginStore";
import { openPluginMenu } from "../lib/pluginMenu";
import type { PluginInfo } from "../lib/ipc";

/**
 * 搜索时的下拉建议（用户 2026-11-10）。
 *
 * 「搜索结果里出现一个名字里没有关键词的字体」最容易让人以为搜错了 —— 所以每条建议
 * **必须带类型图标**：字体用 `Aa` 字形格、标签用 Tag、分组用文件夹、快照用相机、
 * 插件用拼图。用户原话：「如果是标签要加入标签 icon，不要让用户有误解」。
 *
 * 1.8.1 起多了**插件**这一类（用户要求：搜字体的时候也能搜到装过的插件）：
 * 命中范围是插件的名字、id、一句话介绍和完整介绍；左键打开它的设置面板，
 * 右键给的是和设置页同一套菜单（插件自己声明的项 + 打开插件目录）。
 *
 * 排序刻意把**插件 / 标签 / 分组 / 快照排在字体前面**：字体动辄四千条，一搜一大片；
 * 插件和标签是十来个，命中往往就是他要找的那个。
 */

export type Suggestion = {
  kind: "family" | "tag" | "collection" | "snapshot" | "plugin";
  /** 唯一键：`kind:name` */
  key: string;
  label: string;
  /** 右侧灰色小字（条数 / 类型） */
  meta?: string;
  /** kind = plugin 时带上完整信息，父组件据此决定点下去干什么 */
  plugin?: PluginInfo;
};

const LIMIT_PER_KIND = { plugin: 6, tag: 6, collection: 6, snapshot: 6, family: 6 } as const;

export function SearchSuggest({
  query,
  onPick,
  onlyActive = false,
}: {
  query: string;
  onPick: (s: Suggestion) => void;
  /**
   * 「只搜已启用的字体」（速览界面）。
   *
   * 速览列表本来就只列已启用字体，但建议下拉走的是全量 `familiesFor()` ——
   * 于是搜 `Arial` 会弹出一条建议，点下去把关键词填进搜索框、列表却是空的
   * （用户 2026-11-11：「速览的搜索框只能搜到已启用的字体，未启用的搜不到才对」）。
   * 打开这个开关后字体类建议也按同一个口径筛；完整界面的搜索不传，行为不变。
   * 标签 / 分组 / 快照不动 —— 它们不是字体，点下去是「用这个条件过滤当前列表」。
   */
  onlyActive?: boolean;
}) {
  const t = useT();
  // useT() 已经订阅了语言变更；这里再取一次当前语言，给显示名与索引用
  const locale = activeLocale();
  const fonts = useFontStore((s) => s.fonts);
  const tags = useFontStore((s) => s.tags);
  const collections = useFontStore((s) => s.collections);
  const snapshots = useFontStore((s) => s.snapshots);
  const sessionActivated = useFontStore((s) => s.sessionActivated);
  const plugins = usePluginStore((s) => s.plugins);
  const loadPlugins = usePluginStore((s) => s.load);
  // 兜底：主界面启动那次 `plugins_list` 若失败，用户一打字这里还会再试一次
  // （`load()` 在已加载时是空操作，不会每次按键都发 IPC）
  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  const q = query.trim().toLowerCase();
  /**
   * `tags` 在 store 里是 **字族名 → 标签数组**（`Record<family, string[]>`），
   * 不是「标签 → 成员」。所以这里必须走 `allTags()` 转成「标签 → 有多少个族」，
   * 直接 `Object.entries(tags)` 拿到的是族名，会把字体名当成标签列出来
   * （1.8.0 内测第一版就是这么错的，用户截图里标签一条都不出现）。
   */
  const tagIndex = useMemo(() => allTags(tags), [tags]);
  /**
   * 字体类建议的索引（用户 2026-11-11：「这个字体在软件中的名称也要支持能搜索到
   * —— 中文、拉丁文还是其他语言都应该可以搜到」）。
   *
   * 以前这里只有族名（`familyLowerNames`），可列表显示的是**本地化名**：
   * `Microsoft YaHei` 在名称列写着「微软雅黑」，搜「微软雅黑」却一条建议都不出。
   * 现在每个族索引**它所有的名字**（族名 + 每个字面的每种语言名，`familyNameVariants`），
   * 建议项显示的是 `displayFamilyName`（和列表那一列完全一致），不至于点进去对不上。
   *
   * 索引跟字体库缓存（deps 不含 q），打字时只做 includes。
   */
  const familyIndex = useMemo(() => {
    const locale = activeLocale();
    const out: { name: string; label: string; variants: string[] }[] = [];
    for (const family of familiesFor(fonts, tags).values()) {
      if (onlyActive && !isEnabledNow(family, sessionActivated)) continue;
      const names = familyNameVariants(family);
      if (names.length === 0) continue;
      out.push({
        name: family.name,
        label: displayFamilyName(family, locale),
        variants: names.map((v) => v.toLowerCase()),
      });
    }
    return out;
  }, [fonts, tags, onlyActive, sessionActivated, locale]);

  const items = useMemo<Suggestion[]>(() => {
    if (!q) return [];
    const out: Suggestion[] = [];
    let n = 0;
    // 插件排最前：数量最少（个位数），命中就是用户想找的那一个
    for (const p of plugins) {
      if (n >= LIMIT_PER_KIND.plugin) break;
      const hay = `${p.name}\n${p.id}\n${p.summary ?? ""}\n${p.description ?? ""}`.toLowerCase();
      if (!hay.includes(q)) continue;
      out.push({
        kind: "plugin",
        key: `plugin:${p.id}`,
        label: p.name,
        meta: `v${p.version}`,
        plugin: p,
      });
      n++;
    }
    n = 0;
    for (const [tag, count] of tagIndex) {
      if (n >= LIMIT_PER_KIND.tag) break;
      if (!tag.toLowerCase().includes(q)) continue;
      out.push({ kind: "tag", key: `tag:${tag}`, label: tag, meta: String(count) });
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
    // 字体最后：任一语言名命中都算，只取前几条。
    // 排序：显示名以关键词开头的 > 其他名字以关键词开头的 > 只是包含的。
    // 搜「方正」时，名称为「方正榜书行简体」的族应该排在「A-OTF …（内部名含方正）」前面。
    const rank = (f: { label: string; variants: string[] }) =>
      f.label.toLowerCase().startsWith(q) ? 0 : f.variants.some((v) => v.startsWith(q)) ? 1 : 2;
    const familyHits = familyIndex.filter((f) => f.variants.some((v) => v.includes(q)));
    familyHits.sort((a, b) => rank(a) - rank(b));
    for (const f of familyHits) {
      if (n >= LIMIT_PER_KIND.family) break;
      out.push({ kind: "family", key: `fam:${f.name}`, label: f.label });
      n++;
    }
    return out;
  }, [q, plugins, familyIndex, tagIndex, collections, snapshots]);

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
                // 右键也会触发 mousedown：不挡住的话「右键插件 → 弹出菜单」会连带
                // 先把插件的设置面板打开（1.8.1 自测发现）
                if (e.button !== 0) return;
                e.preventDefault();
                onPick(it);
              }}
              // 插件项右键 = 设置页插件行那一套菜单（1.8.1）
              onContextMenu={
                it.plugin ? (e) => openPluginMenu(e, it.plugin!, "search") : undefined
              }
            >
              <span className="suggest-icon" aria-hidden="true">
                {it.kind === "family" ? (
                  <Type size={12} strokeWidth={1.6} />
                ) : it.kind === "tag" ? (
                  <Tag size={12} strokeWidth={1.6} />
                ) : it.kind === "collection" ? (
                  <FolderOpen size={12} strokeWidth={1.6} />
                ) : it.kind === "plugin" ? (
                  <Puzzle size={12} strokeWidth={1.6} />
                ) : (
                  <Camera size={12} strokeWidth={1.6} />
                )}
              </span>
              <span className="suggest-label">{it.label}</span>
              <span className="suggest-kind">
                {it.meta ?? ""}
                {it.meta ? " · " : ""}
                {it.plugin
                  ? t("search.kind.plugin")
                  : t(`search.kind.${it.kind}` as Parameters<typeof t>[0])}
              </span>
            </button>
          </li>
        ))
      )}
    </ul>
  );
}
