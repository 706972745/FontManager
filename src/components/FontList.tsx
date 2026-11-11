import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { PillToggle } from "../design/primitives/PillToggle";
import { formatBytes } from "../lib/fontLoader";
import { useFontStore, type Family } from "../state/fontStore";
import { FormatBadge } from "./FamilyCard";
import { MemberChip } from "./MemberChip";
import { buildMembership, type FamilyMembership } from "../lib/familyMembership";
import { faceKey } from "../lib/snapshotKey";
import { buildFamilyMenu, copyText } from "../lib/menus";
import { openContextMenu } from "../design/primitives/ContextMenu";
import { useT } from "../lib/i18n";
import { useDisplayName } from "../lib/displayName";

export function FontList({ families }: { families: Family[] }) {
  const t = useT();
  const parentRef = useRef<HTMLDivElement>(null);
  const selectWith = useFontStore((s) => s.selectWith);
  const selection = useFontStore((s) => s.selection);
  const snapshots = useFontStore((s) => s.snapshots);
  const collections = useFontStore((s) => s.collections);
  const collectionFaces = useFontStore((s) => s.collectionFaces);

  /**
   * 字族 → 所属快照/分组胶囊（列表行是虚拟化的，批量算一次避免行内调 hook）。
   * 胶囊除了名字还要带上「放进去几个字重」与具体字重清单，所以算的是 MemberBadge。
   * 具体实现抽到 lib/familyMembership.ts（纯函数、可单测），这里只负责传数据。
   */
  const membership = useMemo(
    () => buildMembership(families, snapshots, collections, collectionFaces, faceKey),
    [snapshots, collections, collectionFaces, families],
  );

  const virtualizer = useVirtualizer({
    count: families.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 20,
    getItemKey: (i) => families[i].name,
  });

  const selectedFamily = useFontStore((s) => s.selectedFamily);
  useEffect(() => {
    if (!selectedFamily) return;
    const idx = families.findIndex((f) => f.name === selectedFamily);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [selectedFamily]);

  return (
    <div className="list-wrap">
      <div className="list-header">
        <span>{t("list.family")}</span>
        <span className="col-styles">{t("list.styles")}</span>
        <span className="col-format">{t("list.format")}</span>
        <span className="col-size">{t("list.size")}</span>
        <span className="col-status">{t("list.active")}</span>
      </div>
      <div ref={parentRef} className="list-scroll">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const fam = families[item.index];
            const mem = membership.get(fam.name);
            return (
              <ListRow
                key={item.key}
                fam={fam}
                mem={mem}
                hasMem={!!mem && (mem.snaps.length > 0 || mem.colls.length > 0)}
                selected={selection.includes(fam.name)}
                top={item.start}
                onSelect={selectWith}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * 一行 = 一个族。
 *
 * 拆成组件是为了「已复制」这 1.5s 的状态：放在 FontList 里会让每次复制都重渲染
 * 整个虚拟列表（几百行），放行内只重渲染自己。
 *
 * 交互与样张视图同一套（用户 2026-11-11：「列表视图也加入这个效果，只不过那个圆点
 * 不需要显示」）：悬停行首长出灰线 → 点一下复制族名 +「已复制」+ 蓝线，1.5s 后收回。
 */
function ListRow({
  fam,
  mem,
  hasMem,
  selected,
  top,
  onSelect,
}: {
  fam: Family;
  mem?: FamilyMembership;
  hasMem: boolean;
  selected: boolean;
  top: number;
  onSelect: (name: string, mode: "single" | "toggle" | "range", order: string[]) => void;
}) {
  const t = useT();
  const displayName = useDisplayName();

  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const copyName = () => {
    copyText(fam.name, t("copy.familyName"));
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  const handlePick = (mode: "single" | "toggle" | "range") => {
    const st = useFontStore.getState();
    onSelect(fam.name, mode, st.visibleOrder);
    // 只有「纯点击」才复制：Ctrl / Shift + 点击是选择手势，那两下不该往剪贴板里塞东西
    if (mode === "single") copyName();
  };

  return (
    <div
      data-family={fam.name}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      className={`list-row ${selected ? "row-selected" : ""} ${copied ? "is-copied" : ""}`}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: 40,
        transform: `translateY(${top}px)`,
      }}
      onClick={(e) => {
        const st = useFontStore.getState();
        if (st.comparePicking) {
          st.togglePick(fam.name);
          return;
        }
        handlePick(e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "range" : "single");
      }}
      onKeyDown={(e) => {
        // 焦点在内层开关上时，这个键属于开关
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          const st = useFontStore.getState();
          if (st.comparePicking) st.togglePick(fam.name);
          // 键盘的 Enter 等同于「点一下」（速览 / 样张都是这么接的）
          else handlePick("single");
          return;
        }
        if (e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        const st = useFontStore.getState();
        if (st.comparePicking) st.togglePick(fam.name);
        else onSelect(fam.name, e.shiftKey ? "range" : "single", st.visibleOrder);
      }}
      onContextMenu={(e) => openContextMenu(e, buildFamilyMenu(fam))}
    >
      <span className="row-name">
        <span className="row-name-text">{displayName(fam)}</span>
        {/* 「已复制」放在截断容器外面：族名很长时不会被 ellipsis 一起裁掉 */}
        <span className={`row-copied ${copied ? "is-shown" : ""}`} aria-hidden={!copied}>
          {t("copy.done")}
        </span>
        {hasMem && (
          <span className="row-members">
            {mem!.snaps.map((b) => (
              <MemberChip key={`snap-${b.name}`} badge={b} kind="snap" iconSize={9} />
            ))}
            {mem!.colls.map((b) => (
              <MemberChip key={`coll-${b.name}`} badge={b} kind="coll" iconSize={9} />
            ))}
          </span>
        )}
      </span>
      <span className="col-styles tabular">{fam.faces.length}</span>
      <span className="col-format">
        <FormatBadge format={fam.formats[0]} isVariable={fam.isVariable} />
      </span>
      <span className="col-size tabular">{formatBytes(fam.totalSize)}</span>
      <span className="col-status">
        {fam.deactivatable ? (
          <PillToggle
            on={fam.active}
            mixed={fam.partial}
            onChange={(on) => void useFontStore.getState().setFamilyActive(fam.name, on)}
            label={t(fam.active ? "card.deactivate" : "card.activate", { name: fam.name })}
          />
        ) : (
          /* 系统字体与卡片界面同口径：开关换成「系统」锁标记（用户 2026-11-05） */
          <span
            className="card-os-lock"
            data-hint-text={t("card.osManaged")}
            aria-label={t("card.osManaged")}
          >
            <Lock size={11} strokeWidth={1.75} />
            {t("card.osManagedShort")}
          </span>
        )}
      </span>
    </div>
  );
}
