import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef } from "react";
import { Lock } from "lucide-react";
import { PillToggle } from "../design/primitives/PillToggle";
import { formatBytes } from "../lib/fontLoader";
import { useFontStore, type Family } from "../state/fontStore";
import { FormatBadge } from "./FamilyCard";
import { MemberChip } from "./MemberChip";
import { buildMembership } from "../lib/familyMembership";
import { faceKey } from "../lib/snapshotKey";
import { buildFamilyMenu } from "../lib/menus";
import { openContextMenu } from "../design/primitives/ContextMenu";
import { useT } from "../lib/i18n";
import { useDisplayName } from "../lib/displayName";

export function FontList({ families }: { families: Family[] }) {
  const t = useT();
  const displayName = useDisplayName();
  const parentRef = useRef<HTMLDivElement>(null);
  const setFamilyActive = useFontStore((s) => s.setFamilyActive);
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
            const hasMem = !!mem && (mem.snaps.length > 0 || mem.colls.length > 0);
            return (
              // 行容器不能用 <button>：里面装着 PillToggle（也是 button），
              // HTML 不允许 button 嵌套 button，内层按钮的点击/键盘行为会连带触发外层
              // （§5 第 32 条）。改成 div + role=button，自己补 Enter/Space。
              <div
                key={item.key}
                data-family={fam.name}
                role="button"
                tabIndex={0}
                aria-pressed={selection.includes(fam.name)}
                className={`list-row ${
                  selection.includes(fam.name) ? "row-selected" : ""
                }`}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: 40,
                  transform: `translateY(${item.start}px)`,
                }}
                onClick={(e) => {
                  const st = useFontStore.getState();

                  if (st.comparePicking) {
                    st.togglePick(fam.name);
                    return;
                  }
                  const mode =
                    e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "range" : "single";
                  selectWith(fam.name, mode, st.visibleOrder);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  // 焦点在内层开关上时，这个键属于开关
                  if (e.target !== e.currentTarget) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const st = useFontStore.getState();
                  if (st.comparePicking) st.togglePick(fam.name);
                  else selectWith(fam.name, e.shiftKey ? "range" : "single", st.visibleOrder);
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
                      onChange={(on) => void setFamilyActive(fam.name, on)}
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
          })}
        </div>
      </div>
    </div>
  );
}
