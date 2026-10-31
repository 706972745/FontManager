import { Camera, Folder } from "lucide-react";
import { useT } from "../lib/i18n";
import type { MemberBadge } from "../lib/memberBadges";

/**
 * 卡片 / 速览 / 列表行上那个「在哪个快照 / 分组里」的小胶囊。
 *
 * 2026-10-31 用户要求：
 * - 卡片头部：胶囊上要能看出**这个容器里放了这个字族的几个字重** → 名字后面跟一个数字；
 *   悬浮时列出**具体是哪几个字重** → 走 `data-hint-text`（项目自己的气泡，不是系统 title，
 *   延迟与样式统一，也不会和 `title` 叠成两个气泡）。
 * - 字重行（`FaceLine`）：位置更窄、问的也更简单（「这一个字重在不在里面」），
 *   所以**只显示图标 + 序号**（快照1 / 快照2 / 分组1…），真名留给气泡 ——
 *   由 `label` + `hintText` 覆盖，默认行为不变。
 *
 * 三处共用这一个组件（完整界面卡片、速览卡片、列表视图行），免得各写一套后走样。
 */
export function MemberChip({
  badge,
  kind,
  iconSize = 10,
  className = "",
  /** 覆盖显示文本（字重行传序号，例如 "2"） */
  label,
  /** 覆盖气泡文案（字重行要把真名带上：快照 2：584） */
  hintText,
}: {
  badge: MemberBadge;
  kind: "snap" | "coll";
  /** 列表视图行更紧凑，传 9 */
  iconSize?: number;
  /** 速览里要额外带 `qb-chip`（更小的内边距） */
  className?: string;
  label?: string;
  hintText?: string;
}) {
  const t = useT();
  const base = t(kind === "snap" ? "card.inSnapshot" : "card.inCollection", {
    name: badge.name,
  });
  // 气泡内容：第一行是「在快照 X 中」，下面一行列出字重（预换行，CSS 用 pre-line）
  const hint =
    hintText ?? (badge.styles.length ? `${base}\n${badge.styles.join("、")}` : base);

  // 只在真的放进去了字重时才显示数字：整族在组里但字体还没加载出来时 count 为 0，
  // 写个「0」会让人以为容器是空的
  return (
    <span className={`member-chip member-chip-${kind} ${className}`.trim()} data-hint-text={hint}>
      {kind === "snap" ? (
        <Camera size={iconSize} strokeWidth={1.75} />
      ) : (
        <Folder size={iconSize} strokeWidth={1.75} />
      )}
      <span className="member-chip-name">{label ?? badge.name}</span>
      {label === undefined && badge.count > 0 && (
        <span className="member-chip-count tabular">{badge.count}</span>
      )}
    </span>
  );
}
