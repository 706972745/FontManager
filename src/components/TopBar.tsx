import { AnimatePresence, motion } from "motion/react";
import {
  ArrowUpDown,
  Check,
  ChevronRight,
  Columns2,
  Filter,
  FolderOpen,
  LayoutGrid,
  List,
  RefreshCw,
  Columns3,
  Search,
  Star,
  Type,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { springSnappy, springSoft } from "../design/springs";
import { INTRO_OFF, useIntro } from "../lib/useIntro";
import { usePopoverMenu } from "../lib/usePopoverMenu";
import { familiesFor, MIN_PREVIEW_SIZE_INDEX, SIZES, allTags, useFontStore, type SortMode } from "../state/fontStore";
import { useFontCss } from "../lib/fontLoader";
import type { Classification, FontFormat } from "../lib/ipc";
import { useT, type TKey } from "../lib/i18n";

const NAV_KEYS = ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"];

/**
 * 浮层内部的 listbox / tablist 方向键导航。
 *
 * 全局「上下方向键换选中字族」是挂在 window 上的，会把浮层里的方向键抢走——
 * 结果是排序菜单、筛选菜单只能用鼠标点，键盘用户按方向键反而在动背后的列表（§5 第 30 条）。
 * 所以浮层自己先 preventDefault + stopPropagation，再在内部移动焦点。
 */
function listboxKeys(e: ReactKeyboardEvent<HTMLElement>) {
  if (!NAV_KEYS.includes(e.key)) return;
  const items = [
    ...e.currentTarget.querySelectorAll<HTMLElement>("[role='option'], [role='tab']"),
  ].filter((el) => el.offsetParent !== null);
  if (items.length === 0) return;
  e.preventDefault();
  e.stopPropagation();
  const cur = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? items.length - 1
        : e.key === "ArrowDown" || e.key === "ArrowRight"
          ? (cur + 1 + items.length) % items.length
          : (cur - 1 + items.length) % items.length;
  items[next]?.focus();
}

const SORT_MODES = ["name", "styles", "size", "glyphs", "added", "activated"] as const satisfies readonly SortMode[];

const SORT_KEYS: Record<SortMode, TKey> = {
  name: "sort.name",
  styles: "sort.styles",
  size: "sort.size",
  glyphs: "sort.glyphs",
  added: "sort.added",
  activated: "sort.activated",
};

const FORMAT_FILTERS = ["otf", "ttf", "woff", "woff2"] as const;

const FEATURE_FILTERS = ["swsh", "salt", "dlig", "smcp", "onum", "frac"] as const;
const SOURCE_FILTERS = ["all", "system", "user"] as const;

const COPYRIGHT_FILTERS = ["free_commercial", "free_personal", "paid", "timelimited", "unknown"] as const;

export function SortMenu() {
  const t = useT();
  const sort = useFontStore((s) => s.sort);
  const setSort = useFontStore((s) => s.setSort);
  // 开关不再用组件内 useState：打开期间必须让全局快捷键整体让路（0.9.8 BUG-B）
  const { open, toggle, close, triggerRef, listRef } = usePopoverMenu("sort-menu");

  return (
    <div className="sort-wrap">
      <motion.button
        data-hint="hint.sort"
        ref={triggerRef}
        className={`sort-btn ${open ? "sort-open" : ""}`}
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        whileTap={{ scale: 0.96 }}
      >
        <ArrowUpDown size={13} strokeWidth={1.5} />
        <span>{t(SORT_KEYS[sort])}</span>
      </motion.button>
      <AnimatePresence>
        {open && (
          <>
            <div className="menu-backdrop" onClick={close} />
            <motion.ul
              ref={listRef}
              className="sort-menu glass-e3"
              role="listbox"
              onKeyDown={listboxKeys}
              initial={{ opacity: 0, y: -6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.13 } }}
              transition={springSnappy}
            >
              {SORT_MODES.map((mode) => (
                <li key={mode}>
                  <button
                    role="option"
                    aria-selected={sort === mode}
                    className={sort === mode ? "sort-item sort-active" : "sort-item"}
                    onClick={() => {
                      setSort(mode);
                      close();
                    }}
                  >
                    <span>{t(SORT_KEYS[mode])}</span>
                    {sort === mode && <Check size={13} strokeWidth={2} />}
                  </button>
                </li>
              ))}
            </motion.ul>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

const CLASS_FILTERS = [
  "serif",
  "sans",
  "mono",
  "display",
  "script",
] as const satisfies readonly Classification[];

const SCRIPT_FILTERS = [
  "latin",
  "cyrillic",
  "greek",
  "arabic",
  "hebrew",
  "devanagari",
  "thai",
  // 0.9.3-7 起「中文」和「日文」分开筛：原来合成一个 cjk，导致纯中文字体
  // 因为没有假名而永远筛不出来
  "han",
  "kana",
  "korean",
  "vietnamese",
] as const;

/**
 * 顶栏「筛选」菜单。完整界面和速览界面共用。
 *
 * `membership`：速览界面传 true，多出一段「范围」—— 收藏 / 分组 / 快照。
 * 完整界面不需要（那边走侧栏导航），所以默认不渲染，行为零变化。
 */
/**
 * 筛选菜单里的「二级菜单」入口（标签 / 分组 / 快照）。
 * 右侧显示已选条数与箭头；点一下或悬停都会展开对应的子面板。
 */
function FilterSubTrigger({
  label,
  count,
  active,
  onClick,
  onHover,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: (el: HTMLElement) => void;
  onHover: (el: HTMLElement) => void;
}) {
  return (
    <button
      className={`sort-item filter-sub-trigger ${active ? "filter-sub-open" : ""}`}
      aria-haspopup="menu"
      aria-expanded={active}
      onClick={(e) => onClick(e.currentTarget)}
      onMouseEnter={(e) => onHover(e.currentTarget)}
    >
      <span>{label}</span>
      <span className="filter-sub-meta">
        {count > 0 && <span className="filter-count tabular">{count}</span>}
        <ChevronRight size={12} strokeWidth={1.6} />
      </span>
    </button>
  );
}

export function FilterMenu({ membership = false }: { membership?: boolean } = {}) {
  const t = useT();
  const classFilter = useFontStore((s) => s.classFilter);
  const toggleClassFilter = useFontStore((s) => s.toggleClassFilter);
  const scriptFilter = useFontStore((s) => s.scriptFilter);
  const toggleScriptFilter = useFontStore((s) => s.toggleScriptFilter);
  const variableOnly = useFontStore((s) => s.variableOnly);
  const setVariableOnly = useFontStore((s) => s.setVariableOnly);
  const toggleableOnly = useFontStore((s) => s.toggleableOnly);
  const setToggleableOnly = useFontStore((s) => s.setToggleableOnly);
  const incompleteOnly = useFontStore((s) => s.incompleteOnly);
  const setIncompleteOnly = useFontStore((s) => s.setIncompleteOnly);
  const formatFilter = useFontStore((s) => s.formatFilter);
  const toggleFormat = useFontStore((s) => s.toggleFormat);
  const featureFilter = useFontStore((s) => s.featureFilter);
  const toggleFeature = useFontStore((s) => s.toggleFeature);
  const sourceFilter = useFontStore((s) => s.sourceFilter);
  const setSourceFilter = useFontStore((s) => s.setSourceFilter);
  const licenseFilter = useFontStore((s) => s.licenseFilter);
  const toggleLicenseFilter = useFontStore((s) => s.toggleLicenseFilter);
  const charFilter = useFontStore((s) => s.charFilter);
  const charSearching = useFontStore((s) => s.charSearching);
  const setCharFilter = useFontStore((s) => s.setCharFilter);
  const favoriteOnly = useFontStore((s) => s.favoriteOnly);
  const setFavoriteOnly = useFontStore((s) => s.setFavoriteOnly);
  const ratingFilter = useFontStore((s) => s.ratingFilter);
  const setRatingFilter = useFontStore((s) => s.setRatingFilter);
  const collectionFilter = useFontStore((s) => s.collectionFilter);
  const toggleCollectionFilter = useFontStore((s) => s.toggleCollectionFilter);
  const snapshotFilter = useFontStore((s) => s.snapshotFilter);
  const toggleSnapshotFilter = useFontStore((s) => s.toggleSnapshotFilter);
  const tagFilter = useFontStore((s) => s.tagFilter);
  const toggleTagFilter = useFontStore((s) => s.toggleTagFilter);
  const tags = useFontStore((s) => s.tags);
  const collections = useFontStore((s) => s.collections);
  const snapshots = useFontStore((s) => s.snapshots);
  const { open, toggle, close, triggerRef, listRef } = usePopoverMenu("filter-menu");

  /**
   * 「范围」二级菜单（标签 / 分组 / 快照，用户 2026-11-10）。
   *
   * 不能做成菜单里的绝对定位子面板：`.filter-menu` 自己有 `overflow-y: auto`
   * （内容超过 480px 要滚），任何超出菜单盒子的子元素都会被裁掉。
   * 所以子菜单用 `position: fixed` 渲染在菜单外面，位置取被点那一项的 rect；
   * 靠 `transform: translateX(-100%)` 整体向左弹出 —— 完整界面与速览的窗口都不宽，
   * 往右弹会直接出界。菜单关闭 / 菜单内滚动时收起子菜单，否则位置会飘。
   */
  const [sub, setSub] = useState<{
    kind: "tag" | "collection" | "snapshot";
    top: number;
    left: number;
  } | null>(null);
  const openSub = (kind: "tag" | "collection" | "snapshot", el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setSub({ kind, top: r.top, left: r.left });
  };
  const tagCounts = useMemo(() => allTags(tags), [tags]);
  const collectionNames = useMemo(() => Object.keys(collections).sort(), [collections]);
  useEffect(() => {
    if (!open) setSub(null);
  }, [open]);

  const activeCount =
    classFilter.length +
    scriptFilter.length +
    formatFilter.length +
    featureFilter.length +
    licenseFilter.length +
    (sourceFilter !== "all" ? 1 : 0) +
    (charFilter ? 1 : 0) +
    (variableOnly ? 1 : 0) +
    (toggleableOnly ? 1 : 0) +
    (incompleteOnly ? 1 : 0) +
    (ratingFilter > 0 ? 1 : 0) +
    tagFilter.length +
    collectionFilter.length +
    snapshotFilter.length +
    (membership && favoriteOnly ? 1 : 0);

  return (
    <div className="sort-wrap">
      <motion.button
        data-hint="hint.filter"
        ref={triggerRef}
        data-tour="filters"
        className={`sort-btn ${open ? "sort-open" : ""} ${activeCount > 0 ? "filter-live" : ""}`}
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("filter.aria")}
        whileTap={{ scale: 0.96 }}
      >
        <Filter size={13} strokeWidth={1.5} />
        {activeCount > 0 && <span className="filter-count tabular">{activeCount}</span>}
      </motion.button>
      <AnimatePresence>
        {open && (
          <>
            <div className="menu-backdrop" onClick={close} />
            <motion.ul
              ref={listRef}
              className="sort-menu filter-menu glass-e3"
              role="listbox"
              aria-multiselectable
              onKeyDown={listboxKeys}
              initial={{ opacity: 0, y: -6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.13 } }}
              transition={springSnappy}
            >
              {(membership || tagCounts.size > 0 || collectionNames.length > 0 || snapshots.length > 0) && (
                <li className="filter-heading" role="none">
                  {t("filter.scope")}
                </li>
              )}
              {membership && (
                <li>
                  <button
                    role="option"
                    aria-selected={favoriteOnly}
                    className={favoriteOnly ? "sort-item sort-active" : "sort-item"}
                    onClick={() => setFavoriteOnly(!favoriteOnly)}
                  >
                    <span>{t("side.favorites")}</span>
                    {favoriteOnly && <Check size={13} strokeWidth={2} />}
                  </button>
                </li>
              )}
              {tagCounts.size > 0 && (
                <li>
                  <FilterSubTrigger
                    label={t("side.tags")}
                    count={tagFilter.length}
                    active={sub?.kind === "tag"}
                    onClick={(el) => openSub("tag", el)}
                    onHover={(el) => openSub("tag", el)}
                  />
                </li>
              )}
              {collectionNames.length > 0 && (
                <li>
                  <FilterSubTrigger
                    label={t("side.collections")}
                    count={collectionFilter.length}
                    active={sub?.kind === "collection"}
                    onClick={(el) => openSub("collection", el)}
                    onHover={(el) => openSub("collection", el)}
                  />
                </li>
              )}
              {snapshots.length > 0 && (
                <li>
                  <FilterSubTrigger
                    label={t("side.snapshots")}
                    count={snapshotFilter.length}
                    active={sub?.kind === "snapshot"}
                    onClick={(el) => openSub("snapshot", el)}
                    onHover={(el) => openSub("snapshot", el)}
                  />
                </li>
              )}
              <li className="sort-sep" role="none" />
              <li className="filter-heading" role="none">
                {t("filter.rating")}
              </li>
              <li className="filter-ratingrow" role="none">
                <button
                  className={`rating-any ${ratingFilter === 0 ? "rating-any-on" : ""}`}
                  onClick={() => setRatingFilter(0)}
                >
                  {t("filter.ratingAll")}
                </button>
                <div className="rating-picks" role="group" aria-label={t("filter.rating")}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      role="option"
                      aria-selected={ratingFilter === n}
                      className={`rating-pick ${n <= ratingFilter ? "rating-pick-on" : ""}`}
                      aria-label={t("filter.ratingAtLeast", { count: n })}
                      data-hint-text={t("filter.ratingAtLeast", { count: n })}
                      onClick={() => setRatingFilter(ratingFilter === n ? 0 : n)}
                    >
                      <Star size={13} strokeWidth={1.5} />
                    </button>
                  ))}
                </div>
              </li>
              <li className="sort-sep" role="none" />
              <li className="filter-heading" role="none">
                {t("filter.show")}
              </li>
              {SOURCE_FILTERS.map((src) => (
                <li key={src}>
                  <button
                    role="option"
                    aria-selected={sourceFilter === src}
                    className={sourceFilter === src ? "sort-item sort-active" : "sort-item"}
                    onClick={() => setSourceFilter(src)}
                  >
                    <span>{t(`source.${src}`)}</span>
                    {sourceFilter === src && <Check size={13} strokeWidth={2} />}
                  </button>
                </li>
              ))}
              <li className="sort-sep" role="none" />
              <li className="filter-heading" role="none">
                {t("filter.classification")}
              </li>
              {CLASS_FILTERS.map((c) => (
                <li key={c}>
                  <button
                    role="option"
                    aria-selected={classFilter.includes(c)}
                    className={classFilter.includes(c) ? "sort-item sort-active" : "sort-item"}
                    onClick={() => toggleClassFilter(c)}
                  >
                    <span>{t(`class.${c}`)}</span>
                    {classFilter.includes(c) && <Check size={13} strokeWidth={2} />}
                  </button>
                </li>
              ))}
              <li className="sort-sep" role="none" />
              <li className="filter-heading" role="none">
                {t("filter.copyright")}
              </li>
              {COPYRIGHT_FILTERS.map((c) => (
                <li key={c}>
                  <button
                    role="option"
                    aria-selected={licenseFilter.includes(c)}
                    className={licenseFilter.includes(c) ? "sort-item sort-active" : "sort-item"}
                    onClick={() => toggleLicenseFilter(c)}
                  >
                    <span>{t(`copyright.${c}`)}</span>
                    {licenseFilter.includes(c) && <Check size={13} strokeWidth={2} />}
                  </button>
                </li>
              ))}
              <li className="sort-sep" role="none" />
              <li className="filter-heading" role="none">
                {t("filter.languageSupport")}
              </li>
              {SCRIPT_FILTERS.map((sc) => (
                <li key={sc}>
                  <button
                    role="option"
                    aria-selected={scriptFilter.includes(sc)}
                    className={scriptFilter.includes(sc) ? "sort-item sort-active" : "sort-item"}
                    onClick={() => toggleScriptFilter(sc)}
                  >
                    <span>{t(`script.${sc}`)}</span>
                    {scriptFilter.includes(sc) && <Check size={13} strokeWidth={2} />}
                  </button>
                </li>
              ))}
              <li className="sort-sep" role="none" />
              <li className="filter-heading" role="none">
                {t("filter.fileFormat")}
              </li>
              {FORMAT_FILTERS.map((fmt) => (
                <li key={fmt}>
                  <button
                    role="option"
                    aria-selected={formatFilter.includes(fmt)}
                    className={formatFilter.includes(fmt) ? "sort-item sort-active" : "sort-item"}
                    onClick={() => toggleFormat(fmt as FontFormat)}
                  >
                    <span>{t(`format.${fmt}`)}</span>
                    {formatFilter.includes(fmt) && <Check size={13} strokeWidth={2} />}
                  </button>
                </li>
              ))}
              <li className="sort-sep" role="none" />
              <li className="filter-heading" role="none">
                {t("filter.typography")}
              </li>
              {FEATURE_FILTERS.map((tag) => (
                <li key={tag}>
                  <button
                    role="option"
                    aria-selected={featureFilter.includes(tag)}
                    className={featureFilter.includes(tag) ? "sort-item sort-active" : "sort-item"}
                    onClick={() => toggleFeature(tag)}
                  >
                    <span>{t(`feat.${tag}`)}</span>
                    {featureFilter.includes(tag) && <Check size={13} strokeWidth={2} />}
                  </button>
                </li>
              ))}
              <li className="sort-sep" role="none" />
              <li className="filter-heading" role="none">
                {t("filter.containsChar")}
              </li>
              <li className="filter-charrow" role="none">
                <input
                  className="filter-charinput"
                  value={charFilter}
                  maxLength={2}
                  spellCheck={false}
                  placeholder={t("filter.containsCharPlaceholder")}
                  aria-label={t("filter.containsChar")}
                  onChange={(e) => setCharFilter(e.target.value)}
                />
                <span className="filter-charnote">
                  {charSearching
                    ? t("filter.containsCharSearching")
                    : charFilter
                      ? `U+${charFilter.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`
                      : t("filter.containsCharHint")}
                </span>
                {charFilter && (
                  <button
                    className="search-clear"
                    onClick={() => setCharFilter("")}
                    aria-label={t("filter.containsCharClear")}
                  >
                    <X size={13} strokeWidth={2} />
                  </button>
                )}
              </li>
              <li className="sort-sep" role="none" />
              <li>
                <button
                  data-hint="hint.variableOnly"
                  role="option"
                  aria-selected={variableOnly}
                  className={variableOnly ? "sort-item sort-active" : "sort-item"}
                  onClick={() => setVariableOnly(!variableOnly)}
                >
                  <span>{t("filter.variableOnly")}</span>
                  {variableOnly && <Check size={13} strokeWidth={2} />}
                </button>
              </li>
              <li>
                <button
                  data-hint="hint.toggleableOnly"
                  role="option"
                  aria-selected={toggleableOnly}
                  className={toggleableOnly ? "sort-item sort-active" : "sort-item"}
                  onClick={() => setToggleableOnly(!toggleableOnly)}
                >
                  <span>{t("filter.toggleableOnly")}</span>
                  {toggleableOnly && <Check size={13} strokeWidth={2} />}
                </button>
              </li>
              <li>
                <button
                  data-hint="hint.incompleteOnly"
                  role="option"
                  aria-selected={incompleteOnly}
                  className={incompleteOnly ? "sort-item sort-active" : "sort-item"}
                  onClick={() => setIncompleteOnly(!incompleteOnly)}
                >
                  <span>{t("filter.incompleteOnly")}</span>
                  {incompleteOnly && <Check size={13} strokeWidth={2} />}
                </button>
              </li>
            </motion.ul>
          </>
        )}
      </AnimatePresence>
      {/* 「范围」二级菜单：fixed 定位在菜单外（菜单自己 overflow-y:auto 会裁掉绝对定位子元素） */}
      {open && sub && (
        <ul
          className="filter-submenu"
          role="menu"
          style={{ top: sub.top, left: sub.left }}
          onMouseLeave={() => setSub(null)}
        >
          {sub.kind === "tag" &&
            [...tagCounts.entries()].map(([tagName, count]) => (
              <li key={tagName}>
                <button
                  className={tagFilter.includes(tagName) ? "sort-item sort-active" : "sort-item"}
                  onClick={() => toggleTagFilter(tagName)}
                >
                  <span className="filter-sub-name">{tagName}</span>
                  <span className="filter-sub-count tabular">{count}</span>
                  {tagFilter.includes(tagName) && <Check size={12} strokeWidth={2} />}
                </button>
              </li>
            ))}
          {sub.kind === "collection" &&
            collectionNames.map((name) => (
              <li key={name}>
                <button
                  className={
                    collectionFilter.includes(name) ? "sort-item sort-active" : "sort-item"
                  }
                  onClick={() => toggleCollectionFilter(name)}
                >
                  <span className="filter-sub-name">{name}</span>
                  {collectionFilter.includes(name) && <Check size={12} strokeWidth={2} />}
                </button>
              </li>
            ))}
          {sub.kind === "snapshot" &&
            snapshots.map((snap) => (
              <li key={snap.name}>
                <button
                  className={
                    snapshotFilter.includes(snap.name) ? "sort-item sort-active" : "sort-item"
                  }
                  onClick={() => toggleSnapshotFilter(snap.name)}
                >
                  <span className="filter-sub-name">{snap.name}</span>
                  <span className="filter-sub-count tabular">{snap.entries.length}</span>
                  {snapshotFilter.includes(snap.name) && <Check size={12} strokeWidth={2} />}
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

function RescanButton() {
  const t = useT();
  const rescan = useFontStore((s) => s.rescan);
  const scanning = useFontStore((s) => s.phase === "scanning");
  return (
    <motion.button
      data-hint="hint.rescan"
      className="rescan-btn"
      aria-label={t("top.rescan")}
      disabled={scanning}
      onClick={() => void rescan()}
      whileTap={{ scale: 0.94 }}
    >
      <motion.span
        className="rescan-icon"
        animate={scanning ? { rotate: 360 } : { rotate: 0 }}
        transition={
          scanning
            ? { duration: 1.2, repeat: Infinity, ease: "linear" }
            : { duration: 0.2 }
        }
      >
        <RefreshCw size={14} strokeWidth={1.5} />
      </motion.span>
    </motion.button>
  );
}

function ImportFolderButton() {
  const t = useT();
  const installPaths = useFontStore((s) => s.installPaths);
  const [busy, setBusy] = useState(false);
  return (
    <motion.button
      data-hint="hint.importFolder"
      className="rescan-btn"
      aria-label={t("top.importFolder")}
      disabled={busy}
      onClick={async () => {
        const dir = await open({
          directory: true,
          multiple: false,
          title: t("top.importFolder"),
        });
        if (typeof dir !== "string") return;
        setBusy(true);
        try {
          // 后端会递归展开目录：文件夹（含子目录）里的字体**复制**一份进字体库，
          // 原来的文件夹原样保留（用户 2026-10-30：不走链接、也不移动源文件）。
          await installPaths([dir], "copy");
        } finally {
          setBusy(false);
        }
      }}
      whileTap={{ scale: 0.94 }}
    >
      <FolderOpen size={14} strokeWidth={1.5} />
    </motion.button>
  );
}

function CompareButton() {
  const t = useT();
  const selection = useFontStore((s) => s.selection);
  const picking = useFontStore((s) => s.comparePicking);
  const openCompare = useFontStore((s) => s.openCompare);
  const setComparePicking = useFontStore((s) => s.setComparePicking);
  const armed = selection.length >= 2;
  return (
    <motion.button
      data-hint="hint.compare"
      className={`compare-btn ${armed ? "compare-armed" : picking ? "compare-picking" : ""}`}
      aria-label={
        armed
          ? t("compare.ariaArmed", { count: Math.min(selection.length, 4) })
          : picking
            ? t("compare.ariaCancelPicking")
            : t("compare.ariaIdle")
      }
      onClick={() => {
        if (armed) openCompare(selection);
        else setComparePicking(!picking);
      }}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.96 }}
    >
      <Columns2 size={14} strokeWidth={1.5} />
      <span>
        {armed
          ? t("compare.buttonCount", { count: Math.min(selection.length, 4) })
          : picking
            ? t("compare.picking", { count: selection.length })
            : t("compare.button")}
      </span>
    </motion.button>
  );
}

export function TopBar() {
  const t = useT();
  const sampleText = useFontStore((s) => s.sampleText);
  /**
   * 顶栏这个「Hello」框用真实字体渲染。
   *
   * 它比卡片先挂载，字体也就最先开始加载——用户一进来就能看到「字体已经在出来了」，
   * 比盯着几行灰骨架屏等整库要好受得多（卡片随后按虚拟滚动一个个补上）。
   */
  const selectedFamily = useFontStore((s) => s.selectedFamily);
  const allFonts = useFontStore((s) => s.fonts);
  const allTags = useFontStore((s) => s.tags);
  const sampleFace = useMemo(() => {
    if (allFonts.length === 0) return null;
    // 只有带拉丁字形的字体才拿来渲染「Hello」：符号字体 / 纯中文手写体会把
    // 这几个字母画成方块或乱码，反而比用界面字体更难看。
    const hasLatin = (f: { scripts: string[] }) =>
      f.scripts.some((sc) => sc.toLowerCase().startsWith("latn"));
    const fam = selectedFamily ? familiesFor(allFonts, allTags).get(selectedFamily) : null;
    const fromFamily =
      fam?.faces.find((f) => f.style === "Regular" && hasLatin(f)) ??
      fam?.faces.find(hasLatin) ??
      null;
    if (fromFamily) return fromFamily;
    return (
      allFonts.find((f) => f.style === "Regular" && hasLatin(f)) ??
      allFonts.find(hasLatin) ??
      null
    );
  }, [selectedFamily, allFonts, allTags]);
  const { fontFamily: sampleFont } = useFontCss(sampleFace);
  const setSampleText = useFontStore((s) => s.setSampleText);
  const sizeIndex = useFontStore((s) => s.sizeIndex);
  // 样张视图的字号单独记一档（切过去初始 32px，调到 8px 也不影响卡片视图）
  const specimenSizeIndex = useFontStore((s) => s.specimenSizeIndex);
  const setSizeIndex = useFontStore((s) => s.setSizeIndex);
  const setSpecimenSizeIndex = useFontStore((s) => s.setSpecimenSizeIndex);
  const viewMode = useFontStore((s) => s.viewMode);
  const setViewMode = useFontStore((s) => s.setViewMode);
  const search = useFontStore((s) => s.search);
  const setSearch = useFontStore((s) => s.setSearch);
  /**
   * 搜索框自己维护输入值，125 ms 后才推给 store。
   *
   * 为什么：`search` 一变，`App` 里那次 `selectVisibleFamilies` 就会把全部字族重新筛一遍
   * 再排序（`localeCompare`）。4211 族时勉强，字体上万时每敲一个字都会卡一下 ——
   * 输入框必须跟手，筛选慢一点没关系。清空按钮仍是立即生效。
   */
  const [searchText, setSearchText] = useState(search);
  useEffect(() => {
    setSearchText(search);
  }, [search]);
  useEffect(() => {
    if (searchText === search) return;
    const id = window.setTimeout(() => setSearch(searchText), 125);
    return () => window.clearTimeout(id);
  }, [searchText, search, setSearch]);

  const intro = useIntro();
  /**
   * 预览字号下限随视图走（用户 2026-11-05）：
   * 样张视图是挑字用的，可以一路降到 8px 看小字表现；
   * 卡片 / 列表低于 24px 只剩一团灰线，没有意义，所以滑条从 24px 起。
   */
  const inSpecimen = viewMode === "specimen";
  const minSizeIndex = inSpecimen ? 0 : MIN_PREVIEW_SIZE_INDEX;
  const shownSizeIndex = Math.max(minSizeIndex, inSpecimen ? specimenSizeIndex : sizeIndex);
  const fill =
    ((shownSizeIndex - minSizeIndex) / (SIZES.length - 1 - minSizeIndex)) * 100;

  return (
    <motion.header
      className="topbar"
      initial={intro ? { y: -32, opacity: 0 } : false}
      animate={{ y: 0, opacity: 1 }}
      transition={intro ? { ...springSoft, delay: 0.06 } : INTRO_OFF}
    >
      <div className="topbar-field topbar-search">
        <Search size={14} strokeWidth={1.5} className="field-icon" />
        <input
          id="global-search"
          // 输入框也挂说明：光看占位符「搜索…」不知道能搜到什么
          data-hint="hint.search"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder={t("top.searchPlaceholder")}
          aria-label={t("top.searchAria")}
          spellCheck={false}
        />
        {searchText.length > 0 && (
          <button
            className="search-clear"
            onClick={() => {
              setSearchText("");
              setSearch("");
            }}
            aria-label={t("top.searchClear")}
          >
            <X size={13} strokeWidth={2} />
          </button>
        )}
      </div>

      <div className="topbar-field topbar-sample">
        <Type size={14} strokeWidth={1.5} className="field-icon" />
        <input
          data-hint="hint.sample"
          value={sampleText}
          onChange={(e) => setSampleText(e.target.value)}
          placeholder={t("top.samplePlaceholder")}
          aria-label={t("top.sampleAria")}
          spellCheck={false}
          style={sampleFont ? { fontFamily: sampleFont } : undefined}
        />
      </div>

      {/* 列表视图的行不使用预览字号，滑条在这里没有意义 —— 直接隐藏（用户 2026-11-05） */}
      {viewMode !== "list" && (
        <div className="topbar-size" style={{ "--fill": `${fill}%` } as CSSProperties}>
          <input
            type="range"
            data-hint="hint.size"
            min={minSizeIndex}
            max={SIZES.length - 1}
            step={1}
            value={shownSizeIndex}
            onChange={(e) =>
              inSpecimen ? setSpecimenSizeIndex(Number(e.target.value)) : setSizeIndex(Number(e.target.value))
            }
            aria-label={t("top.sizeAria")}
          />
          <span className="size-value tabular">{SIZES[shownSizeIndex]}</span>
        </div>
      )}

      <FilterMenu />

      <SortMenu />

      <CompareButton />

      <ImportFolderButton />

      <RescanButton />

      <div
        className="view-toggle"
        role="tablist"
        aria-label={t("top.viewMode")}
        onKeyDown={(e) => {
          // 三个 tab 之间用左右键切换（同时激活），否则这几个按钮键盘够不到
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          e.stopPropagation();
          const modes = ["grid", "list", "specimen"] as const;
          const cur = modes.findIndex((m) => m === viewMode);
          const next = modes[(cur + (e.key === "ArrowRight" ? 1 : -1) + modes.length) % modes.length];
          setViewMode(next);
          e.currentTarget.querySelectorAll<HTMLButtonElement>("[role='tab']")[
            modes.indexOf(next)
          ]?.focus();
        }}
      >
        {(["grid", "list", "specimen"] as const).map((mode) => (
          <motion.button
            data-hint="hint.viewMode"
            key={mode}
            role="tab"
            aria-selected={viewMode === mode}
            // roving tabindex：Tab 只在当前视图按钮上停一次（§5 第 30 条残留）
            tabIndex={viewMode === mode ? 0 : -1}
            className={`view-btn ${viewMode === mode ? "view-btn-active" : ""}`}
            onClick={() => setViewMode(mode)}
            whileTap={{ scale: 0.94 }}
          >
            {mode === "grid" ? (
              <LayoutGrid size={15} strokeWidth={1.5} />
            ) : mode === "list" ? (
              <List size={15} strokeWidth={1.5} />
            ) : (
              <Columns3 size={15} strokeWidth={1.5} />
            )}
          </motion.button>
        ))}
      </div>
    </motion.header>
  );
}
