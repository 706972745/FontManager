import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef } from "react";
import { Lock } from "lucide-react";
import { PillToggle } from "../design/primitives/PillToggle";
import { formatBytes } from "../lib/fontLoader";
import { useFontStore, type Family } from "../state/fontStore";
import { FormatBadge } from "./FamilyCard";
import { MemberChip } from "./MemberChip";
import { buildMembership, type FamilyMembership } from "../lib/familyMembership";
import { faceKey } from "../lib/snapshotKey";
import { buildFamilyMenu } from "../lib/menus";
import { openContextMenu } from "../design/primitives/ContextMenu";
import { useT } from "../lib/i18n";
import { useDisplayName } from "../lib/displayName";
import { useRevealFamily } from "../lib/useReveal";

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

  /**
   * 搜索建议跳转（2026-11-12）：滚到可视区**中间**，并给这一行一个约 1.7s 的跳转高亮。
   *
   * 和上面那条按 `selectedFamily` 滚动的区别：那条是「用户点/键盘选了一行」，
   * 贴边就够；这里是「从搜索结果跳过来」，目标必须落在视线正中，否则用户还得自己
   * 再找一遍。两条同时触发时后执行的是这条（center 覆盖 auto），顺序不能颠倒。
   */
  const { revealed, jump } = useRevealFamily();
  useEffect(() => {
    if (!jump) return;
    const idx = families.findIndex((f) => f.name === jump.name);
    // 目标被当前筛选挡掉时什么都不做（例如跳到的族不在这个分组视图里）
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump]);

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
                revealed={revealed === fam.name}
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
 * 行首锚点（`.list-row::after`）的语义照**卡片视图**：悬停长灰线、选中是常驻蓝线；
 * 不复制族名、也不做「已复制」的 1.5s 闪现（那是速览 / 样张的交互，
 * 用户 2026-11-11：「交互效果和卡片视图一样，不需要和速览界面/样张视图一样」）。
 *
 * `revealed` 是**跳转**专用的临时态（搜索建议点了这个族）：只在这 1.7s 里给行铺一层
 * 强调色底 —— 选中本身已经是常驻蓝线了，只靠线的话「刚跳过来」和「本来就在这儿」
 * 看不出区别。三者语义互斥地叠加：hover 灰线 / selected 蓝线 / revealed 临时底线。
 */
function ListRow({
  fam,
  mem,
  hasMem,
  selected,
  revealed,
  top,
  onSelect,
}: {
  fam: Family;
  mem?: FamilyMembership;
  hasMem: boolean;
  selected: boolean;
  revealed: boolean;
  top: number;
  onSelect: (name: string, mode: "single" | "toggle" | "range", order: string[]) => void;
}) {
  const t = useT();
  const displayName = useDisplayName();

  const handlePick = (mode: "single" | "toggle" | "range") => {
    onSelect(fam.name, mode, useFontStore.getState().visibleOrder);
  };

  return (
    <div
      data-family={fam.name}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      className={`list-row ${selected ? "row-selected" : ""} ${revealed ? "row-revealed" : ""}`}
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
