import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "motion/react";
import { useEffect, useRef } from "react";
import { spring, staggerDelay } from "../design/springs";
import { FamilyCard } from "./FamilyCard";
import { INTRO_OFF, useIntro } from "../lib/useIntro";
import { experiment } from "../lib/experiment";
import { prefetchFace } from "../lib/fontLoader";
import { prefetchIndices, type ScrollDir } from "../lib/prefetch";
import type { Family } from "../state/fontStore";
import { SIZES, useFontStore } from "../state/fontStore";
import { useRevealFamily } from "../lib/useReveal";

/**
 * 实验开关（见交接文档 §11.1）。默认值 = 0.9.9-25 的现状，不传参数时行为完全不变。
 * 在模块级读一次：参数只在启动时生效，不必每次渲染解析字符串。
 *
 * 注意 overscan 是**前后对称**的：6→10 意味着前后各多 4 项，最多多挂 8 张卡。
 * 而 FontGrid 每张挂载的卡都会 `useFontCss` → 加载 + pin，
 * 所以这不是「免费多缓冲几行」，是有代价的有界实验。
 */
const GRID_OVERSCAN = experiment.gridOverscan();
const PREFETCH_ENABLED = experiment.prefetch();
const PREFETCH_SCREENS = experiment.prefetchScreens();

export function FontGrid({ families }: { families: Family[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const mountedAt = useRef(Date.now());
  const sizeIndex = useFontStore((s) => s.sizeIndex);
  const estimate = 120 + SIZES[sizeIndex] * 1.5;

  const virtualizer = useVirtualizer({
    count: families.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimate,
    overscan: GRID_OVERSCAN,
    getItemKey: (i) => families[i].name,
  });

  /**
   * 预取（§14，默认关闭）。节流信号取自**滚动容器原生 onScroll**，
   * 不能用虚拟列表的 `isScrolling`：那个值由渲染结果驱动，
   * 0.9.9-24 已经踩过一次「滚动信号被渲染反噬 → 计时器永不落定」。
   */
  const dirRef = useRef<ScrollDir>(0);
  const lastTopRef = useRef(0);
  const settleRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (settleRef.current !== null) window.clearTimeout(settleRef.current);
    },
    [],
  );

  const handleScroll = () => {
    const el = parentRef.current;
    if (!el) return;
    const top = el.scrollTop;
    if (top > lastTopRef.current) dirRef.current = 1;
    else if (top < lastTopRef.current) dirRef.current = -1;
    lastTopRef.current = top;
    if (!PREFETCH_ENABLED) return;
    if (settleRef.current !== null) window.clearTimeout(settleRef.current);
    // 落定 180ms 才动手：滚动过程中预取等于和正在显示的那批抢解码
    settleRef.current = window.setTimeout(() => {
      settleRef.current = null;
      const items = virtualizer.getVirtualItems();
      if (items.length === 0) return;
      const idx = prefetchIndices(
        families.length,
        items[0].index,
        items[items.length - 1].index,
        dirRef.current,
        PREFETCH_SCREENS,
      );
      for (const i of idx) {
        const fam = families[i];
        // 与 FamilyCard 的主预览同一口径：Regular 优先，否则第一个字面
        const face = fam?.faces.find((f) => f.style === "Regular") ?? fam?.faces[0];
        if (face) prefetchFace(face);
      }
    }, 180);
  };

  const selectedFamily = useFontStore((s) => s.selectedFamily);
  useEffect(() => {
    if (!selectedFamily) return;
    const idx = families.findIndex((f) => f.name === selectedFamily);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [selectedFamily]);

  /**
   * 搜索建议跳转（2026-11-12）：滚到可视区**中间** + 约 1.7s 的跳转高亮。
   * 上面那条按 selectedFamily 的滚动是「用户自己点了一行」，贴边即可；这条是
   * 「从搜索结果跳过来」，必须落在视线正中。两条同时触发时这条后执行（center 胜）。
   */
  const { revealed, jump } = useRevealFamily();
  useEffect(() => {
    if (!jump) return;
    const idx = families.findIndex((f) => f.name === jump.name);
    // 目标被筛选挡掉时不动（跳到的族不在当前视图里）
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump]);

  // 窗口形变期间不播卡片入场动画：内容必须是静止的，动的东西只有窗口
  const intro = useIntro();
  const arriving = intro && Date.now() - mountedAt.current < 1200;

  return (
    <div ref={parentRef} className="grid-scroll" onScroll={handleScroll}>
      <div
        className="grid-inner"
        style={{ height: virtualizer.getTotalSize(), position: "relative" }}
      >
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="grid-row"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${item.start}px)`,
            }}
          >
            <motion.div
              initial={intro ? { opacity: 0, y: 16 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={intro
                ? { ...spring, delay: arriving ? staggerDelay(item.index) : 0 }
                : INTRO_OFF}
            >
              <FamilyCard
                family={families[item.index]}
                revealed={revealed === families[item.index].name}
              />
            </motion.div>
          </div>
        ))}
      </div>
    </div>
  );
}
