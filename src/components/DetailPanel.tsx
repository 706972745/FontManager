import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AlertTriangle, CalendarDays, Check, Copy, Download, ExternalLink, FolderOpen, GripVertical, MoreHorizontal, Plus, RotateCcw, Scale, Search, Sparkles, Tag, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { BlinkCaretInput } from "../design/primitives/BlinkCaretInput";
import { PillToggle } from "../design/primitives/PillToggle";
import { easeTop, spring, springSnappy } from "../design/springs";
import { useFontCss, formatBytes, pathBasename } from "../lib/fontLoader";
import { os2ClassOf } from "../lib/os2Class";
import { fitPickPanel, PICK_LIST_WANT } from "../lib/pickerFit";
import { tagLabel } from "../lib/tagLabels";
import { isAutoTagId } from "../lib/tagVocabulary";
import { familiesFor, familyTagCounts, conflictsFor, useFontStore, type Family } from "../state/fontStore";
import { ipc, type CharsetStats, type FontFace, type VariationAxis } from "../lib/ipc";
import { createBoundedMap } from "../lib/boundedMap";
import { toast } from "../design/primitives/Toast";
import { FormatBadge } from "./FamilyCard";
import { buildFaceMenu, exportFace, exportFamily } from "../lib/menus";
import { openContextMenuAt } from "../design/primitives/ContextMenu";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { classifyLicense, copyrightExpired, familyCopyrightClass, normalizeCopyright } from "../lib/license";
import { faceKey } from "../lib/snapshotKey";
import { canSetExpiry, expiryNeedsConfirm, formatTagExpiry } from "../lib/tagExpiry";
import { parentDir } from "../lib/onlineCoverage";
import { playTag } from "../lib/sound";
import { StarRating } from "./StarRating";
import { INTRO_OFF, useIntro } from "../lib/useIntro";
import { t as translate, useT, type TKey } from "../lib/i18n";
import { useDisplayName } from "../lib/displayName";

/** 把「目录 → 文件名列表」摊平成可点击的条目，同名去重、按文件名排序 */
function flattenInfoFiles(map: Record<string, string[]>): { dir: string; name: string }[] {
  const seen = new Set<string>();
  const out: { dir: string; name: string }[] = [];
  for (const [dir, names] of Object.entries(map)) {
    for (const name of names) {
      const key = `${dir}\u0000${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ dir, name });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 目录 + 文件名拼成完整路径（沿用目录自己的分隔符） */
function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${dir}${sep}${name}`;
}

function copyName(text: string, what: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success(translate("toast.copied", { what }), undefined, "tick"))
    .catch((e) => toast.error(translate("toast.couldntCopy"), String(e)));
}

/**
 * 详情面板的字号阶梯。最低 24px（用户 2026-11-05）：
 * 比这更小的行在这里只剩一条灰线，看不出字形 —— 想看小字表现请用样张视图，
 * 那边的预览字号可以调到 8px。
 */
const WATERFALL = [24, 32, 44, 60, 80];

function StyleRow({
  face,
  family,
  familyData,
  selected,
  onSelect,
  synthesize,
}: {
  face: FontFace;
  family: string;
  /** 完整的字族对象：字重菜单要拿它算显示名 */
  familyData: Family;
  selected: boolean;
  onSelect: () => void;
  synthesize: boolean;
}) {
  const t = useT();
  const { fontFamily } = useFontCss(face);
  return (
    <motion.button
      className={`style-row ${selected ? "style-selected" : ""}`}
      onClick={onSelect}
      aria-pressed={selected}
      /* 整行属于「大块面」：按统一口径压暗、不缩放（审计 P1-1） */
      whileTap={{ opacity: 0.96, transition: springSnappy }}
    >
      <span
        className="style-name"
        style={{
          fontFamily: fontFamily ?? undefined,
          fontStyle: face.italic ? "italic" : "normal",
          fontWeight: synthesize ? face.weight : undefined,
        }}
      >
        {face.style}
      </span>
      <span className="style-fmt">{face.format.toUpperCase()}</span>
      <motion.span
        role="button"
        tabIndex={0}
        className="style-export"
        aria-label={t("detail.exportFace", { family, style: face.style })}
        onClick={(e) => {
          e.stopPropagation();
          void exportFace(face.path, pathBasename(face.path));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            void exportFace(face.path, pathBasename(face.path));
          }
        }}
        whileTap={{ scale: 0.94, transition: springSnappy }}
      >
        <Download size={13} strokeWidth={1.5} />
      </motion.span>
      {/* 字重自己的操作菜单：单独应用到 PS / AI / CDR、复制字体名 / PostScript 名 */}
      <motion.span
        role="button"
        tabIndex={0}
        className="style-export"
        aria-label={t("menu.faceActions", { name: face.style })}
        data-hint-text={t("menu.faceActions", { name: face.style })}
        onClick={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openContextMenuAt(r.left, r.bottom + 4, buildFaceMenu(familyData, face));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openContextMenuAt(r.left, r.bottom + 4, buildFaceMenu(familyData, face));
          }
        }}
        whileTap={{ scale: 0.94, transition: springSnappy }}
      >
        <MoreHorizontal size={13} strokeWidth={1.75} />
      </motion.span>
    </motion.button>
  );
}

const FEATURE_TAGS = [
  "liga",
  "dlig",
  "calt",
  "smcp",
  "c2sc",
  "onum",
  "lnum",
  "tnum",
  "pnum",
  "frac",
  "ordn",
  "sups",
  "subs",
  "zero",
  "salt",
  "swsh",
  "titl",
  "hist",
] as const;

const FEATURE_KEYS = new Map<string, TKey>(
  FEATURE_TAGS.map((tag) => [tag, `feat.${tag}`] as const),
);

const DEFAULT_ON = new Set(["liga", "calt"]);

function featureLabel(tag: string): string | null {
  const key = FEATURE_KEYS.get(tag);
  if (key) return translate(key);
  const ss = /^ss(\d\d)$/.exec(tag);
  if (ss) return translate("feat.stylisticSet", { n: Number(ss[1]) });
  return null;
}

function FeatureChips({
  features,
  overrides,
  onToggle,
  onReset,
}: {
  features: string[];
  overrides: Record<string, boolean>;
  onToggle: (tag: string) => void;
  onReset: () => void;
}) {
  const t = useT();
  const dirty = Object.keys(overrides).length > 0;
  return (
    <div className="feat-wrap">
      <div className="feat-chips">
        {features.map((tag) => {
          const on = overrides[tag] ?? DEFAULT_ON.has(tag);
          return (
            <motion.button
              key={tag}
              className={`feat-chip ${on ? "feat-on" : ""}`}
              aria-pressed={on}
              data-hint-text={tag}
              onClick={() => onToggle(tag)}
              whileTap={{ scale: 0.97, transition: springSnappy }}
            >
              {featureLabel(tag)}
            </motion.button>
          );
        })}
      </div>
      {dirty && (
        <button className="feat-reset" onClick={onReset} data-hint="hint.featReset">
          <RotateCcw size={11} strokeWidth={1.5} /> {t("detail.reset")}
        </button>
      )}
    </div>
  );
}

const AXIS_TAGS = ["wght", "wdth", "slnt", "ital", "opsz", "GRAD"] as const;

const AXIS_KEYS = new Map<string, TKey>(
  AXIS_TAGS.map((tag) => [tag, `axis.${tag}`] as const),
);

function axisName(tag: string): string {
  const key = AXIS_KEYS.get(tag);
  return key ? translate(key) : tag;
}

const SCRIPT_KEYS = new Map<string, TKey>(
  (
    [
      "latin",
      "cyrillic",
      "greek",
      "arabic",
      "hebrew",
      "devanagari",
      "thai",
      // 0.9.3-7 起汉字和假名分开标（原来合成一个 cjk，纯中文字体根本拿不到标记）
      "han",
      "kana",
      "cjk",
      "korean",
      "vietnamese",
    ] as const
  ).map((code) => [code, `script.${code}`] as const),
);

function scriptLabel(code: string): string {
  const key = SCRIPT_KEYS.get(code);
  return key ? translate(key) : code;
}

function AxisSliders({
  axes,
  values,
  onChange,
  onReset,
}: {
  axes: VariationAxis[];
  values: Record<string, number>;
  onChange: (tag: string, v: number) => void;
  onReset: () => void;
}) {
  const t = useT();
  const dirty = axes.some((a) => (values[a.tag] ?? a.default) !== a.default);
  return (
    <div className="axis-list">
      {axes.map((a) => {
        const v = values[a.tag] ?? a.default;
        const fill = a.max > a.min ? ((v - a.min) / (a.max - a.min)) * 100 : 0;
        return (
          <div key={a.tag} className="axis-row" style={{ "--fill": `${fill}%` } as React.CSSProperties}>
            <span className="axis-name">{axisName(a.tag)}</span>
            <input
              type="range"
              min={a.min}
              max={a.max}
              step={(a.max - a.min) / 200 || 1}
              value={v}
              onChange={(e) => onChange(a.tag, Number(e.target.value))}
              aria-label={t("detail.axisAria", { name: axisName(a.tag) })}
            />
            <span className="axis-value tabular">{Math.round(v)}</span>
          </div>
        );
      })}
      {dirty && (
        <button className="detail-heading-action axis-reset" onClick={onReset} data-hint="hint.axisReset">
          <RotateCcw size={11} strokeWidth={1.5} />
          {t("detail.reset")}
        </button>
      )}
    </div>
  );
}

/**
 * 字符集缓存：单个字面最多 4096 个码位（后端 `get_charset` 有上限），
 * 但**条数**原来是无界的 —— 翻过 100 个字体的详情、关掉面板，缓存仍然全留着（BUG-7）。
 * 这里给 100 条上限（约等于一次会话可能回看的详情数量），超出丢最早的。
 */
const charsetCache = createBoundedMap<string, number[]>(100);
const GLYPH_LIMIT = 512;

function GlyphMap({
  face,
  fontFamily,
  variation,
}: {
  face: FontFace;
  fontFamily: string | null;
  variation?: string;
}) {
  const t = useT();
  const [cps, setCps] = useState<number[] | null>(charsetCache.get(face.id) ?? null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const cached = charsetCache.get(face.id);
    if (cached) {
      setCps(cached);
      return;
    }
    setCps(null);
    let alive = true;
    ipc
      .getCharset(face.previewPath ?? face.path, face.faceIndex)
      .then((list) => {
        charsetCache.set(face.id, list);
        if (alive) setCps(list);
      })
      .catch(() => alive && setCps([]));
    return () => {
      alive = false;
    };
  }, [face.id, face.path, face.faceIndex]);

  if (cps === null) {
    return <div className="skeleton glyph-skeleton" />;
  }
  if (cps.length === 0) {
    return <div className="glyph-empty">{t("glyph.none")}</div>;
  }

  const visible = showAll ? cps : cps.slice(0, GLYPH_LIMIT);
  return (
    <>
      <div className="glyph-grid">
        {visible.map((cp) => {
          const ch = String.fromCodePoint(cp);
          const hex = cp.toString(16).toUpperCase().padStart(4, "0");
          return (
            <button
              key={cp}
              className="glyph-cell"
              data-cp={`U+${hex}`}
              aria-label={t("glyph.copyAria", { cp: `U+${hex}` })}
              style={{
                fontFamily: fontFamily ?? undefined,
                fontVariationSettings: variation,
              }}
              onClick={() =>
                navigator.clipboard
                  .writeText(ch)
                  .then(() => toast.success(t("glyph.copied", { ch }), `U+${hex}`, "tick"))
                  .catch(() => toast.error(t("toast.couldntCopy")))
              }
            >
              {ch}
            </button>
          );
        })}
      </div>
      {cps.length > GLYPH_LIMIT && !showAll && (
        <button className="glyph-more" onClick={() => setShowAll(true)} data-hint="hint.glyphMore">
          {t("glyph.showAll", { count: cps.length })}
        </button>
      )}
    </>
  );
}

function NoteEditor({ family }: { family: string }) {
  const t = useT();
  const saved = useFontStore((s) => s.notes[family] ?? "");
  const setFamilyNote = useFontStore((s) => s.setFamilyNote);
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [family, saved]);

  return (
    <textarea
      className="note-editor"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== saved && void setFamilyNote(family, draft)}
      placeholder={t("note.placeholder")}
      aria-label={t("note.aria")}
      rows={2}
      spellCheck={false}
    />
  );
}

// 「永久」（paid）chip 已按用户 2026-11-13 裁定移除 —— 不可再选。
// 存量兼容（硬要求）：prefs 里已存的 paid 值**全部路径保留** —— 徽标仍显示
// 「永久授权」（copyright.paidBadge）、顶栏筛选（TopBar 的 COPYRIGHT_FILTERS 仍含
// "paid"）能用、目录后缀「收费字体」映射不动（class_from_status 的 paid 分支未动）。
// 这里只是不能再**新选**；键盘导航对已设 paid 的族 indexOf 为 -1，
// 由下方 Math.max(cur, -1) 的 roving 逻辑兜住。
const COPYRIGHT_STATUS_OPTIONS = ["auto", "free_commercial", "free_personal", "timelimited"] as const;

/** 版权状态手动设置：默认"自动"（根据版权信息识别），也可手动指定商用免费 / 个人免费 / 收费 / 时间限制 */
function CopyrightStatusSection({ family }: { family: string }) {
  const t = useT();
  // 老版本存的是 "free"：显示时归一到「商用免费」，不然一排按钮都不亮
  const raw = useFontStore((s) => s.copyrightStatus[family]);
  const status = raw ? (normalizeCopyright(raw) ?? "auto") : "auto";
  const expiry = useFontStore((s) => s.copyrightExpiry[family]);
  const setCopyrightStatus = useFontStore((s) => s.setCopyrightStatus);
  const setCopyrightExpiry = useFontStore((s) => s.setCopyrightExpiry);
  const expired = status === "timelimited" && copyrightExpired(expiry);
  return (
    <motion.section
      variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring } }}
    >
      <div className="detail-heading">{t("detail.copyrightStatus")}</div>
      <div
        className="copyright-status-row"
        role="radiogroup"
        tabIndex={0}
        aria-label={t("detail.copyrightStatus")}
        onKeyDown={(e) => {
          const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
          if (!keys.includes(e.key)) return;
          // radiogroup 内部的方向键不能被全局列表导航抢走（§5 第 30 条）
          e.preventDefault();
          e.stopPropagation();
          const opts = COPYRIGHT_STATUS_OPTIONS;
          const n = opts.length;
          const cur = opts.indexOf(status as (typeof opts)[number]);
          const next =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? n - 1
                : e.key === "ArrowRight" || e.key === "ArrowDown"
                  ? (Math.max(cur, -1) + 1) % n
                  : (cur <= 0 ? n : cur) - 1;
          setCopyrightStatus(family, opts[next]);
          // roving tabindex：焦点跟着选中项走
          e.currentTarget
            .querySelectorAll<HTMLButtonElement>("[role='radio']")
            [next]?.focus();
        }}
      >
        {COPYRIGHT_STATUS_OPTIONS.map((opt) => (
          <button
            data-hint="hint.copyrightStatus"
            key={opt}
            role="radio"
            aria-checked={status === opt}
            tabIndex={status === opt ? 0 : -1}
            className={`copyright-status-btn ${status === opt ? "copyright-status-active" : ""}`}
            onClick={() => setCopyrightStatus(family, opt)}
          >
            {/* chips 拆新键（timelimitedChip）：`copyright.timelimited` 同时被徽标共用 ——
                徽标的自动判定「限时字体」语义上不是「已购买」，不能跟着按钮改名
                （用户 2026-11-13）。「paid」chip 已移除，copyright.paidBadge 仅供存量 paid 值的徽标 */}
            {opt === "timelimited"
              ? t("copyright.timelimitedChip")
              : t(`copyright.${opt}`)}
          </button>
        ))}
      </div>
      {status === "timelimited" && (
        <div className="copyright-expiry-row">
          <label className="copyright-expiry-label" htmlFor={`copyright-expiry-${family}`}>
            {t("copyright.expiryDate")}
          </label>
          <input
            id={`copyright-expiry-${family}`}
            type="date"
            className="copyright-expiry-input"
            value={expiry ?? ""}
            onChange={(e) => setCopyrightExpiry(family, e.target.value || null)}
            aria-label={t("copyright.expiryDate")}
          />
          {!expiry && (
            <span className="expiry-forever">{t("copyright.expiryForever")}</span>
          )}
          {expiry && (
            <button
              className="copyright-expiry-clear"
              onClick={() => setCopyrightExpiry(family, null)}
              aria-label={t("copyright.clearExpiry")}
              data-hint-text={t("copyright.clearExpiry")}
            >
              <X size={12} strokeWidth={1.5} />
            </button>
          )}
        </div>
      )}
      {expired && <div className="copyright-expired-note">{t("copyright.expired")}</div>}
    </motion.section>
  );
}

function LicenseSection({
  family,
  license,
  licenseUrl,
}: {
  family: string;
  license: string | null;
  licenseUrl: string | null;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  // 手动设置必须压过自动判定（用户 2026-11-13 报「设置后回到软件判定」）：
  // 只看 name 表文本的 classifyLicense 根本不知道用户点过什么，要把覆盖值接进来。
  const override = useFontStore((s) => s.copyrightStatus[family]);
  const manual = override ? normalizeCopyright(override) : null;
  const expiry = useFontStore((s) => s.copyrightExpiry[family]);
  if (!license && !licenseUrl && !manual) return null;
  const cls = classifyLicense(license);
  const manualVerdict =
    manual === "paid"
      ? t("copyright.paidBadge")
      : manual === "timelimited"
        ? expiry
          ? t("copyright.purchasedWithDate", { date: expiry })
          : t("copyright.purchasedBadge")
        : manual
          ? t(`copyright.${manual}`)
          : null;
  const label = manualVerdict ?? t(`license.${cls}`);
  return (
    <div className={`license-box license-${cls}`}>
      <div className="license-head">
        <Scale size={13} strokeWidth={1.5} />
        <span className="license-label">{label}</span>
        {licenseUrl && (
          <button
            className="license-link"
            aria-label={t("license.openPage")}
            onClick={() => void openUrl(licenseUrl).catch(() => toast.error(t("toast.couldntOpenLink")))}
          >
            <ExternalLink size={12} strokeWidth={1.5} />
          </button>
        )}
      </div>
      {manualVerdict && (license || licenseUrl) && (
        // 手动结论下面保留自动识别原文，用户才知道软件自己判的是什么、差在哪
        <div className="license-disclaimer">
          {t("copyright.autoWithText", { text: t(`license.${cls}`) })}
        </div>
      )}
      {license && (
        <button className="license-text" onClick={() => setExpanded((v) => !v)}>
          {expanded || license.length <= 180 ? license : `${license.slice(0, 180)}… `}
          {license.length > 180 && (
            <span className="license-more">{t(expanded ? "license.less" : "license.more")}</span>
          )}
        </button>
      )}
      <div className="license-disclaimer">{t("license.disclaimer")}</div>
    </div>
  );
}

function TagEditor({
  family,
  tags,
  autoTags,
}: {
  family: string;
  tags: string[];
  autoTags?: { tag: string; confidence: number; reason: string }[];
}) {
  const t = useT();
  const setFamilyTags = useFontStore((s) => s.setFamilyTags);
  const denyAutoTag = useFontStore((s) => s.denyAutoTag);
  const clearAutoTagDenials = useFontStore((s) => s.clearAutoTagDenials);
  const autoDenied = useFontStore((s) => s.autoTagDenied[family]);
  const autoTagEnabled = useFontStore((s) => s.autoTagEnabled);
  const tagExpiry = useFontStore((s) => s.tagExpiry);
  const setTagExpiry = useFontStore((s) => s.setTagExpiry);
  const [draft, setDraft] = useState("");
  // 正在设置到期日期的那枚标签（同一时间只开一行内联日期选择器）
  const [expiryTag, setExpiryTag] = useState<string | null>(null);

  // 从「库里已有的标签」挑：不用手打，还能一次多选。数据源跟侧栏同一份
  // （`familyTagCounts` 只算当前库里真实存在的族，所以不会列出已删字体的幽灵标签）。
  const fonts = useFontStore((s) => s.fonts);
  const allTags = useFontStore((s) => s.tags);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [pq, setPq] = useState("");
  /**
   * 设到期日前的「波及面」确认（用户 2026-11-14，21:12 二次明确）。
   *
   * 标签按**名字**存在 state.json 里，一个名字常被几十上百个字体共用 —— 给「客户A」
   * 设到期日，到期删掉的是**所有**带这个名字的字体上的它。2 个及以上字体就先问一句。
   * **每次点击都问**：只要这个标签还没定过日期，点日历图标就弹（关面板、重启都一样）；
   * 已经定过日期的不再问 —— 日期本身就说明用户已做过一次知情决定（见下面 onClick）。
   */
  const [expiryWarn, setExpiryWarn] = useState<{ tag: string; count: number } | null>(null);
  const expiryRowRef = useRef<HTMLDivElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  // 列表的可用高度由 JS 量出来（见下面的 fitPicker）：固定 196px 在面板靠下时会
  // 被详情面板底边裁掉，「确定」按钮看不见，用户每次都得手动滚一下。
  const [listMax, setListMax] = useState(196);

  // 标签名 → 有多少个族带它。除了喂给下面的候选清单，还用来判断「设到期日会波及几个字体」。
  const counts = useMemo(
    () => familyTagCounts(familiesFor(fonts, allTags)).counts,
    [fonts, allTags],
  );
  /**
   * 选择面板的清单 = 库里**全部**标签，包括已经在这个字体上的。
   *
   * 原来这里是「过滤掉本字体已有的」，于是用户搜一个自己的标签（比如 `nihaooff`）时
   * 会得到「没有匹配的标签」—— 明明侧栏里就有一行（用户 2026-11-14）。已在本字体上的
   * 直接列出来、勾着、不可点，比让它凭空消失更容易理解。
   * `addable` 才是「还能加几个」，按钮上的角标用它。
   */
  const available = useMemo(
    () => [...counts.entries()].sort((a, b) => tagLabel(a[0], t).localeCompare(tagLabel(b[0], t))),
    // t 只影响排序与显示名，语言切换时会重渲染，这里跟着 counts 走就够
    [counts],
  );
  const addable = useMemo(
    () => available.filter(([name]) => !tags.includes(name)).length,
    [available, tags],
  );

  const q = pq.trim().toLowerCase();
  const visible = q
    ? available.filter(
        ([name]) => name.toLowerCase().includes(q) || tagLabel(name, t).toLowerCase().includes(q),
      )
    : available;

  const closePicker = useCallback(() => {
    setPickerOpen(false);
    setPicked([]);
    setPq("");
  }, []);

  /**
   * 让选择面板「点一下就完整显现」。
   *
   * 起因（2026-11-14，用户反馈）：这块是跟着文档流展开的（不是绝对定位浮层，原因见
   * app.css 里 .tag-pick-wrap 的注释），打开时会把下方内容往下推；而详情面板本身是
   * 滚动容器，面板底边经常落在可视区外 —— 于是每点一次都得手动滚一下才能看到列表
   * 尾巴和「确认」按钮。
   *
   * 做法：列表是唯一可伸缩的一段，先按「按钮下方还剩多少可见空间」反算它的高度；
   * 空间不够就把详情面板往上滚**最小必要距离**，再让列表刚好填满剩余空间。
   * 在 layout 阶段直接改 scrollTop（不做 smooth 动画），一次到位，用户看不到中间帧。
   */
  const fitPicker = useCallback(() => {
    const wrap = pickerRef.current;
    if (!wrap) return;
    const picker = wrap.querySelector<HTMLElement>(".tag-picker");
    const btn = wrap.querySelector<HTMLElement>(".tag-pick-btn");
    if (!picker || !btn) return;

    // 头部（搜索框）+ 底部（确认按钮）都是定高，只有列表可以伸缩
    const chrome =
      (picker.querySelector<HTMLElement>(".tag-picker-head")?.offsetHeight ?? 38) +
      (picker.querySelector<HTMLElement>(".tag-picker-foot")?.offsetHeight ?? 38) +
      14; // 边框 + 面板自身留白

    const scroller = wrap.closest<HTMLElement>(".detail-inner");
    if (!scroller) {
      setListMax(PICK_LIST_WANT);
      return;
    }

    // 面板刚展开时内容已经变高，可滚距离一定大于缺口；万一仍不够就滚到底为止
    const room = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    const fit = fitPickPanel({
      boxBottom: scroller.getBoundingClientRect().bottom,
      btnBottom: btn.getBoundingClientRect().bottom,
      chrome,
      gap: 6, // .tag-picker 的 margin-top
      room,
    });

    if (fit.scrollBy > 0) scroller.scrollTop += fit.scrollBy;
    setListMax(fit.listMax);
  }, []);

  useLayoutEffect(() => {
    if (!pickerOpen) return;
    fitPicker();
    // 拖窗口/改面板宽度都会改可视高度，开着的时候跟着重算
    window.addEventListener("resize", fitPicker);
    return () => window.removeEventListener("resize", fitPicker);
  }, [pickerOpen, fitPicker]);

  /**
   * 日期行与「波及面提示」点到别处就收起（用户 2026-11-14）。
   *
   * 原来只有再点一次日历按钮才能关掉：用户在别处点来点去时，这一行会一直挂在标签区，
   * 还占着一整行高度。两条例外：
   *   · 点行内（日期输入 / 清除按钮）不关 —— 那是用户正在操作它；
   *   · 点日历按钮不关 —— 交给按钮自己 toggle，否则 mousedown 先关、click 又开，等于关不掉。
   * Esc 也收，跟其它浮层一致。
   */
  useEffect(() => {
    if (!expiryTag && !expiryWarn) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (!el || typeof el.closest !== "function") return;
      if (expiryRowRef.current?.contains(el)) return;
      if (el.closest(".tag-expiry-btn")) return;
      if (el.closest(".tag-expiry-warn")) return;
      setExpiryTag(null);
      setExpiryWarn(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setExpiryTag(null);
      setExpiryWarn(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [expiryTag, expiryWarn]);

  // 点外面 / 按 Esc 关掉：面板很窄，浮层挡住别的东西时用户第一反应就是点外面
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) closePicker();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePicker();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen, closePicker]);

  const commitPicked = () => {
    const next = [...tags];
    for (const p of picked) if (!next.includes(p)) next.push(p);
    if (next.length !== tags.length) {
      playTag(true);
      void setFamilyTags(family, next);
    }
    closePicker();
  };

  const add = () => {
    const next = draft.trim().toLowerCase();
    if (next && !tags.includes(next)) {
      playTag(true);
      void setFamilyTags(family, [...tags, next]);
    }
    setDraft("");
  };

  return (
    <div className="tag-editor">
      <AnimatePresence>
        {tags.map((tag) => {
          // 自动标签不允许设到期日（用户 2026-11-14）：自动标签是按规则现算的，
          // 到期删掉之后下一次推导又会长回来，只会让用户觉得「删了又回来」。
          // 判据按**名字**，跟上面的图标同一个口径 —— 用户认可过的、或删掉后手打的
          // 同名标签，仍然是软件词表里的名字，同样不给日期。
          const expirable = canSetExpiry(tag);
          return (
          <motion.span
            key={tag}
            className="tag-chip tag-chip-iconed"
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={spring}
            /*
             * 这里**不能**加 `layout`（2026-11-14 用户报的「点开选择面板后上方的
             * 手工标签偏移」就是它）：motion 的 layout 投影用 getBoundingClientRect
             * 比对新旧盒子，而入场动画本身在跑 `scale 0.85 → 1` ——
             * 投影量到的是「被自己缩小后」的盒子，于是按 1/0.85 ≈ 1.18 反向缩放补偿，
             * chip 会一直比同行的大一圈并向上错位、压住下一行（截图比例与 1.18 吻合）。
             * 换个族 / 开关下面那块面板都会重新触发一次测量，所以看起来像「点一下就跑偏」。
             * 代价是删除标签时其余 chip 直接落位、不再滑动 —— 可以接受。
             */
          >
            {/* 图标按**名字**判定（`isAutoTagId`）：软件词表里的名字（class:serif / cn:song / vox:* …）
                一律魔棒 —— 用户把这个建议「认可」成自己的标签之后仍然是软件的名字，图标不该跟着变；
                用户删掉某条自动标签、后来又手打了一样的名字，也照样是魔棒。
                只有用户自己造的词（「品牌A专用」）才是实线「标签」图标。
                边框仍然是第二重编码：实线 = 已经在你名下（可删、会同步），虚线 = 软件此刻的建议。 */}
            {isAutoTagId(tag) ? (
              <Sparkles size={10} strokeWidth={1.6} className="tag-auto-spark" />
            ) : (
              <Tag size={10} strokeWidth={1.5} className="tag-manual-icon" />
            )}
            {tagLabel(tag, t)}
            {expirable && tagExpiry[tag] && (
              <span
                className="tag-expiry-date"
                title={`${t("tag.expiryDate")}: ${tagExpiry[tag]}`}
              >
                {formatTagExpiry(tagExpiry[tag])}
              </span>
            )}
            {expirable && (
              <button
                className="tag-expiry-btn"
                aria-label={t("tag.expiryDate")}
                title={t("tag.expiryDate")}
                data-active={expiryTag === tag || undefined}
                onClick={() => {
                  if (expiryTag === tag) {
                    setExpiryTag(null);
                    return;
                  }
                  // 同名标签会被**所有**字体共用：设日期等于给它们全部定了个死期。
                  // 2 个及以上就先问一句（用户 2026-11-14：含 2 个），别让用户在不知情的
                  // 情况下清掉半个库。**每次点击都问**（只要还没定过日期）：
                  // 不做任何「问过就记住」的机制 —— 已定过日期的不再问，日期本身就是知情决定。
                  const n = counts.get(tag) ?? 0;
                  if (expiryNeedsConfirm(n) && !tagExpiry[tag]) {
                    setExpiryTag(null);
                    setExpiryWarn({ tag, count: n });
                    return;
                  }
                  setExpiryWarn(null);
                  setExpiryTag(tag);
                }}
              >
                <CalendarDays size={11} strokeWidth={1.5} />
              </button>
            )}
            <button
              aria-label={t("tag.removeAria", { tag })}
              onClick={() => {
                playTag(false);
                void setFamilyTags(family, tags.filter((x) => x !== tag));
              }}
            >
              <X size={11} strokeWidth={1.5} />
            </button>
          </motion.span>
          );
        })}
      </AnimatePresence>
      {/* 波及面提示：标签被 ≥2 个字体共用且还没定过日期时，每次点日历都弹，点继续才展开日期选择 */}
      {expiryWarn && (
        <div className="tag-expiry-warn" role="alert">
          <AlertTriangle size={12} strokeWidth={1.8} className="tag-expiry-warn-icon" />
          <div className="tag-expiry-warn-text">
            <strong>{t("tag.expiryWarnTitle", { count: expiryWarn.count })}</strong>
            <span>{t("tag.expiryWarnBody", { tag: tagLabel(expiryWarn.tag, t) })}</span>
          </div>
          <div className="tag-expiry-warn-actions">
            <button
              className="tag-expiry-warn-ok"
              onClick={() => {
                setExpiryTag(expiryWarn.tag);
                setExpiryWarn(null);
              }}
            >
              {t("tag.expiryWarnOk")}
            </button>
            <button className="tag-expiry-warn-cancel" onClick={() => setExpiryWarn(null)}>
              {t("tag.expiryWarnCancel")}
            </button>
          </div>
        </div>
      )}
      {/*
        自动标签单独一段：虚线 chip + 魔棒角标，跟手工标签在视觉上分得开。
        为什么要分开：用户必须一眼看出「这条是软件猜的」，否则删了还会被推回来时
        会以为软件坏了。每条的 tooltip 里带理由（证据来源），这是可解释性的最低要求。
        **只有一个按钮**：× = 不再建议（记进否决名单，永不复发）。用户 2026-11-14 明确
        「不需要这个标签直接移除就好」—— 原来的 ✓「认可成我的标签」是多余的一道手续：
        想要的标签用户自己打、或者从「从已有标签选」里勾，不需要软件先替他占个位。
      */}
      {autoTagEnabled && (autoTags?.length ?? 0) > 0 && (
        <div className="tag-auto-row">
          {autoTags!.map((d) => (
            <span
              key={d.tag}
              className="tag-chip tag-chip-auto"
              title={`${t("tag.autoHint")} · ${d.reason} · ${Math.round(d.confidence * 100)}%`}
            >
              <Sparkles size={10} strokeWidth={1.6} className="tag-auto-spark" />
              {tagLabel(d.tag, t)}
              <button
                aria-label={t("tag.rejectAuto", { tag: d.tag })}
                title={t("tag.rejectAuto", { tag: d.tag })}
                onClick={() => denyAutoTag(family, d.tag)}
              >
                <X size={11} strokeWidth={1.5} />
              </button>
            </span>
          ))}
        </div>
      )}
      {(autoDenied?.length ?? 0) > 0 && (
        <button className="tag-auto-restore" onClick={() => clearAutoTagDenials(family)}>
          <RotateCcw size={11} strokeWidth={1.5} />
          {t("tag.restoreAuto", { count: autoDenied!.length })}
        </button>
      )}
      {expiryTag && tags.includes(expiryTag) && (
        <div className="tag-expiry-row" ref={expiryRowRef}>
          <span className="tag-expiry-label">{t("tag.expiryDate")}</span>
          <input
            type="date"
            className="copyright-expiry-input"
            value={tagExpiry[expiryTag] ?? ""}
            onChange={(e) => setTagExpiry(expiryTag, e.target.value || null)}
            aria-label={t("tag.expiryDate")}
          />
          {!tagExpiry[expiryTag] && (
            <span className="expiry-forever">{t("tag.expiryForever")}</span>
          )}
          {tagExpiry[expiryTag] && (
            <button
              className="copyright-expiry-clear"
              onClick={() => {
                setTagExpiry(expiryTag, null);
                setExpiryTag(null);
              }}
              aria-label={t("copyright.clearExpiry")}
              data-hint-text={t("copyright.clearExpiry")}
            >
              <X size={12} strokeWidth={1.5} />
            </button>
          )}
        </div>
      )}
      <div className="tag-input">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder={t("tag.addPlaceholder")}
          aria-label={t("tag.addAria")}
          spellCheck={false}
        />
        <button aria-label={t("tag.addAria")} onClick={add} disabled={!draft.trim()}>
          <Check size={13} strokeWidth={2} />
        </button>
      </div>

      {/* ＋：不打字，直接从库里已有的标签里勾。多选后一次写入，走的是同一条 setFamilyTags。 */}
      <div className="tag-pick-wrap" ref={pickerRef}>
        <button
          className={`tag-pick-btn ${pickerOpen ? "open" : ""}`}
          aria-label={t("tag.pickAria")}
          aria-expanded={pickerOpen}
          title={t("tag.pickAria")}
          onClick={() => (pickerOpen ? closePicker() : setPickerOpen(true))}
        >
          <Plus size={12} strokeWidth={1.5} />
          {t("tag.pickOpen")}
          {addable > 0 && <span className="tag-pick-badge tabular">{addable}</span>}
        </button>

        {pickerOpen && (
          <div className="tag-picker" role="dialog" aria-label={t("tag.pickAria")}>
            <div className="tag-picker-head">
              {/* 用和其它搜索框同一个自绘闪烁块状光标：原生细光标在这块深色面板上
                  又细又不闪，和顶栏搜索框明显不是一套（用户 2026-11-14）。 */}
              <BlinkCaretInput
                value={pq}
                onChange={(e) => setPq(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && picked.length > 0) commitPicked();
                }}
                placeholder={t("tag.pickSearch")}
                aria-label={t("tag.pickSearch")}
                spellCheck={false}
                autoFocus
              />
              <button className="tag-picker-close" aria-label={t("tag.pickClose")} onClick={closePicker}>
                <X size={12} strokeWidth={1.5} />
              </button>
            </div>
            {visible.length === 0 ? (
              <div className="tag-picker-empty">
                {available.length === 0 ? t("tag.pickEmpty") : t("tag.pickNoMatch")}
              </div>
            ) : (
              <ul className="tag-picker-list" style={{ maxHeight: listMax }}>
                {visible.map(([name, count]) => {
                  // 已经在这个字体上的：勾着、不可点 —— 它的「添加」没有意义，
                  // 但列出来能让用户确认「库里有这个名字，只是已经用上了」。
                  const applied = tags.includes(name);
                  const on = applied || picked.includes(name);
                  return (
                    <li key={name}>
                      <button
                        className={`tag-picker-item ${on ? "on" : ""} ${applied ? "applied" : ""}`}
                        aria-pressed={on}
                        aria-disabled={applied || undefined}
                        disabled={applied}
                        title={applied ? t("tag.pickApplied") : undefined}
                        onClick={() =>
                          setPicked((prev) =>
                            prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name],
                          )
                        }
                      >
                        <span className="tag-picker-mark">{on && <Check size={11} strokeWidth={2} />}</span>
                        <span className="tag-picker-name">{tagLabel(name, t)}</span>
                        <span className="tag-picker-count tabular">{count}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="tag-picker-foot">
              <button className="tag-picker-add" disabled={picked.length === 0} onClick={commitPicked}>
                {t("tag.pickConfirm")}
                {picked.length > 0 && <span className="tabular"> {picked.length}</span>}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ConflictFileCard({ path }: { path: string }) {
  const t = useT();
  const fonts = useFontStore((s) => s.fonts);
  const setFontFileActive = useFontStore((s) => s.setFontFileActive);
  const uninstallFontFile = useFontStore((s) => s.uninstallFontFile);
  const faces = fonts.filter((f) => f.path === path);
  const rep = faces[0] ?? null;
  const isSystem = faces.length === 0 || faces.some((f) => f.source === "system");
  const isActive = faces.some((f) => f.active);
  const canToggle = !isSystem && faces.some((f) => f.deactivatable);
  const styles = [...new Set(faces.map((f) => f.style))].join(", ");
  const sourceLabel =
    rep?.source === "system"
      ? t("detail.systemFont")
      : rep?.source === "managed"
        ? t("detail.sourceManaged")
        : rep?.source === "user"
          ? t("detail.sourceUser")
          : null;

  return (
    <div className="conflict-file">
      <button
        className="path-link detail-mono"
        onClick={() =>
          revealItemInDir(path).catch(() => toast.error(t("toast.couldntOpenFileManager")))
        }
        data-hint-text={path}
      >
        <FolderOpen size={11} strokeWidth={1.5} />
        <span className="conflict-file-name">{pathBasename(path)}</span>
      </button>
      <div className="conflict-file-meta">
        {rep && (
          <span className="conflict-file-family">
            {rep.family}
            {styles ? ` — ${styles}` : ""}
          </span>
        )}
        {sourceLabel && (
          <span className="conflict-file-badges">
            <span className="conflict-badge-src">{sourceLabel}</span>
          </span>
        )}
      </div>
      <span className="conflict-file-path detail-mono">{path}</span>
      {isSystem ? (
        <span className="conflict-system-note">{t("detail.conflictSystemProtected")}</span>
      ) : (
        <>
          <div className="conflict-file-row">
            <span className="activate-label">{t(isActive ? "detail.active" : "detail.inactive")}</span>
            <PillToggle
              on={isActive}
              disabled={!canToggle}
              onChange={(on) => void setFontFileActive(path, on)}
              label={t(isActive ? "card.deactivate" : "card.activate", { name: pathBasename(path) })}
            />
            <button
              className="conflict-btn conflict-btn-trash"
              onClick={() => void uninstallFontFile(path)}
            >
              <Trash2 size={12} strokeWidth={1.5} />
              {t("detail.conflictTrash")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function DetailPanel() {
  const t = useT();
  // 详情标题同样按界面语言显示字体名（数据主键仍是 family.name）
  const displayName = useDisplayName();
  const intro = useIntro();
  const selectedFamily = useFontStore((s) => s.selectedFamily);
  const fonts = useFontStore((s) => s.fonts);
  const tags = useFontStore((s) => s.tags);
  const select = useFontStore((s) => s.select);
  const setFamilyActive = useFontStore((s) => s.setFamilyActive);
  const uninstallFamily = useFontStore((s) => s.uninstallFamily);
  const sampleText = useFontStore((s) => s.sampleText);

  const panelWidth = useFontStore((s) => s.panelWidth);
  /**
   * 详情面板的展开是**宽度动画**（0 → panelWidth）。宽度不是 transform，
   * 每帧都要重排整个主区域，还要重算面板上的 32px 毛玻璃 —— 低配机器上这一下最贵。
   *
   * `MotionConfig reducedMotion` 只管 transform / layout，**管不到 width**，
   * 所以软件里的「减弱动态效果」开关对这里原本是失效的。这里显式接管：
   * 系统开了减弱动效、或者用户在本软件里开了开关，都直接给最终宽度，不逐帧过渡。
   */
  const motionPref = useFontStore((s) => s.motionPref);
  const systemReduce = useReducedMotion();
  const noMotion = systemReduce || motionPref === "reduced";
  const setPanelWidth = useFontStore((s) => s.setPanelWidth);
  const dragging = useRef(false);
  /** 正在拖左边缘调宽：此时宽度必须实时跟手，不能再走弹簧（会拖出「粘手」感） */
  const [resizing, setResizing] = useState(false);
  /** 拖宽时挂上的监听清理函数：pointercancel / 卸载时统一收掉 */
  const dragCleanup = useRef<(() => void) | null>(null);
  /**
   * 内容滚动容器（.detail-inner）。去掉了 `key={family.name}` 之后它不再重建，
   * 换族时得自己把滚动位置复位 —— 原来这一下是「整块重挂载」顺带完成的。
   */
  const innerRef = useRef<HTMLDivElement>(null);

  const onResizeDown = useCallback(
    (e: React.PointerEvent) => {
      dragCleanup.current?.();
      dragging.current = true;
      setResizing(true);
      const target = e.target as HTMLElement;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        /* 拿不到捕获就退化为 window 监听 */
      }
      const onMove = (ev: PointerEvent) => {
        if (dragging.current) setPanelWidth(window.innerWidth - ev.clientX);
      };
      // pointerup 不是唯一出口：系统手势打断（pointercancel）、指针捕获丢失、
      // 面板在拖动中被卸载，都会留下一套「跟手」监听在后台继续改宽度（§5 第 26 条）。
      function end() {
        dragging.current = false;
        setResizing(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        target.removeEventListener("lostpointercapture", end);
        if (dragCleanup.current === end) dragCleanup.current = null;
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
      target.addEventListener("lostpointercapture", end);
      dragCleanup.current = end;
    },
    [setPanelWidth],
  );

  // 面板卸载（切到速览 / 关闭面板）时把监听收干净
  useEffect(() => () => dragCleanup.current?.(), []);

  const family = selectedFamily
    ? familiesFor(fonts, tags).get(selectedFamily) ?? null
    : null;

  const [styleId, setStyleId] = useState<string | null>(null);
  const [axisValues, setAxisValues] = useState<Record<string, number>>({});

  const [features, setFeatures] = useState<string[]>([]);
  const [featureOverrides, setFeatureOverrides] = useState<Record<string, boolean>>({});
  useLayoutEffect(() => {
    setStyleId(null);
    setAxisValues({});
    setFeatureOverrides({});
    // 换族把内容滚回顶部：原来是 `key={family.name}` 重挂载顺带做的（审计 P1-7 去掉 key 之后必须自己来）。
    // 用 layout effect：在 paint 之前复位，否则会先闪一帧「上一个族的滚动位置」。
    if (innerRef.current) innerRef.current.scrollTop = 0;
  }, [selectedFamily]);

  const snapshots = useFontStore((s) => s.snapshots);
  const toggleFamilyInSnapshot = useFontStore((s) => s.toggleFamilyInSnapshot);

  const lead =
    family?.faces.find((f) => f.id === styleId) ??
    family?.faces.find((f) => f.style === "Regular") ??
    family?.faces[0] ??
    null;
  // OS/2 分类：只读展示，**不进 tags、不进筛选、不进搜索**。
  // 用途只有一个 —— 用户想跟字体册 / Suitcase 对一下「那家软件把它叫什么」。
  const os2 = os2ClassOf(family?.faces ?? []);
  const { fontFamily } = useFontCss(lead);
  const text = sampleText.trim() || family?.name || "";

  /* 字符集构成：cmap 里到底有多少字符、其中汉字几个。
   *
   * 卡片上「无中文」是个结论，用户没法核对（鸿蒙基础版就是典型：它真有 0 个汉字，
   * 但用户以为自己装的是一套中文）。这里给出「共 866 字符 · 汉字 0」这种硬数据，
   * 判断立刻变得可验证。
   *
   * 要枚举全部码位，单个 8MB 中文字体 2~5ms，只对当前打开的这个字面调一次，
   * 不参与扫描。 */
  const [charset, setCharset] = useState<CharsetStats | null>(null);
  useEffect(() => {
    setCharset(null);
    if (!lead || lead.format === "woff" || lead.format === "woff2") return;
    let stale = false;
    ipc
      .fontCharset([[lead.path, lead.faceIndex]])
      .then((res) => {
        if (!stale) setCharset(res[0] ?? null);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead?.id]);

  /* 版权文件：字族目录里有没有 LICENSE / OFL 这类文件。
   * 只认非系统字面所在的目录 —— C:\Windows\Fonts 不该被我们塞 txt。 */
  const writableDirs = family
    ? [...new Set(family.faces.filter((f) => f.source !== "system").map((f) => parentDir(f.path)))]
        .filter((d) => d.length > 0)
        .sort()
    : [];
  const dirsKey = writableDirs.join("\n");
  /* 字体文件 name 表里自带的版权信息（2026-11-05 用户口径两段）：
   * ① 绝不自动生成版权文件 —— 没有授权文档时不写任何东西进字体目录；
   * ② 只有当这个字族的版权结论**明确**（商用免费 / 个人免费 / 收费 / 限时，含手动指定）
   *    且字体文件自带版权文字时，才在「版权文件」一行显示「字体文件自带版权信息」；
   *    判不出结论（未知）就照旧显示「未找到」，不假装知道。 */
  const manualCopyrightRaw = useFontStore((s) => (family ? s.copyrightStatus[family.name] : undefined));
  const copyrightVerdict = family ? familyCopyrightClass(family.faces, manualCopyrightRaw ?? null) : "unknown";
  const embeddedCopyright =
    copyrightVerdict !== "unknown"
      ? family?.faces.map((f) => (f.copyright ?? "").trim()).find((c) => c.length > 0) ?? ""
      : "";
  // 「目录 + 文件名」成对存：只留文件名点开时拼不出路径（用户 2026-10-30 要求能点开）
  const [licenseFiles, setLicenseFiles] = useState<{ dir: string; name: string }[] | null>(null);
  const [licenseSearching, setLicenseSearching] = useState(false);
  useEffect(() => {
    setLicenseFiles(null);
    if (!dirsKey) {
      setLicenseFiles([]);
      return;
    }
    let stale = false;
    ipc
      .infoFiles(dirsKey.split("\n"))
      .then((map) => {
        if (stale) return;
        setLicenseFiles(flattenInfoFiles(map));
      })
      .catch(() => {
        if (!stale) setLicenseFiles([]);
      });
    return () => {
      stale = true;
    };
  }, [dirsKey]);

  /**
   * 版权搜索的请求代次。搜版权是「发起 → 网络 / 磁盘 → 写回文件列表」的多段异步，
   * 期间用户很可能已经切到别的字族（甚至关掉面板）：旧结果写回来就会变成
   * 「B 字族的详情里列出 A 字族的版权文件」（§5 第 24 条）。
   */
  const licenseReqGen = useRef(0);
  useEffect(() => {
    licenseReqGen.current++;
    // 切族 = 上一个族的搜索一定作废。这里必须顺手把「搜索中」复位：
    // 在飞请求的 finally 因为代次不符不会写回，不复位就永久卡在「搜索中…」、
    // 按钮永久禁用，只能刷新页面才能恢复（§5 第 24 条）。
    setLicenseSearching(false);
    return () => {
      licenseReqGen.current++;
    };
  }, [family?.name]);

  const searchLicense = async () => {
    if (!family || licenseSearching || writableDirs.length === 0) return;
    const gen = ++licenseReqGen.current;
    const forFamily = family.name;
    setLicenseSearching(true);
    try {
      const postscripts = [
        ...new Set(family.faces.map((f) => f.postscriptName).filter((p): p is string => !!p)),
      ];
      const hit = await ipc.fontLicenseFetch(forFamily, postscripts, writableDirs);
      if (gen !== licenseReqGen.current) return;
      if (!hit) {
        toast.info(t("toast.licenseNotFound"), t("toast.licenseNotFoundSub"));
        return;
      }
      toast.success(
        t("toast.licenseFound", { file: hit.fileName }),
        t("toast.licenseFoundSub", { family: hit.family, ps: hit.postscript }),
        "install",
      );
      const map = await ipc.infoFiles(writableDirs);
      if (gen !== licenseReqGen.current) return;
      setLicenseFiles(flattenInfoFiles(map));
    } catch (e) {
      if (gen !== licenseReqGen.current) return;
      const raw = String(e);
      toast.error(
        t("toast.licenseFetchFailed"),
        /switched off/i.test(raw) ? t("toast.licenseNeedsOnline") : raw,
      );
    } finally {
      if (gen === licenseReqGen.current) setLicenseSearching(false);
    }
  };
  /**
   * 点一下版权文件名 → 用系统默认程序打开它。
   * 路径是「字面所在目录 + 文件名」拼出来的真实文件，后端还会再校验一次存在性。
   */
  const openLicenseFile = async (file: { dir: string; name: string }) => {
    try {
      await ipc.openLocalFile(joinPath(file.dir, file.name));
    } catch (e) {
      toast.error(t("toast.openFileFailed"), String(e));
    }
  };

  useEffect(() => {
    setFeatures([]);
    setFeatureOverrides({});
    if (!lead || lead.format === "woff" || lead.format === "woff2") return;
    let stale = false;
    ipc
      .getFeatures(lead.previewPath ?? lead.path, lead.faceIndex)
      .then((tags) => {
        if (!stale) setFeatures(tags.filter((t) => featureLabel(t) !== null));
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [lead?.id, lead?.path, lead?.faceIndex, lead?.format]);

  const featureSettings =
    Object.keys(featureOverrides).length > 0
      ? Object.entries(featureOverrides)
          .map(([tag, on]) => `"${tag}" ${on ? 1 : 0}`)
          .join(", ")
      : undefined;
  const conflicts = family ? conflictsFor(fonts).get(family.name) ?? [] : [];
  const snapshotToggles = snapshots.map((sn) => ({
    name: sn.name,
    on:
      !!family &&
      family.faces.length > 0 &&
      family.faces.every((f) => {
        const key = faceKey(f);
        return sn.entries.some((e) => e.key === key);
      }),
  }));

  const variation =
    lead && lead.isVariable && Object.keys(axisValues).length > 0
      ? lead.axes
          .map((a) => `"${a.tag}" ${axisValues[a.tag] ?? a.default}`)
          .join(", ")
      : undefined;
  const canUninstall = family?.faces.some((f) => f.source !== "system") ?? false;

  return (
    <AnimatePresence>
      {family && lead && (
        <motion.aside
          className="detail glass-e3"
          /* 宽度参与动画：0 → panelWidth 与主区域的收缩是同一帧、同一条曲线，
             不再是「左边一帧跳完、右边慢慢滑 300ms」。内容宽度单独锁在 --panel-w
             上，展开过程中只被裁出来、不重排换行。 */
          style={{ "--panel-w": `${panelWidth}px` } as CSSProperties}
          initial={intro ? { width: 0, opacity: 0 } : false}
          animate={{ width: panelWidth, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          /* 宽度变化用固定缓动而不是弹簧：布局动画上的回弹会让人看见列表「退半步再回来」 */
          transition={resizing || noMotion ? { duration: 0 } : intro ? easeTop : INTRO_OFF}
        >
          <div
            className="detail-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label={t("detail.resize")}
            onPointerDown={onResizeDown}
            onDoubleClick={() => setPanelWidth(348)}
          >
            <GripVertical size={12} strokeWidth={1.5} />
          </div>

          <motion.div
            ref={innerRef}
            className="detail-inner"
            /*
             * 只在「面板从无到有」时播一次 12 段 stagger（审计 P1-7）。
             *
             * 原来这里有 `key={family.name}`：每换一个族，整块内容卸载重建，
             * 12 段 y:10→0 从头再播一遍 —— 排版几乎没变，看起来是「整块在抖」。
             * 去掉 key 之后组件保持挂载，换族只是各段内容跟着更新。
             *
             * initial 必须受 intro 门控（同文件的 aside 一直是这么写的）：
             * 窗口形变期间挂载的话直接就位，别在窗口还在动的 260ms 里再叠一层入场。
             */
            initial={intro ? "hidden" : false}
            animate="show"
            /* 内容跟着外壳一起到位：原来 0.04 × N + 0.06 的延迟会让最后一块比面板
               晚 0.5 秒才出现，看起来像「壳先到、字后爬」。压到今天一条 300ms 的节奏里。 */
            variants={{ show: { transition: { staggerChildren: 0.012, delayChildren: 0 } } }}
          >
            <motion.header
              className="detail-head"
              variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring } }}
            >
              <FormatBadge format={family.formats[0]} isVariable={family.isVariable} />
              <button
                className="detail-title copy-name"
                onClick={() => copyName(family.name, t("copy.familyName"))}
                data-hint-text={t("detail.copyNameHint")}
              >
                {displayName(family)}
              </button>
              <StarRating
                family={family.name}
                iconSize={15}
                labels={{
                  add: t("detail.favorite"),
                  remove: t("detail.unfavorite"),
                }}
              />
              <button className="detail-close" aria-label={t("detail.close")} onClick={() => select(null)} data-hint="hint.closeDetail">
                <X size={15} strokeWidth={1.5} />
              </button>
            </motion.header>

            <motion.section
              className="detail-specimen"
              variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring } }}
            >
              <span
                className={`specimen-glyphs ${fontFamily ? "" : "is-font-pending"}`}
                style={{
                  fontFamily: fontFamily ?? undefined,
                  fontStyle: lead.italic ? "italic" : "normal",
                  fontVariationSettings: variation,
                }}
              >
                Aa
              </span>
              <span className="specimen-meta">
                <span className="specimen-style">{lead.style}</span>
                <span className="specimen-sub tabular">
                  {t("detail.stylesCount", { count: family.faces.length })} ·{" "}
                  {family.formats.join(" · ").toUpperCase()}
                </span>
              </span>
              <span
                className={`specimen-strip ${fontFamily ? "" : "is-font-pending"}`}
                aria-hidden="true"
                style={{
                  fontFamily: fontFamily ?? undefined,
                  fontStyle: lead.italic ? "italic" : "normal",
                  fontVariationSettings: variation,
                  fontFeatureSettings: featureSettings,
                }}
              >
                ABCDEFGHIJKLM abcdefghijklm 0123456789 ?!&
              </span>
            </motion.section>

            <motion.section
              className="detail-activate"
              variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring } }}
            >
              <div>
                <div className="activate-label">
                  {family.partial
                    ? t("detail.partial", { active: family.activeCount, total: family.faces.length })
                    : t(family.active ? "detail.active" : "detail.inactive")}
                </div>
                <div className="activate-sub">
                  {t(family.deactivatable ? "detail.visibleElsewhere" : "detail.systemFont")}
                </div>
              </div>
              <PillToggle
                on={family.active}
                mixed={family.partial}
                disabled={!family.deactivatable}
                onChange={(on) => void setFamilyActive(family.name, on)}
                label={t(family.active ? "card.deactivate" : "card.activate", { name: family.name })}
                size="lg"
              />
            </motion.section>

            {snapshots.length > 0 && (
              <motion.section
                className="detail-snapshot"
                variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring } }}
              >
                <div className="detail-heading">{t("detail.snapshotToggle")}</div>
                <div className="detail-snap-list">
                  {snapshotToggles.map((sn) => (
                    <div key={sn.name} className="detail-snap-row">
                      <span className="detail-snap-name" data-hint-text={sn.name}>
                        {sn.name}
                      </span>
                      <PillToggle
                        on={sn.on}
                        onChange={(next) => {
                          if (next !== sn.on)
                            void toggleFamilyInSnapshot(sn.name, family.name);
                        }}
                        label={t(sn.on ? "detail.snapRemove" : "detail.snapAdd", {
                          name: family.name,
                          snapshot: sn.name,
                        })}
                      />
                    </div>
                  ))}
                </div>
              </motion.section>
            )}

            <motion.section
              className="detail-waterfall"
              variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring } }}
            >
              {WATERFALL.map((px) => (
                <p
                  key={px}
                  className="waterfall-line"
                  style={{
                    fontFamily: fontFamily ?? undefined,
                    fontSize: px,
                    fontStyle: lead.italic ? "italic" : "normal",
                    fontVariationSettings: variation,
                    fontFeatureSettings: featureSettings,
                  }}
                >
                  <span className="waterfall-px tabular">{px}</span>
                  {text}
                </p>
              ))}
            </motion.section>

            {lead.isVariable && lead.axes.length > 0 && (
              <motion.section
                variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring } }}
              >
                <div className="detail-heading">{t("detail.variableAxes")}</div>
                <AxisSliders
                  axes={lead.axes}
                  values={axisValues}
                  onChange={(tag, v) => setAxisValues((prev) => ({ ...prev, [tag]: v }))}
                  onReset={() => setAxisValues({})}
                />
              </motion.section>
            )}

            {features.length > 0 && (
              <motion.section
                variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring } }}
              >
                <div className="detail-heading">{t("detail.openTypeFeatures")}</div>
                <FeatureChips
                  features={features}
                  overrides={featureOverrides}
                  onToggle={(tag) => {
                    const on = featureOverrides[tag] ?? DEFAULT_ON.has(tag);
                    const next = !on;
                    setFeatureOverrides((prev) => {
                      const copy = { ...prev };
                      if (next === DEFAULT_ON.has(tag)) delete copy[tag];
                      else copy[tag] = next;
                      return copy;
                    });
                  }}
                  onReset={() => setFeatureOverrides({})}
                />
              </motion.section>
            )}

            <motion.section
              className="detail-meta"
              variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring } }}
            >
              <dl>
                <dt>{t("detail.styles")}</dt>
                <dd className="tabular">{family.faces.length}</dd>
                <dt>{t("detail.format")}</dt>
                <dd>{family.formats.join(", ").toUpperCase()}</dd>
                {family.classification !== "unknown" && (
                  <>
                    <dt>{t("detail.class")}</dt>
                    <dd>{t(`class.${family.classification}`)}</dd>
                  </>
                )}
                {os2 && (
                  <>
                    <dt>{t("detail.os2Class")}</dt>
                    {/* 类名保持 OS/2 原文（Oldstyle Serifs / Slab Serifs…）：翻成中文
                        「旧体衬线」只会让用户更难跟字体册、Suitcase 的界面逐字对上。 */}
                    <dd data-hint-text={t("detail.os2ClassHint")}>
                      {os2.label}
                      <span className="detail-os2-id tabular">{os2.id}</span>
                    </dd>
                  </>
                )}
                {family.scripts.length > 0 && (
                  <>
                    <dt>{t("detail.scripts")}</dt>
                    <dd>{family.scripts.map(scriptLabel).join(", ")}</dd>
                  </>
                )}
                {family.glyphCount > 0 && (
                  <>
                    <dt>{t("detail.glyphCount")}</dt>
                    <dd className="tabular">{family.glyphCount.toLocaleString()}</dd>
                  </>
                )}
                {charset && charset.total > 0 && (
                  <>
                    <dt>{t("detail.charset")}</dt>
                    <dd className="tabular">
                      {t("detail.charsetValue", {
                        total: charset.total.toLocaleString(),
                        han: charset.han.toLocaleString(),
                      })}
                    </dd>
                  </>
                )}
                <dt>{t("detail.fileSize")}</dt>
                <dd className="tabular">{formatBytes(family.totalSize)}</dd>
                {family.foundry && (
                  <>
                    <dt>{t("detail.foundry")}</dt>
                    <dd>{family.foundry}</dd>
                  </>
                )}
                {lead.postscriptName && (
                  <>
                    <dt>{t("detail.postscript")}</dt>
                    <dd>
                      <button
                        className="detail-mono copy-name"
                        onClick={() =>
                          copyName(lead.postscriptName as string, t("copy.postscriptName"))
                        }
                        data-hint-text={t("detail.copyNameHint")}
                      >
                        {lead.postscriptName}
                      </button>
                    </dd>
                  </>
                )}
                <dt>{t("detail.licenseFile")}</dt>
                <dd className="license-file-cell">
                  {licenseFiles === null ? (
                    <span className="license-file-pending">…</span>
                  ) : licenseFiles.length > 0 ? (
                    <span className="license-file-names detail-mono">
                      {licenseFiles.map((f) => (
                        <button
                          key={`${f.dir}|${f.name}`}
                          type="button"
                          className="license-file-link"
                          data-hint-text={t("detail.licenseFileOpen", { file: f.name })}
                          onClick={() => void openLicenseFile(f)}
                        >
                          {f.name}
                        </button>
                      ))}
                    </span>
                  ) : writableDirs.length === 0 ? (
                    <span className="license-file-missing">{t("detail.licenseFileSystem")}</span>
                  ) : (
                    <span className="license-file-actions">
                      <span
                        className={embeddedCopyright ? "license-file-embedded" : "license-file-missing"}
                        title={embeddedCopyright || undefined}
                      >
                        {embeddedCopyright ? t("detail.licenseEmbedded") : t("detail.licenseFileNone")}
                      </span>
                      <button
                        className="license-file-search"
                        onClick={() => void searchLicense()}
                        disabled={licenseSearching}
                        data-hint-text={t("detail.licenseSearchHint")}
                      >
                        <Search size={11} strokeWidth={1.5} />
                        {licenseSearching ? t("detail.licenseSearching") : t("detail.licenseSearch")}
                      </button>
                    </span>
                  )}
                </dd>
                <dt>{t("detail.location")}</dt>
                <dd className="detail-path">
                  <button
                    className="path-link detail-mono"
                    onClick={() =>
                      revealItemInDir(lead.path).catch(() => toast.error(t("toast.couldntOpenFileManager")))
                    }
                    data-hint-text={lead.path}
                  >
                    <FolderOpen size={11} strokeWidth={1.5} />
                    <span>{lead.path}</span>
                  </button>
                </dd>
                {family.isVariable && lead.axes.length > 0 && (
                  <>
                    <dt>{t("detail.axes")}</dt>
                    <dd>
                      {lead.axes
                        .map((a) => `${a.tag} ${a.min}–${a.max}`)
                        .join(", ")}
                    </dd>
                  </>
                )}
              </dl>
            </motion.section>

            <motion.section
              variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring } }}
            >
              <div className="detail-heading detail-heading-row">
                <span>{t("detail.styles")}</span>
                <button
                  data-hint="hint.exportFace"
                  className="detail-heading-action"
                  onClick={() => void exportFamily(family, lead?.path)}
                >
                  <Download size={12} strokeWidth={1.5} />
                  {t("detail.exportAll")}
                </button>
              </div>
              <div className="style-list">
                {(family.uniqueFaces ?? family.faces).map((face) => (
                  <StyleRow
                    key={face.id}
                    face={face}
                    family={family.name}
                    familyData={family}
                    selected={lead?.id === face.id}
                    onSelect={() => setStyleId(face.id)}
                    synthesize={family.faces.filter((f) => f.path === face.path).length > 1}
                  />
                ))}
              </div>
            </motion.section>

            {conflicts.length > 0 && (
              <motion.section
                className="conflict-section"
                variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring } }}
              >
                <div className="conflict-title">
                  <AlertTriangle size={13} strokeWidth={1.5} />
                  {t("detail.conflictTitle")}
                </div>
                <p className="conflict-sub">{t("detail.conflictBody")}</p>
                {conflicts.map((c) => (
                  <div key={c.key} className="conflict-group">
                    <span className="conflict-key detail-mono">{c.key}</span>
                    {c.paths.map((p) => (
                      <ConflictFileCard key={p} path={p} />
                    ))}
                  </div>
                ))}
              </motion.section>
            )}

            <motion.section
              variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring } }}
            >
              <div className="detail-heading detail-heading-row">
                <span>{t("detail.glyphs")}</span>
                <span className="detail-heading-note">
                  <Copy size={10} strokeWidth={1.5} /> {t("detail.clickToCopy")}
                </span>
              </div>
              <GlyphMap face={lead} fontFamily={fontFamily} variation={variation} />
            </motion.section>

            {lead.copyright && (
              <motion.section
                variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring } }}
              >
                <div className="detail-heading">{t("detail.copyright")}</div>
                <p className="detail-copyright-text">{lead.copyright}</p>
              </motion.section>
            )}

            <CopyrightStatusSection family={family.name} />

            {(lead.license || lead.licenseUrl) && (
              <motion.section
                variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring } }}
              >
                <div className="detail-heading">{t("detail.license")}</div>
                <LicenseSection family={family.name} license={lead.license} licenseUrl={lead.licenseUrl} />
              </motion.section>
            )}

            <motion.section
              variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring } }}
            >
              <div className="detail-heading">{t("detail.tags")}</div>
              <TagEditor family={family.name} tags={family.tags} autoTags={family.autoTags} />
            </motion.section>

            <motion.section
              variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring } }}
            >
              <div className="detail-heading">{t("detail.notes")}</div>
              <NoteEditor family={family.name} />
            </motion.section>

            {canUninstall && (
              <motion.button
                data-hint="hint.uninstall"
                className="detail-uninstall"
                onClick={() => void uninstallFamily(family.name)}
                variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring } }}
                whileHover={{ y: -1, transition: spring }}
                whileTap={{ scale: 0.97, transition: springSnappy }}
              >
                <Trash2 size={14} strokeWidth={1.5} />
                {t("detail.moveToTrash")}
              </motion.button>
            )}
          </motion.div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
