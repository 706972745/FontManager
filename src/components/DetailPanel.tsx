import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Copy, Download, ExternalLink, FolderOpen, GripVertical, MoreHorizontal, Plus, RotateCcw, Scale, Search, Star, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { PillToggle } from "../design/primitives/PillToggle";
import { easeTop, spring } from "../design/springs";
import { useFontCss, formatBytes, pathBasename } from "../lib/fontLoader";
import { familiesFor, conflictsFor, useFontStore, type Family } from "../state/fontStore";
import { ipc, type CharsetStats, type FontFace, type VariationAxis } from "../lib/ipc";
import { toast } from "../design/primitives/Toast";
import { FormatBadge } from "./FamilyCard";
import { buildFaceMenu, exportFace, exportFamily } from "../lib/menus";
import { openContextMenuAt } from "../design/primitives/ContextMenu";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { classifyLicense, copyrightExpired, normalizeCopyright } from "../lib/license";
import { faceKey } from "../lib/snapshotKey";
import { parentDir } from "../lib/onlineCoverage";
import { playStar, playTag } from "../lib/sound";
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

const WATERFALL = [14, 20, 28, 40, 56];

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
      whileTap={{ scale: 0.99 }}
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
        whileTap={{ scale: 0.9 }}
      >
        <Download size={13} strokeWidth={1.5} />
      </motion.span>
      {/* 字重自己的操作菜单：单独应用到 PS / AI / CDR、复制字体名 / PostScript 名 */}
      <motion.span
        role="button"
        tabIndex={0}
        className="style-export"
        aria-label={t("menu.faceActions", { name: face.style })}
        title={t("menu.faceActions", { name: face.style })}
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
        whileTap={{ scale: 0.9 }}
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
              title={tag}
              onClick={() => onToggle(tag)}
              whileTap={{ scale: 0.96 }}
            >
              {featureLabel(tag)}
            </motion.button>
          );
        })}
      </div>
      {dirty && (
        <button className="feat-reset" onClick={onReset}>
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
        <button className="detail-heading-action axis-reset" onClick={onReset}>
          <RotateCcw size={11} strokeWidth={1.5} />
          {t("detail.reset")}
        </button>
      )}
    </div>
  );
}

const charsetCache = new Map<string, number[]>();
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
        <button className="glyph-more" onClick={() => setShowAll(true)}>
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

const COPYRIGHT_STATUS_OPTIONS = ["auto", "free_commercial", "free_personal", "paid", "timelimited"] as const;

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
            key={opt}
            role="radio"
            aria-checked={status === opt}
            tabIndex={status === opt ? 0 : -1}
            className={`copyright-status-btn ${status === opt ? "copyright-status-active" : ""}`}
            onClick={() => setCopyrightStatus(family, opt)}
          >
            {t(`copyright.${opt}`)}
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
          {expiry && (
            <button
              className="copyright-expiry-clear"
              onClick={() => setCopyrightExpiry(family, null)}
              aria-label={t("copyright.clearExpiry")}
              title={t("copyright.clearExpiry")}
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

function LicenseSection({ license, licenseUrl }: { license: string | null; licenseUrl: string | null }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  if (!license && !licenseUrl) return null;
  const cls = classifyLicense(license);
  const label = t(`license.${cls}`);
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

function TagEditor({ family, tags }: { family: string; tags: string[] }) {
  const t = useT();
  const setFamilyTags = useFontStore((s) => s.setFamilyTags);
  const [draft, setDraft] = useState("");

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
        {tags.map((tag) => (
          <motion.span
            key={tag}
            className="tag-chip"
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={spring}
            layout
          >
            {tag}
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
        ))}
      </AnimatePresence>
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
          <Plus size={13} strokeWidth={1.5} />
        </button>
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
        title={path}
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
  const setPanelWidth = useFontStore((s) => s.setPanelWidth);
  const dragging = useRef(false);
  /** 正在拖左边缘调宽：此时宽度必须实时跟手，不能再走弹簧（会拖出「粘手」感） */
  const [resizing, setResizing] = useState(false);
  /** 拖宽时挂上的监听清理函数：pointercancel / 卸载时统一收掉 */
  const dragCleanup = useRef<(() => void) | null>(null);

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
  useEffect(() => {
    setStyleId(null);
    setAxisValues({});
    setFeatureOverrides({});
  }, [selectedFamily]);

  const favorites = useFontStore((s) => s.favorites);
  const toggleFavorite = useFontStore((s) => s.toggleFavorite);
  const snapshots = useFontStore((s) => s.snapshots);
  const toggleFamilyInSnapshot = useFontStore((s) => s.toggleFamilyInSnapshot);

  const lead =
    family?.faces.find((f) => f.id === styleId) ??
    family?.faces.find((f) => f.style === "Regular") ??
    family?.faces[0] ??
    null;
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
  const favorite = family ? favorites.includes(family.name) : false;
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
          transition={resizing ? { duration: 0 } : intro ? easeTop : INTRO_OFF}
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
            key={family.name}
            className="detail-inner"
            initial="hidden"
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
                title={t("detail.copyNameHint")}
              >
                {displayName(family)}
              </button>
              <motion.button
                className={`star-btn ${favorite ? "star-on" : ""}`}
                aria-label={t(favorite ? "detail.unfavorite" : "detail.favorite")}
                aria-pressed={favorite}
                onClick={() => {
                  playStar(!favorite);
                  void toggleFavorite(family.name);
                }}
                whileTap={{ scale: 0.85 }}
              >
                <Star size={15} strokeWidth={1.5} />
              </motion.button>
              <button className="detail-close" aria-label={t("detail.close")} onClick={() => select(null)}>
                <X size={15} strokeWidth={1.5} />
              </button>
            </motion.header>

            <motion.section
              className="detail-specimen"
              variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring } }}
            >
              <span
                className="specimen-glyphs"
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
                className="specimen-strip"
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
                      <span className="detail-snap-name" title={sn.name}>
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
                        title={t("detail.copyNameHint")}
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
                          title={t("detail.licenseFileOpen", { file: f.name })}
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
                      <span className="license-file-missing">{t("detail.licenseFileNone")}</span>
                      <button
                        className="license-file-search"
                        onClick={() => void searchLicense()}
                        disabled={licenseSearching}
                        title={t("detail.licenseSearchHint")}
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
                    title={lead.path}
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
                  className="detail-heading-action"
                  onClick={() => void exportFamily(family)}
                >
                  <Download size={12} strokeWidth={1.5} />
                  {t("detail.exportAll")}
                </button>
              </div>
              <div className="style-list">
                {family.faces.map((face) => (
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
                <LicenseSection license={lead.license} licenseUrl={lead.licenseUrl} />
              </motion.section>
            )}

            <motion.section
              variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring } }}
            >
              <div className="detail-heading">{t("detail.tags")}</div>
              <TagEditor family={family.name} tags={family.tags} />
            </motion.section>

            <motion.section
              variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring } }}
            >
              <div className="detail-heading">{t("detail.notes")}</div>
              <NoteEditor family={family.name} />
            </motion.section>

            {canUninstall && (
              <motion.button
                className="detail-uninstall"
                onClick={() => void uninstallFamily(family.name)}
                variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: spring } }}
                whileHover={{ y: -1 }}
                whileTap={{ scale: 0.97 }}
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
