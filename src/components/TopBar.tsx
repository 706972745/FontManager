import { AnimatePresence, motion } from "motion/react";
import {
  ArrowUpDown,
  Check,
  Columns2,
  Filter,
  FolderOpen,
  LayoutGrid,
  List,
  RefreshCw,
  Search,
  Type,
  X,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useMemo, useState, type CSSProperties } from "react";
import { springSnappy, springSoft } from "../design/springs";
import { INTRO_OFF, useIntro } from "../lib/useIntro";
import { familiesFor, SIZES, useFontStore, type SortMode } from "../state/fontStore";
import { useFontCss } from "../lib/fontLoader";
import type { Classification, FontFormat } from "../lib/ipc";
import { useT, type TKey } from "../lib/i18n";

const SORT_MODES = ["name", "styles", "size", "glyphs", "added"] as const satisfies readonly SortMode[];

const SORT_KEYS: Record<SortMode, TKey> = {
  name: "sort.name",
  styles: "sort.styles",
  size: "sort.size",
  glyphs: "sort.glyphs",
  added: "sort.added",
};

const FORMAT_FILTERS = ["otf", "ttf", "woff", "woff2"] as const;

const FEATURE_FILTERS = ["swsh", "salt", "dlig", "smcp", "onum", "frac"] as const;
const SOURCE_FILTERS = ["all", "system", "user"] as const;

const COPYRIGHT_FILTERS = ["free_commercial", "free_personal", "paid", "timelimited", "unknown"] as const;

export function SortMenu() {
  const t = useT();
  const sort = useFontStore((s) => s.sort);
  const setSort = useFontStore((s) => s.setSort);
  const [open, setOpen] = useState(false);

  return (
    <div className="sort-wrap">
      <motion.button
        className={`sort-btn ${open ? "sort-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
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
            <div className="menu-backdrop" onClick={() => setOpen(false)} />
            <motion.ul
              className="sort-menu glass-e3"
              role="listbox"
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
                      setOpen(false);
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

function FilterMenu() {
  const t = useT();
  const classFilter = useFontStore((s) => s.classFilter);
  const toggleClassFilter = useFontStore((s) => s.toggleClassFilter);
  const scriptFilter = useFontStore((s) => s.scriptFilter);
  const toggleScriptFilter = useFontStore((s) => s.toggleScriptFilter);
  const variableOnly = useFontStore((s) => s.variableOnly);
  const setVariableOnly = useFontStore((s) => s.setVariableOnly);
  const toggleableOnly = useFontStore((s) => s.toggleableOnly);
  const setToggleableOnly = useFontStore((s) => s.setToggleableOnly);
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
  const [open, setOpen] = useState(false);

  const activeCount =
    classFilter.length +
    scriptFilter.length +
    formatFilter.length +
    featureFilter.length +
    licenseFilter.length +
    (sourceFilter !== "all" ? 1 : 0) +
    (charFilter ? 1 : 0) +
    (variableOnly ? 1 : 0) +
    (toggleableOnly ? 1 : 0);

  return (
    <div className="sort-wrap">
      <motion.button
        data-tour="filters"
        className={`sort-btn ${open ? "sort-open" : ""} ${activeCount > 0 ? "filter-live" : ""}`}
        onClick={() => setOpen((v) => !v)}
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
            <div className="menu-backdrop" onClick={() => setOpen(false)} />
            <motion.ul
              className="sort-menu filter-menu glass-e3"
              role="listbox"
              aria-multiselectable
              initial={{ opacity: 0, y: -6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.13 } }}
              transition={springSnappy}
            >
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
                  role="option"
                  aria-selected={toggleableOnly}
                  className={toggleableOnly ? "sort-item sort-active" : "sort-item"}
                  onClick={() => setToggleableOnly(!toggleableOnly)}
                >
                  <span>{t("filter.toggleableOnly")}</span>
                  {toggleableOnly && <Check size={13} strokeWidth={2} />}
                </button>
              </li>
            </motion.ul>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function RescanButton() {
  const t = useT();
  const rescan = useFontStore((s) => s.rescan);
  const scanning = useFontStore((s) => s.phase === "scanning");
  return (
    <motion.button
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
      className="rescan-btn"
      aria-label={t("top.importFolder")}
      title={t("top.importFolder")}
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
          // The backend install_fonts expands directories recursively,
          // so every font in the folder and its subfolders is linked
          // into the library exactly like a drag-and-drop import.
          await installPaths([dir], "link");
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
  const setSizeIndex = useFontStore((s) => s.setSizeIndex);
  const viewMode = useFontStore((s) => s.viewMode);
  const setViewMode = useFontStore((s) => s.setViewMode);
  const search = useFontStore((s) => s.search);
  const setSearch = useFontStore((s) => s.setSearch);

  const intro = useIntro();
  const fill = (sizeIndex / (SIZES.length - 1)) * 100;

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
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("top.searchPlaceholder")}
          aria-label={t("top.searchAria")}
          spellCheck={false}
        />
        {search.length > 0 && (
          <button
            className="search-clear"
            onClick={() => setSearch("")}
            aria-label={t("top.searchClear")}
          >
            <X size={13} strokeWidth={2} />
          </button>
        )}
      </div>

      <div className="topbar-field topbar-sample">
        <Type size={14} strokeWidth={1.5} className="field-icon" />
        <input
          value={sampleText}
          onChange={(e) => setSampleText(e.target.value)}
          placeholder={t("top.samplePlaceholder")}
          aria-label={t("top.sampleAria")}
          spellCheck={false}
          style={sampleFont ? { fontFamily: sampleFont } : undefined}
        />
      </div>

      <div className="topbar-size" style={{ "--fill": `${fill}%` } as CSSProperties}>
        <input
          type="range"
          min={0}
          max={SIZES.length - 1}
          step={1}
          value={sizeIndex}
          onChange={(e) => setSizeIndex(Number(e.target.value))}
          aria-label={t("top.sizeAria")}
        />
        <span className="size-value tabular">{SIZES[sizeIndex]}</span>
      </div>

      <FilterMenu />

      <SortMenu />

      <CompareButton />

      <ImportFolderButton />

      <RescanButton />

      <div className="view-toggle" role="tablist" aria-label={t("top.viewMode")}>
        {(["grid", "list"] as const).map((mode) => (
          <motion.button
            key={mode}
            role="tab"
            aria-selected={viewMode === mode}
            className={`view-btn ${viewMode === mode ? "view-btn-active" : ""}`}
            onClick={() => setViewMode(mode)}
            whileTap={{ scale: 0.94 }}
          >
            {mode === "grid" ? (
              <LayoutGrid size={15} strokeWidth={1.5} />
            ) : (
              <List size={15} strokeWidth={1.5} />
            )}
          </motion.button>
        ))}
      </div>
    </motion.header>
  );
}
