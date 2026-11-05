import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "motion/react";
import { ChevronDown, Lock, Monitor } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { openContextMenu, openContextMenuAt } from "../design/primitives/ContextMenu";
import { PillToggle } from "../design/primitives/PillToggle";
import { useMarquee } from "../design/primitives/useMarquee";
import { useListFontCss } from "../lib/fontLoader";
import { listChars } from "../lib/listChars";
import { copyrightExpired, familyCopyrightClass } from "../lib/license";
import { buildFamilyMenu } from "../lib/menus";
import { useFamilyMembership } from "../lib/membership";
import { hasScriptNote, useScriptStatus } from "../lib/scriptCoverage";
import { StarRating } from "./StarRating";
import { isSystemFamily, SIZES, useFontStore, type Family } from "../state/fontStore";
import { useT, type TKey } from "../lib/i18n";
import { useDisplayName } from "../lib/displayName";
import { FormatBadge } from "./FamilyCard";
import { MemberChip } from "./MemberChip";
import { ScriptChip } from "./ScriptChip";

/**
 * 样张视图（2026-11-05）。
 *
 * 替换原来的「瀑布流」：那个视图一次只摊开**一个**字族，32 个字号从上排到下，
 * 想比较两款字体得来回选、来回滚。用户要的是「一眼看出每个字体长什么样，好挑字」，
 * 于是换成参考图那种**多列样张墙** —— 每个字族一格，格子顶部保留卡片头部的全部信息
 * （格式、族名、样式数、版权、收藏、开关、分组/快照、系统字体标记），
 * 下面用当前字号把示例文字铺开。
 *
 * 三条硬约束（用户 2026-11-05 明确）：
 *   1. 每格可以单独选字重，选过的记在本机（localStorage，属于「使用习惯」不是用户数据）；
 *   2. 系统字体要标出来，非系统字体不标；
 *   3. 版权信息必须一直在（哪怕是「未知」）。
 *
 * 性能：四千多个字族不能一次铺出来。这里按「行」虚拟化（列数跟着宽度变），
 * 只挂载可视区前后几行；每格用列表子集通道加载字体，滚动时 LRU 自然淘汰。
 */

const FACE_STORE_KEY = "zfm.specimen.faces";
/** localStorage 里最多记多少个字族的字重选择 —— 只是防无限增长，正常用不到这么多 */
const FACE_STORE_LIMIT = 2000;

let faceChoices: Record<string, string> | null = null;

function loadFaceChoices(): Record<string, string> {
  if (faceChoices) return faceChoices;
  try {
    const raw = localStorage.getItem(FACE_STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    faceChoices =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : {};
  } catch {
    faceChoices = {};
  }
  return faceChoices;
}

function rememberedFace(family: string): string | undefined {
  return loadFaceChoices()[family];
}

function rememberFace(family: string, faceId: string) {
  const map = loadFaceChoices();
  map[family] = faceId;
  const keys = Object.keys(map);
  if (keys.length > FACE_STORE_LIMIT) {
    for (const key of keys.slice(0, keys.length - FACE_STORE_LIMIT)) delete map[key];
  }
  try {
    localStorage.setItem(FACE_STORE_KEY, JSON.stringify(map));
  } catch {
    /* 隐私模式 / 配额满：记不住就算了，不影响预览 */
  }
}

/** 一格样张。放 memo 里：滚动时只有新进视口的格子会重新渲染 */
const SpecimenTile = memo(function SpecimenTile({
  family,
  size,
}: {
  family: Family;
  size: number;
}) {
  const t = useT();
  const displayName = useDisplayName();
  const sampleText = useFontStore((s) => s.sampleText);
  const selected = useFontStore((s) => s.selection.includes(family.name));
  // 对比挑选模式需要「已挑中」的视觉反馈；普通点击的选中只改状态不画线框
  // （用户 2026-11-05：点击后不要出现线框）
  const picking = useFontStore((s) => s.comparePicking);
  const setFamilyActive = useFontStore((s) => s.setFamilyActive);
  const selectWith = useFontStore((s) => s.selectWith);
  const copyrightOverride = useFontStore((s) => s.copyrightStatus[family.name]);
  const copyrightExpiry = useFontStore((s) => s.copyrightExpiry[family.name]);
  const { snapshotBadges, collectionBadges } = useFamilyMembership(family.name, family.faces);

  const [faceId, setFaceId] = useState<string | undefined>(() => rememberedFace(family.name));

  /** 悬停跑马灯：预览文本被截断时缓慢左移展示结尾、移开快速回滚（用户 2026-11-05） */
  const previewMarquee = useMarquee(size);

  /** 字重菜单用去重后的字面（系统 + 库里同名字面只列一次） */
  const pickable = useMemo(
    () => (family.uniqueFaces && family.uniqueFaces.length > 0 ? family.uniqueFaces : family.faces),
    [family.uniqueFaces, family.faces],
  );
  const lead = family.faces.find((f) => f.style === "Regular") ?? family.faces[0];
  const previewFace =
    pickable.find((f) => f.id === faceId) ??
    pickable.find((f) => f.style === "Regular") ??
    pickable[0] ??
    lead;

  const probeText = sampleText.trim();
  const scriptStatus = useScriptStatus(previewFace, probeText);
  const text = sampleText.trim() || displayName(family);
  const chars = listChars(family, sampleText, t("preview.defaultSample"));
  // 缺语言文字的格子显示的是标注、不是字形，别为它加载字体
  const noteShown = hasScriptNote(scriptStatus);
  const { fontFamily, failed } = useListFontCss(noteShown ? null : previewFace, chars);

  const licCls = familyCopyrightClass(family.faces, copyrightOverride);
  const licExpired = licCls === "timelimited" && copyrightExpired(copyrightExpiry);
  const licKey = `copyright.${licCls}` as TKey;
  const licTitle = licExpired
    ? `${t("copyright.expiryDate")}: ${copyrightExpiry} — ${t("copyright.expired")}`
    : licCls === "timelimited" && copyrightExpiry
      ? `${t("copyright.expiryDate")}: ${copyrightExpiry}`
      : t("detail.copyright");

  const system = isSystemFamily(family);
  const members = [
    ...snapshotBadges.map((badge) => ({ badge, kind: "snap" as const })),
    ...collectionBadges.map((badge) => ({ badge, kind: "coll" as const })),
  ];
  // 一格只有三百多像素宽：成员胶囊最多摆两个，剩下的收进「+N」，悬停仍能看到全部
  const shownMembers = members.slice(0, 2);
  const extraMembers = members.length - shownMembers.length;

  const pickWeight = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      openContextMenuAt(
        rect.left,
        rect.bottom + 4,
        pickable.map((face) => ({
          kind: "check" as const,
          label: face.style || face.postscriptName || "Regular",
          checked: face.id === previewFace?.id,
          action: () => {
            setFaceId(face.id);
            rememberFace(family.name, face.id);
          },
        })),
      );
    },
    [pickable, previewFace?.id, family.name, t],
  );

  const stylesCount = pickable.length;

  return (
    <motion.article
      className={`specimen-tile ${selected && picking ? "card-selected" : ""}`}
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
      whileTap={{ opacity: 0.96 }}
    >
      <header className="specimen-head">
        <FormatBadge format={family.formats[0]} isVariable={family.isVariable} />
        <span className="specimen-name" data-hint-text={family.name}>
          {displayName(family)}
        </span>
        <span className="specimen-gap" />
        {system && family.deactivatable && (
          <span
            className="specimen-os"
            data-hint-text={t("card.osManaged")}
            aria-label={t("card.osManagedShort")}
          >
            <Monitor size={10} strokeWidth={1.75} />
            {t("card.osManagedShort")}
          </span>
        )}
        <span
          className={`lic-chip lic-${licCls} ${licExpired ? "lic-expired" : ""}`}
          data-hint-text={licTitle}
        >
          {t(licKey)}
        </span>
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
          <span
            className="card-os-lock specimen-os-lock"
            data-hint-text={t("card.osManaged")}
            aria-label={t("card.osManaged")}
          >
            <Lock size={11} strokeWidth={1.75} />
            {t("card.osManagedShort")}
          </span>
        )}
      </header>

      <div className="specimen-tools" onClick={(e) => e.stopPropagation()}>
        <button
          className="specimen-weight"
          data-hint="hint.specimenWeight"
          aria-label={t("hint.specimenWeight")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={pickWeight}
        >
          <span>{previewFace?.style || previewFace?.postscriptName || "Regular"}</span>
          <ChevronDown size={11} strokeWidth={2} />
        </button>
        {stylesCount > 1 && (
          <span className="specimen-styles tabular">
            {t("card.stylesCount", { count: stylesCount })}
          </span>
        )}
        {shownMembers.map(({ badge, kind }) => (
          <MemberChip key={`${kind}-${badge.name}`} badge={badge} kind={kind} iconSize={9} />
        ))}
        {extraMembers > 0 && (
          <span
            className="specimen-more"
            data-hint-text={members
              .slice(2)
              .map(({ badge }) => badge.name)
              .join("、")}
          >
            +{extraMembers}
          </span>
        )}
      </div>

      {/* 正文区：flex 撑满剩余高度（CSS 里水平+垂直双居中） */}
      <div className="specimen-body">
        {noteShown ? (
          <ScriptChip status={scriptStatus} />
        ) : fontFamily ? (
          <p
            ref={previewMarquee.measureRef}
            className={`specimen-text ${previewMarquee.open ? "marquee-open" : ""}`}
            style={{
              fontFamily,
              fontSize: size,
              fontStyle: previewFace?.italic ? "italic" : "normal",
              fontWeight: previewFace === lead ? undefined : previewFace?.weight,
            }}
          >
            <span
              className={`marquee-roll ${previewMarquee.open ? "marquee-roll-on" : ""}`}
              style={previewMarquee.moverStyle}
            >
              {text}
            </span>
          </p>
        ) : failed ? (
          <p className="specimen-text specimen-text-failed">{t("card.noPreview")}</p>
        ) : (
          <p
            ref={previewMarquee.measureRef}
            className={`specimen-text specimen-text-pending ${previewMarquee.open ? "marquee-open" : ""}`}
            style={{
              fontSize: size,
              fontStyle: previewFace?.italic ? "italic" : "normal",
              fontWeight: previewFace === lead ? undefined : previewFace?.weight,
            }}
          >
            <span
              className={`marquee-roll ${previewMarquee.open ? "marquee-roll-on" : ""}`}
              style={previewMarquee.moverStyle}
            >
              {text}
            </span>
          </p>
        )}
      </div>
    </motion.article>
  );
});

export function SpecimenView({ families }: { families: Family[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // 样张的字号是独立的一档（初始 32px，可到 8px），不与卡片 / 列表互相影响
  const sizeIndex = useFontStore((s) => s.specimenSizeIndex);
  const size = SIZES[sizeIndex];
  const selectedFamily = useFontStore((s) => s.selectedFamily);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });

  // 跟踪滚动容器的宽高（列数跟宽度走、可见行数跟高度走）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewport({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(() => {
      setViewport({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 横向一行 2~3 格（用户 2026-11-05：最多 3 个、最少 2 个，其余靠滚动看）
  const cols =
    viewport.w > 0 ? Math.max(2, Math.min(3, Math.floor((viewport.w - 36) / 340))) : 3;
  const rowCount = Math.max(1, Math.ceil(families.length / cols));

  /**
   * 行高必须是**精确、统一、且与字号无关**的定值（不是估算 + 逐行测量）。
   *
   * 与字号无关的原因：拖字号滑条时若行高跟着变（哪怕只在大字号档变），
   * 视口里各行的高度增量就会把下面的内容顶上/顶下——用户 2026-11-05 两次
   * 报的「拖滑条时开关按钮上下跳动」，残留根因正是 88/96px 档行高从
   * 视口钳制值再长出去那一截。现在行高恒等于「视口行区高度 ÷ 4」：
   * 一屏正好最多 4 行（用户定的密度上限），拖动全程行位置零移动，
   * 字号滑条只改示例文字大小，和卡片界面的按钮一样纹丝不动。
   * 极矮窗口（一半视口都装不下一格）保住格子结构下限 152px：
   * 上10 + 下12 内边距 + 2 边框 + 头部 22 + 间距 6 + 工具行 20 + 间距 6
   * + 正文最少 64 = 152。正文区 flex 撑满剩余空间，上下留白永远相等。
   */
  const rowsSpan = viewport.h > 60 ? viewport.h - 14 : 0; // 减顶内边距，行区可用高度
  const loRow = rowsSpan > 0 ? Math.ceil(rowsSpan / 4) : 152;
  const hiRow = rowsSpan > 0 ? Math.floor(rowsSpan / 2) : 0;
  const rowHeight =
    rowsSpan > 0 ? Math.max(152, Math.min(loRow, Math.max(hiRow, 152))) : 152;
  const rowHeightRef = useRef(rowHeight);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 4,
    getItemKey: (i) => `${i}:${cols}`,
  });

  /**
   * 字号变了：行高按比例映射 scrollTop，视口里正看着的那几行原地不动。
   *
   * 必须是 useLayoutEffect：拖滑条时每一步都改行高，若等绘制完才补偿
   * scrollTop，用户每一步都会看到一帧「内容先跳走再弹回来」——这就是
   * 「拖滑条时按钮上下跳动」在上一版还残留的原因（上一版用的 useEffect）。
   * 布局阶段在绘制前补偿完，错位帧根本不会被画出来。
   *
   * 两处细节：
   * 1. 公式要把容器 14px 顶内边距算进去——行格子从 y=14 开始铺，
   *    直接按 scrollTop 整体等比会偏 14×|ratio-1| 像素；
   * 2. CSS 里 .specimen-scroll 已加 overflow-anchor:none，关掉浏览器的
   *    滚动锚定，否则它和我们这套补偿各修各的，一样会抖。
   */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prev = rowHeightRef.current;
    rowHeightRef.current = rowHeight;
    if (prev !== rowHeight && prev > 0 && el.scrollTop > 14) {
      el.scrollTop = Math.max(
        0,
        Math.round(((el.scrollTop - 14) * rowHeight) / prev + 14),
      );
    }
    virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowHeight]);

  // 选中项来自搜索 / 方向键 / 速览回到主界面：只有目标行**不在可视区**才滚动，
  // 点可见格子不能触发滚动（否则一点内容就跳一下，用户 2026-11-05）
  useEffect(() => {
    if (!selectedFamily) return;
    const idx = families.findIndex((f) => f.name === selectedFamily);
    const el = scrollRef.current;
    if (idx < 0 || !el) return;
    const top = Math.floor(idx / cols) * rowHeight;
    const bottom = top + rowHeight;
    if (top < el.scrollTop || bottom > el.scrollTop + el.clientHeight) {
      virtualizer.scrollToIndex(Math.floor(idx / cols), { align: "auto" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFamily]);

  return (
    <div className="specimen-scroll" ref={scrollRef}>
      <div className="specimen-inner" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const start = item.index * cols;
          const rowFamilies = families.slice(start, start + cols);
          return (
            <div
              key={item.key}
              className="specimen-row"
              style={{
                transform: `translateY(${item.start}px)`,
                height: rowHeight,
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              }}
            >
              {rowFamilies.map((family) => (
                <SpecimenTile key={family.name} family={family} size={size} />
              ))}
              {rowFamilies.length < cols &&
                Array.from({ length: cols - rowFamilies.length }, (_, i) => (
                  <div key={`empty-${i}`} className="specimen-tile specimen-tile-empty" aria-hidden />
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
