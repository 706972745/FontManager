import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { AlertTriangle, ChevronRight, Lock } from "lucide-react";
import { memo, useMemo, useState, type CSSProperties } from "react";
import { PillToggle } from "../design/primitives/PillToggle";
import { useMarquee } from "../design/primitives/useMarquee";
import { spring, springSnappy, springSoft } from "../design/springs";
import { useListFontCss } from "../lib/fontLoader";
import { listChars } from "../lib/listChars";
import { useCardThumb, useThumbGenerate } from "../lib/thumb";
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
import { StarRating } from "./StarRating";
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
  /**
   * 展开字重列表用的是 `height: 0 → auto` 动画。高度不是 transform，
   * 每一帧都要重排卡内所有字重行；低配机器上点开一个 20 字重的族会明显顿一下。
   * `MotionConfig reducedMotion` 管不到 height，所以这里显式接管开关：
   * 系统开了减弱动效、或用户在软件里开了，就直接给最终高度，不做逐帧过渡。
   */
  const motionPref = useFontStore((s) => s.motionPref);
  const systemReduce = useReducedMotion();
  const noMotion = systemReduce || motionPref === "reduced";
  const setFamilyActive = useFontStore((s) => s.setFamilyActive);
  const selectWith = useFontStore((s) => s.selectWith);
  const selected = useFontStore((s) => s.selection.includes(family.name));
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
  const text = sampleText.trim() || family.name;
  /**
   * 列表子集通道（§12）：卡片主预览只渲染示例文字 + 字重名，
   * 没必要为它解码整个字体（库里 >8MB 的有 218 个，中文大盘字解一次几百毫秒）。
   *
   * 自定义示例文字时 `listChars` 返回 null → 自动回退 `useFontCss` 的完整链路，
   * 与 0.9.9-25 的行为完全一致。字重行（FaceLine）不走这条路：它是独立组件，
   * 一个族展开后要同时挂几个字面，切过去的收益不如风险。
   */
  const listCharSet = listChars(family, sampleText, t("preview.defaultSample"));
  /**
   * 缩略图缓存（§13，默认关闭）：有现成的图就**不加载字体** —— 这是它唯一的真收益
   * （滚回来时省掉一次 FontFace 加载）。没有图时完全不影响下面这条链路。
   */
  const thumb = useCardThumb({
    enabled: !!previewFace,
    faceId: previewFace?.id ?? null,
    chars: listCharSet,
    sizePx: size,
  });
  /* 缺语言文字的格子显示的是标注、不是字形：不为它加载字体（有 thumb 同理） */
  const { fontFamily, failed } = useListFontCss(
    thumb.src || hasScriptNote(scriptStatus) ? null : previewFace,
    listCharSet,
  );
  // 缺语言文字的格子显示的是标注、不是字形，别为它生成缩略图
  useThumbGenerate(thumb, hasScriptNote(scriptStatus) ? null : fontFamily, text, size);
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

  /** 悬停跑马灯：预览文本被截断时缓慢左移展示结尾、移开快速回滚（用户 2026-11-05） */
  const previewMarquee = useMarquee(size);

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
      onMouseEnter={previewMarquee.enter}
      onMouseLeave={previewMarquee.leave}

      /*
       * 停用态原来用 `scale: 0.99` 表达，结果每次点开关，整张卡片都会缩放一下：
       * 卡片是中心缩放，右边缘（以及贴右的星标、开关）会横移约 4px，点完还要回弹。
       * 用户报的「点击按钮时按钮会偏移」就是这个。改成 opacity —— 只改明暗、
       * 不碰几何，按钮位置在任何状态下都恒定。
       */
      animate={{ opacity: family.active ? 1 : 0.94 }}
      whileHover={{ y: -1 }}
      /*
       * 原来还有 whileTap={{ scale: 0.99 }}：点击卡片切详情时整卡缩一下，
       * 贴右的星标 / 开关跟着横移约 4px 再弹回 —— 用户报的「切换详细面板时按钮偏移」
       * 就是这一下。这里给一个不改变几何的按下反馈（轻微压暗），位置始终不动。
       */
      whileTap={{ opacity: 0.96 }}
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
            /* 同星标：别让这次按下触发父卡片的 whileTap 缩放 */
            onPointerDown={(e) => e.stopPropagation()}
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
        <StarRating
          family={family.name}
          labels={{
            add: t("card.favorite", { name: family.name }),
            remove: t("card.unfavorite", { name: family.name }),
          }}
        />
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

      <div className="card-preview" ref={thumb.ref} style={{ minHeight: size * 1.35 }}>
        <AnimatePresence mode="wait">
          {/* 缺语言文字的标注不依赖字体加载，提到最前 —— 立即可见，
              还能免掉为这一格发起一次子集/完整字体加载 */}
          {hasScriptNote(scriptStatus) ? (
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
          ) : thumb.src ? (
            /* 缩略图：像素尺寸按实际预览宽度 × DPR 渲染，这里 1:1 显示，不缩放 */
            <motion.img
              key="thumb"
              className="preview-text preview-thumb"
              src={thumb.src}
              alt=""
              draggable={false}
              initial={intro ? { opacity: 0, y: 5 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={intro ? spring : INTRO_OFF}
            />
          ) : fontFamily ? (
            <motion.p
              key="real"
              ref={previewMarquee.measureRef}
              className={`preview-text ${previewMarquee.open ? "marquee-open" : ""}`}
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
              <span
                className={`marquee-roll ${previewMarquee.open ? "marquee-roll-on" : ""}`}
                style={previewMarquee.moverStyle}
              >
                {text}
              </span>
            </motion.p>
          ) : failed ? (
            <p key="failed" className="preview-text preview-failed">
              {t("card.noPreview")}
            </p>
          ) : (
            /* E1 占位：字体还在排队/解码时先用界面字体把示例文字顶上，
               加载完成换成真字体 —— 首屏不再是一排 skeleton 灰条（B1 p95 489 ms 的体感主因） */
            <motion.p
              key="pending"
              className="preview-text preview-pending"
              style={{
                fontSize: size,
                fontStyle: previewFace.italic ? "italic" : "normal",
                fontWeight: previewFace === lead ? undefined : previewFace.weight,
              }}
              initial={intro ? { opacity: 0, y: 5 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={intro ? spring : INTRO_OFF}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
            >
              {text}
            </motion.p>
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
            transition={noMotion ? { duration: 0 } : springSoft}
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
