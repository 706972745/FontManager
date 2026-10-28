import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Camera, ChevronRight, Folder, Lock, MoreHorizontal, Star } from "lucide-react";
import { memo, useState } from "react";
import { PillToggle } from "../design/primitives/PillToggle";
import { spring, springSnappy, springSoft, staggerDelay } from "../design/springs";
import { useFontCss } from "../lib/fontLoader";
import { buildFaceMenu, buildFamilyMenu } from "../lib/menus";
import { openContextMenu, openContextMenuAt } from "../design/primitives/ContextMenu";
import { useCjkFlag } from "../lib/cjk";
import { activeConflictsFor, conflictsFor, SIZES, useFontStore, type Family } from "../state/fontStore";
import { copyrightExpired, effectiveCopyrightClass } from "../lib/license";
import { useFamilyMembership } from "../lib/membership";
import { playStar } from "../lib/sound";
import type { FontFace } from "../lib/ipc";
import { useT, type TKey } from "../lib/i18n";
import { INTRO_OFF, useIntro } from "../lib/useIntro";

export function FormatBadge({ format, isVariable }: { format: string; isVariable: boolean }) {
  if (isVariable) return <span className="badge badge-variable">VAR</span>;
  return <span className={`badge badge-${format}`}>{format.toUpperCase()}</span>;
}

function FacePreview({
  family,
  face,
  text,
  size,
  index,
  synthesize,
  onHover,
}: {
  /** 字族：字重菜单里要带上字族名（显示与复制都用得上） */
  family: Family;
  face: FontFace;
  text: string;
  size: number;
  index: number;
  synthesize: boolean;
  /** 鼠标进入 / 离开这一行：卡片大预览临时切到这个字重，离开恢复 Regular */
  onHover: (faceId: string | null) => void;
}) {
  const t = useT();
  const intro = useIntro();
  const { fontFamily, failed } = useFontCss(face);
  // 这个字重里有没有汉字：没有的话应用后中文不会变，得提前说清楚
  const hasCjk = useCjkFlag(face);
  // 少数老字体的 name 表里 style 是空的，直接渲染会是一行空白（看着像坏了）
  const styleLabel = face.style?.trim() || face.postscriptName || "Regular";
  return (
    <motion.div
      className="face-row"
      // 交互都是被动的：悬停高亮 + 大预览临时切到这个字重（移开恢复），
      // 右击弹该字重自己的菜单。「点一下切换主预览」这层交互用户反馈不要（0.9.2-6）。
      onMouseEnter={() => onHover(face.id)}
      onMouseLeave={() => onHover(null)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu(e, buildFaceMenu(family, face));
      }}
      initial={intro ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={intro ? { ...spring, delay: staggerDelay(index) } : INTRO_OFF}
    >
      <span className="face-marker" aria-hidden="true" />
      <span className="face-style">
        <span className="face-style-name">{styleLabel}</span>
      </span>
      <AnimatePresence mode="wait">
        {fontFamily ? (
          <motion.span
            key="real"
            className="face-sample"
            style={{
              fontFamily,
              fontSize: Math.min(size, 32),
              fontStyle: face.italic ? "italic" : "normal",

              fontWeight: synthesize ? face.weight : undefined,
            }}
            initial={intro ? { opacity: 0, y: 4 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={intro ? spring : INTRO_OFF}
          >
            {text}
          </motion.span>
        ) : failed ? (
          <span key="failed" className="face-sample face-failed">
            {t("card.previewUnavailable")}
          </span>
        ) : (
          <motion.span
            key="skeleton"
            className="skeleton face-skeleton"
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
          />
        )}
      </AnimatePresence>
      <span className="face-tail">
        {hasCjk === false && (
          <span className="cjk-chip" title={t("card.noCjkTitle")}>
            {t("card.noCjk")}
          </span>
        )}
        {/* 每个字重单独一份操作：应用到 PS / AI / CDR、复制字体全名 / PostScript 名 */}
        <button
          type="button"
          className="face-actions"
          aria-label={t("menu.faceActions", { name: styleLabel })}
          title={t("menu.faceActions", { name: styleLabel })}
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            openContextMenuAt(r.left, r.bottom + 4, buildFaceMenu(family, face));
          }}
        >
          <MoreHorizontal size={14} strokeWidth={1.75} />
        </button>
      </span>
    </motion.div>
  );
}

export const FamilyCard = memo(function FamilyCard({ family }: { family: Family }) {
  const t = useT();
  const intro = useIntro();
  const sampleText = useFontStore((s) => s.sampleText);
  const sizeIndex = useFontStore((s) => s.sizeIndex);
  const setFamilyActive = useFontStore((s) => s.setFamilyActive);
  const selectWith = useFontStore((s) => s.selectWith);
  const selected = useFontStore((s) => s.selection.includes(family.name));
  const favorite = useFontStore((s) => s.favorites.includes(family.name));
  const toggleFavorite = useFontStore((s) => s.toggleFavorite);
  const hasActiveConflict = useFontStore((s) => activeConflictsFor(s.fonts).has(family.name));
  const hasDormantConflict = useFontStore((s) => conflictsFor(s.fonts).has(family.name));
  const { inSnapshots, inCollections } = useFamilyMembership(family.name);
  const copyrightOverride = useFontStore((s) => s.copyrightStatus[family.name]);
  const copyrightExpiry = useFontStore((s) => s.copyrightExpiry[family.name]);
  const [expanded, setExpanded] = useState(false);
  /** 鼠标正悬停的字重行：大预览临时用它渲染，移开恢复 Regular（不持久，纯跟随鼠标） */
  const [hoverFaceId, setHoverFaceId] = useState<string | null>(null);

  const size = SIZES[sizeIndex];
  const lead = family.faces.find((f) => f.style === "Regular") ?? family.faces[0];
  const previewFace = family.faces.find((f) => f.id === hoverFaceId) ?? lead;
  const { fontFamily, failed } = useFontCss(previewFace);
  const text = sampleText.trim() || family.name;
  // 权重：手动设置 > 字体自带版权信息 > 文件夹备注 / 版权信息文件判定的版权
  const licCls = effectiveCopyrightClass(
    lead.license ?? null,
    copyrightOverride,
    lead.copyrightClass ?? null,
  );
  const licExpired = licCls === "timelimited" && copyrightExpired(copyrightExpiry);
  const licKey = `copyright.${licCls}` as TKey;
  const licTitle = licExpired
    ? `${t("copyright.expiryDate")}: ${copyrightExpiry} — ${t("copyright.expired")}`
    : licCls === "timelimited" && copyrightExpiry
      ? `${t("copyright.expiryDate")}: ${copyrightExpiry}`
      : t("detail.copyright");

  return (
    <motion.article
      className={`family-card ${selected ? "card-selected" : ""}`}
      data-family={family.name}
      tabIndex={0}
      role="button"
      aria-label={family.name}
      aria-pressed={selected}
      onClick={(e) => {
        const st = useFontStore.getState();

        if (st.comparePicking) {
          st.togglePick(family.name);
          return;
        }
        const mode = e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "range" : "single";
        selectWith(family.name, mode, st.visibleOrder);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" || e.target !== e.currentTarget) return;
        e.preventDefault();
        selectWith(family.name, "single", useFontStore.getState().visibleOrder);
      }}
      onContextMenu={(e) => openContextMenu(e, buildFamilyMenu(family))}

      animate={{ scale: family.active ? 1 : 0.99 }}
      whileHover={{ y: -1 }}
      whileTap={{ scale: family.active ? 0.99 : 0.98 }}
      transition={spring}
      layout="position"
    >
      <header className="card-head">
        <FormatBadge format={family.formats[0]} isVariable={family.isVariable} />
        <span className="card-name">{family.name}</span>
        {family.faces.length > 1 && (
          <motion.button
            className="card-expand"
            aria-label={t(expanded ? "card.collapseStyles" : "card.expandStyles")}
            aria-expanded={expanded}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.94 }}
          >
            <motion.span
              className="chevron"
              animate={{ rotate: expanded ? 90 : 0 }}
              transition={springSnappy}
            >
              <ChevronRight size={13} strokeWidth={1.5} />
            </motion.span>
            <span className="tabular">
              {t("card.stylesCount", { count: family.faces.length })}
            </span>
          </motion.button>
        )}
        <span className="card-spacer" />
        <span
          className={`lic-chip lic-${licCls} ${licExpired ? "lic-expired" : ""}`}
          title={licTitle}
        >
          {t(licKey)}
        </span>
        {hasActiveConflict ? (
          <span
            className="conflict-badge"
            title=""
            aria-label={t("card.conflict")}
          >
            <AlertTriangle size={13} strokeWidth={1.5} />
          </span>
        ) : (
          hasDormantConflict && (
            <span
              className="conflict-badge conflict-badge-dormant"
              title=""
              aria-label={t("card.conflictResolved")}
            >
              <AlertTriangle size={13} strokeWidth={1.5} />
            </span>
          )
        )}
        <motion.button
          className={`star-btn ${favorite ? "star-on" : ""}`}
          aria-label={t(favorite ? "card.unfavorite" : "card.favorite", { name: family.name })}
          aria-pressed={favorite}
          onClick={(e) => {
            e.stopPropagation();
            playStar(!favorite);
            void toggleFavorite(family.name);
          }}
          whileTap={{ scale: 0.85 }}
        >
          <Star size={14} strokeWidth={1.5} />
        </motion.button>
        {family.deactivatable ? (
          <PillToggle
            on={family.active}
            mixed={family.partial}
            onChange={(on) => void setFamilyActive(family.name, on)}
            label={t(family.active ? "card.deactivate" : "card.activate", { name: family.name })}
          />
        ) : (
          <span className="card-os-lock" title={t("card.osManaged")} aria-label={t("card.osManaged")}>
            <Lock size={11} strokeWidth={1.75} />
            {t("card.osManagedShort")}
          </span>
        )}
      </header>

      {(inSnapshots.length > 0 || inCollections.length > 0) && (
        <div className="card-members" onClick={(e) => e.stopPropagation()}>
          {inSnapshots.map((n) => (
            <span
              key={`snap-${n}`}
              className="member-chip member-chip-snap"
              title={t("card.inSnapshot", { name: n })}
            >
              <Camera size={10} strokeWidth={1.75} />
              {n}
            </span>
          ))}
          {inCollections.map((n) => (
            <span
              key={`coll-${n}`}
              className="member-chip member-chip-coll"
              title={t("card.inCollection", { name: n })}
            >
              <Folder size={10} strokeWidth={1.75} />
              {n}
            </span>
          ))}
        </div>
      )}

      <div className="card-preview" style={{ minHeight: size * 1.35 }}>
        <AnimatePresence mode="wait">
          {fontFamily ? (
            <motion.p
              key="real"
              className="preview-text"
              style={{
                fontFamily,
                fontSize: size,
                fontStyle: previewFace.italic ? "italic" : "normal",
                fontWeight: previewFace === lead ? undefined : previewFace.weight,
              }}
              initial={intro ? { opacity: 0, y: 5 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={intro ? spring : INTRO_OFF}
            >
              {text}
            </motion.p>
          ) : failed ? (
            <p key="failed" className="preview-text preview-failed">
              {t("card.noPreview")}
            </p>
          ) : (
            <motion.span
              key="skeleton"
              className="skeleton preview-skeleton"
              style={{ height: size * 1.1 }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
            />
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            className="card-styles"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0, transition: { ...springSnappy } }}
            transition={springSoft}
          >
            {family.faces.map((face, i) => (
              <FacePreview
                key={face.id}
                family={family}
                face={face}
                text={text}
                size={size}
                index={i}
                synthesize={family.faces.filter((f) => f.path === face.path).length > 1}
                onHover={setHoverFaceId}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  );
});
