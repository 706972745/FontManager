import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, ChevronRight, Lock, Star } from "lucide-react";
import { memo, useMemo, useState, type CSSProperties } from "react";
import { PillToggle } from "../design/primitives/PillToggle";
import { spring, springSnappy, springSoft } from "../design/springs";
import { useFontCss } from "../lib/fontLoader";
import { buildFamilyMenu } from "../lib/menus";
import { openContextMenu } from "../design/primitives/ContextMenu";
import { hasScriptNote, useScriptStatus } from "../lib/scriptCoverage";
import { useCjkSibling } from "../lib/cjkSiblings";
import { ScriptChip } from "./ScriptChip";
import { FaceLine, faceLineFontSize } from "./FaceLine";
import { MemberChip } from "./MemberChip";
import { activeConflictsFor, conflictsFor, SIZES, useFontStore, type Family } from "../state/fontStore";
import { copyrightExpired } from "../lib/license";
import { familyCopyrightClass } from "../lib/license";
import { useFamilyMembership } from "../lib/membership";
import { faceKey } from "../lib/snapshotKey";
import { collectionFaceScope } from "../lib/collectionScope";
import { styleScope, styleScopeLabel } from "../lib/styleScope";
import { playStar } from "../lib/sound";
import type { FontFace } from "../lib/ipc";
import { useT, type TKey } from "../lib/i18n";
import { useDisplayName } from "../lib/displayName";
import { INTRO_OFF, useIntro } from "../lib/useIntro";

export function FormatBadge({ format, isVariable }: { format: string; isVariable: boolean }) {
  if (isVariable) return <span className="badge badge-variable">VAR</span>;
  return <span className={`badge badge-${format}`}>{format.toUpperCase()}</span>;
}

/** 卡片展开后的字重行：和速览界面共用 FaceLine，两处长得一模一样 */
function FacePreview({
  family,
  face,
  probeText,
  index,
  onHover,
}: {
  /** 字族：字重菜单里要带上字族名（显示与复制都用得上） */
  family: Family;
  face: FontFace;
  /** 用来判断「缺哪种语言文字」的原始示例文字（空串 = 用户没输入，不标注） */
  probeText: string;
  index: number;
  /** 鼠标进入 / 离开这一行：卡片大预览临时切到这个字重，离开恢复 Regular */
  onHover: (faceId: string | null) => void;
}) {
  return (
    <FaceLine
      family={family}
      face={face}
      probeText={probeText}
      onHover={onHover}
      animate
      index={index}
    />
  );
}

export const FamilyCard = memo(function FamilyCard({ family }: { family: Family }) {
  const t = useT();
  // 显示名按界面语言取（有中文名就显示中文名），family.name 仍然是数据主键
  const displayName = useDisplayName();

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
  const { snapshotBadges, collectionBadges } = useFamilyMembership(family.name, family.faces);
  const copyrightOverride = useFontStore((s) => s.copyrightStatus[family.name]);
  const copyrightExpiry = useFontStore((s) => s.copyrightExpiry[family.name]);
  const [expanded, setExpanded] = useState(false);
  /** 鼠标正悬停的字重行：大预览临时用它渲染，移开恢复 Regular（不持久，纯跟随鼠标） */
  const [hoverFaceId, setHoverFaceId] = useState<string | null>(null);
  const nav = useFontStore((s) => s.nav);
  const snapshots = useFontStore((s) => s.snapshots);
  const collectionFaces = useFontStore((s) => s.collectionFaces);
  const collections = useFontStore((s) => s.collections);

  /**
   * 分组 / 快照里只放了这一族的**部分字重**时，展开后的字重列表只显示那几个。
   *
   * 用户 2026-10-31：「如果是单独加入了字重到分组或者快照中，这里应该只显示单独加入的字重，
   * 上面保持不变」—— 卡片头部（名称、标签、N 种样式）说的是这个字族本身，不动；
   * 只把展开后的字重列表收窄，否则「只加了一个 Bold」看起来像整族都进去了。
   */
  const shownFaces = useMemo(() => {
    const norm = (s: string) => (s ?? "").trim().toLowerCase();
    let keep: Set<string> | null = null;
    if (nav.kind === "snapshot") {
      const snap = snapshots.find((s) => s.name === nav.name);
      if (snap) {
        const keys = new Set(snap.entries.map((e) => e.key));
        const styles = new Set(
          snap.entries.filter((e) => e.family === family.name).map((e) => norm(e.style)),
        );
        const hit = family.faces.filter(
          (f) => keys.has(faceKey(f)) || (!!f.style && styles.has(norm(f.style))),
        );
        if (hit.length > 0 && hit.length < family.faces.length) {
          keep = new Set(hit.map((f) => f.id));
        }
      }
    } else if (nav.kind === "collection") {
      // 整族已经在组里时显示整族；只有「整族不在组里、只加了部分字重」才收窄。
      // 0.9.9-13 只看字重成员，先加「標準體」再加整族会让整族被错误收窄（BUG-2）。
      keep = collectionFaceScope(
        family.name,
        family.faces,
        faceKey,
        collectionFaces[nav.name] ?? [],
        collections[nav.name] ?? [],
      );
    }
    return keep ? family.faces.filter((f) => keep!.has(f.id)) : family.faces;
  }, [nav, snapshots, collectionFaces, collections, family.faces, family.name]);

  /**
   * 这个字族是不是「只启用了其中几个字重」（0.9.9-13）。
   *
   * 用户 2026-10-31：「如果单独启用了哪一个字体，最好是让用户知道字重单独启用了」——
   * 单独启用一个字重只改文件级启停，卡片看上去和「整族启用」没区别，容易误判。
   * 口径跟详情面板的「部分启用 · x/y 个样式」一致（`family.activeCount` / `faces.length`），
   * 免得同一屏出现两个不一样的数。
   */
  const onCount = family.activeCount ?? family.faces.filter((f) => f.active).length;
  const partial = onCount > 0 && onCount < family.faces.length;

  /**
   * 「N 种样式」的数字口径（用户 2026-10-31：快照里只有 1 个字重，头部却写「4 种样式」）。
   * 收窄时写「1/4 种样式」，全部字重都在时才写「4 种样式」。
   */
  const scope = useMemo(() => styleScope(shownFaces, family.faces), [shownFaces, family.faces]);

  const size = SIZES[sizeIndex];  const lead = family.faces.find((f) => f.style === "Regular") ?? family.faces[0];
  // 示例文字用到哪些语言文字、这款字体画不画得出（用户没输入时不标注）
  const probeText = sampleText.trim();
  const scriptStatus = useScriptStatus(lead, probeText);
  // 整族一个汉字都没有时，去同名前缀的兄弟家族里找有没有中文版（鸿蒙那种拆包字体）。
  // 只有真的缺中文才查，中文家族根本不会走到这里。
  const needsCjkSibling = !!scriptStatus?.missing.includes("han");
  const cjkSibling = useCjkSibling(family.name, needsCjkSibling);
  const scriptHint = cjkSibling ? t("card.seeCjkVersion", { family: cjkSibling }) : null;
  const previewFace = family.faces.find((f) => f.id === hoverFaceId) ?? lead;
  const { fontFamily, failed } = useFontCss(previewFace);
  const text = sampleText.trim() || family.name;
  // 权重：手动设置 > 字体自带版权信息 > 文件夹备注 / 版权信息文件判定的版权
  // 与筛选同一口径（`familyCopyrightClass`），否则「勾了商用免费却筛出标着未知的卡」
  const licCls = familyCopyrightClass(family.faces, copyrightOverride);
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
        <span className="card-name">{displayName(family)}</span>
        {/* 字面级损坏：部分字重坏了要标出来，但字族本身还能用 */}
        {family.brokenFaces > 0 && (
          <span className="card-broken" data-hint-text={family.incompleteReason ?? undefined}>
            {family.brokenAll
              ? t("card.brokenAll")
              : t("card.brokenSome", { count: family.brokenFaces, total: family.faces.length })}
          </span>
        )}
        {scope.total > 1 && (
          <motion.button
            data-hint={partial ? "hint.partialStyles" : "hint.expandStyles"}
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
              {/* 同名字面在系统 + 库里各一份时只算一种样式，否则会写「6 种样式」实际只有 3 种；
                  被快照 / 分组收窄时写「1/4 种样式」，与下面实际列出的行数对上 */}
              {styleScopeLabel(
                scope,
                partial ? { active: onCount, total: family.faces.length } : null,
                {
                  scoped: (shown, total) => t("card.stylesScoped", { shown, total }),
                  partial: (active, total) => t("card.stylesPartial", { active, total }),
                  count: (count) => t("card.stylesCount", { count }),
                },
              )}
            </span>
          </motion.button>
        )}
        <span className="card-spacer" />
        <span
          className={`lic-chip lic-${licCls} ${licExpired ? "lic-expired" : ""}`}
          data-hint-text={licTitle}
        >
          {t(licKey)}
        </span>
        {hasActiveConflict ? (
          <span
            className="conflict-badge"
           
            aria-label={t("card.conflict")}
          >
            <AlertTriangle size={13} strokeWidth={1.5} />
          </span>
        ) : (
          hasDormantConflict && (
            <span
              className="conflict-badge conflict-badge-dormant"
             
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
          <span className="card-os-lock" data-hint-text={t("card.osManaged")} aria-label={t("card.osManaged")}>
            <Lock size={11} strokeWidth={1.75} />
            {t("card.osManagedShort")}
          </span>
        )}
      </header>

      {(snapshotBadges.length > 0 || collectionBadges.length > 0) && (
        <div className="card-members" onClick={(e) => e.stopPropagation()}>
          {snapshotBadges.map((b) => (
            <MemberChip key={`snap-${b.name}`} badge={b} kind="snap" />
          ))}
          {collectionBadges.map((b) => (
            <MemberChip key={`coll-${b.name}`} badge={b} kind="coll" />
          ))}
        </div>
      )}

      <div className="card-preview" style={{ minHeight: size * 1.35 }}>
        <AnimatePresence mode="wait">
          {fontFamily ? (
            hasScriptNote(scriptStatus) ? (
              /* 画不出示例文字的语言：这一格直接换成「无中文」这类标注（0.9.3-5）
                 缺中文时若同族另有中文版，补一句「中文见 XXX」指路（0.9.3-7） */
              <motion.p
                key="noscript"
                className="preview-text preview-script"
                initial={intro ? { opacity: 0, y: 5 } : false}
                animate={{ opacity: 1, y: 0 }}
                transition={intro ? spring : INTRO_OFF}
              >
                <ScriptChip status={scriptStatus} hint={scriptHint} />
              </motion.p>
            ) : (
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
            )
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
            /* 字重区里的点击不要冒泡到卡片（用户 2026-10-31）：这里是逐字重操作的区域，
               点空白/点行都会把卡片选中或取消，导致详情面板被反复开关，没法在这儿多选 */
            onClick={(e) => e.stopPropagation()}
            /* 字重名的大小跟着上面的示例字号走（完整界面取 1/4） */
            style={{ "--face-line-size": faceLineFontSize(size, 4) } as CSSProperties}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0, transition: { ...springSnappy } }}
            transition={springSoft}
          >
            {shownFaces.map((face, i) => (
              <FacePreview
                key={face.id}
                family={family}
                face={face}
                probeText={probeText}
                index={i}
                onHover={setHoverFaceId}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  );
});
