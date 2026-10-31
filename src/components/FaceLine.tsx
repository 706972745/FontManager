import { Eye, EyeOff } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, type MouseEvent as ReactMouseEvent } from "react";
import { useT } from "../lib/i18n";
import { useDisplayName } from "../lib/displayName";
import { buildFaceMenu, canToggleFace } from "../lib/menus";
import { openContextMenu, openContextMenuAt } from "../design/primitives/ContextMenu";
import { spring, staggerDelay } from "../design/springs";
import { useScriptStatus } from "../lib/scriptCoverage";
import { INTRO_OFF, useIntro } from "../lib/useIntro";
import type { FontFace } from "../lib/ipc";
import { useFontStore, type Family } from "../state/fontStore";
import { ScriptChip } from "./ScriptChip";
import { MemberChip } from "./MemberChip";
import { faceKey } from "../lib/snapshotKey";
import { buildContainerIndexCached, containersFor } from "../lib/faceContainers";

/**
 * 这个字面进了哪些快照 / 分组（用户 2026-10-31：字重行眼睛左边要能看出这个字重被放进了哪儿）。
 *
 * 索引是全局 single-slot 缓存的，所以哪怕一屏挂了几十个字重行，也只建一次；
 * 三个输入都是 store 里的稳定引用，任何一处真的变了才重算。
 */
function useFaceContainers(family: Family, face: FontFace) {
  const snapshots = useFontStore((s) => s.snapshots);
  const collections = useFontStore((s) => s.collections);
  const collectionFaces = useFontStore((s) => s.collectionFaces);
  const key = useMemo(() => faceKey(face), [face]);

  return useMemo(() => {
    const index = buildContainerIndexCached(snapshots, collections, collectionFaces);
    return containersFor(index, family.name, key);
  }, [snapshots, collections, collectionFaces, family.name, key]);
}

/**
 * 字重行的文字大小跟着主预览字号走：完整界面取 1/4，速览界面取 1/8。
 *
 * 两个界面共用一个字号滑块（store.sizeIndex），但可用宽度差很多——完整界面的卡片宽、
 * 速览面板只有它的一半，所以比例不同。预览字号最小只有 8px，算出来是 1~2px，
 * 兜一个 11px 的下限（正好是原来的固定值），保证怎么拖都不会比改之前更小。
 */
export function faceLineFontSize(previewSize: number, divisor: 4 | 8): string {
  return `${Math.max(11, Math.round(previewSize / divisor))}px`;
}

/**
 * 一个字重行：字重名 + 缺字提示 + 操作按钮。
 *
 * 完整界面（展开卡片后）和速览界面共用这一个组件，样式统一在 `.face-line*` 里，
 * 两处长得一模一样（0.9.3-5 用户要求「完整界面的字重区改成和速览一样」）。
 * 行内不再重复渲染示例文字：鼠标划过这一行时主预览就切到这个字重，
 * 再在行里放一份「你好」纯属重复，还把列表撑得很高。
 */
export function FaceLine({
  family,
  face,
  probeText,
  onHover,
  /** 走入场动画（完整界面列表里一排排淡入）；速览里卡片本来就多，一律不走 */
  animate = false,
  index = 0,
}: {
  family: Family;
  face: FontFace;
  /** 用户输入的示例文字（空串 = 不标注） */
  probeText: string;
  onHover: (faceId: string | null) => void;
  animate?: boolean;
  index?: number;
}) {
  const t = useT();
  // 字重行的提示里用界面语言的字体名
  const displayName = useDisplayName();
  const intro = useIntro();
  const scriptStatus = useScriptStatus(face, probeText);
  // style 为空时退回 PostScript 名，不然整行只有一个空白按钮
  const styleLabel = face.style?.trim() || face.postscriptName || "Regular";
  const fullName = `${displayName(family)} ${styleLabel}`.trim();

  const title = t("quickbar.previewFaceHint", { name: fullName });
  const onContext = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e, buildFaceMenu(family, face));
  };
  /**
   * 行尾那颗按钮从「打开菜单」改成「启用 / 停用这一个字重」（用户 2026-10-31：
   * 「如果单独启用了哪一个字体，最好是让用户知道字重单独启用了」「这里也可以改，或者替换这个」）。
   *
   * 眼睛图标本身就是状态：睁眼 = 已启用、闭眼 = 已停用。原来那颗钢笔图标只是菜单入口，
   * 点开才知道这个字重是开还是关。完整菜单仍在**右键**这一行上（`onContext`），
   * 应用 PS/AI/CDR、复制、快照、分组一个都不少。
   */
  const toggleable = canToggleFace(face);
  const setFaceActive = useFontStore((s) => s.setFaceActive);
  // 这个字重被放进了哪些快照 / 分组（没有就整块不渲染）
  const containers = useFaceContainers(family, face);
  const body = (
    <>
      <span className="face-line-name" data-hint-text={title}>
        {styleLabel}
      </span>
      <ScriptChip status={scriptStatus} />
      {/* 这个字重本身损坏 / 不完整：直接标在字重行上，别让用户点进去才发现 */}
      {face.incomplete && (
        <span className="card-broken" data-hint-text={face.incomplete}>
          {t("card.brokenFace")}
        </span>
      )}
      {/* 紧贴眼睛左边：这个字重进了哪些快照 / 分组。
          行上只写**序号**（快照1 / 快照2 / 分组1…）—— 行太窄，`.苹方-繁` 那种长容器名塞不下；
          真名放在悬浮气泡里，序号对应的就是侧栏里那一个。 */}
      {containers.length > 0 && (
        <span className="face-line-chips">
          {containers.map((c) => (
            <MemberChip
              key={`${c.kind}-${c.name}`}
              kind={c.kind}
              badge={{ name: c.name, count: 0, styles: [] }}
              label={String(c.index)}
              hintText={t(
                c.kind === "snap" ? "card.inSnapshotIndex" : "card.inCollectionIndex",
                { index: c.index, name: c.name },
              )}
              iconSize={9}
              className="face-chip"
            />
          ))}
        </span>
      )}
      <button
        type="button"
        className={`face-line-apply face-line-toggle ${face.active ? "on" : "off"}`}
        disabled={!toggleable}
        aria-pressed={face.active}
        aria-label={t(face.active ? "menu.deactivate" : "menu.activate")}
       
        data-hint={face.active ? "hint.faceToggleOn" : "hint.faceToggleOff"}
        onClick={(e) => {
          e.stopPropagation();
          void setFaceActive(face.id, !face.active);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          openContextMenuAt(r.left, r.bottom + 4, buildFaceMenu(family, face));
        }}
      >
        {face.active ? (
          <Eye size={11} strokeWidth={1.75} />
        ) : (
          <EyeOff size={11} strokeWidth={1.75} />
        )}
      </button>
    </>
  );

  if (!animate) {
    return (
      <div
        className="face-line"
        onMouseEnter={() => onHover(face.id)}
        onMouseLeave={() => onHover(null)}
        onContextMenu={onContext}
      >
        {body}
      </div>
    );
  }
  return (
    <motion.div
      className="face-line"
      onMouseEnter={() => onHover(face.id)}
      onMouseLeave={() => onHover(null)}
      onContextMenu={onContext}
      initial={intro ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={intro ? { ...spring, delay: staggerDelay(index) } : INTRO_OFF}
    >
      {body}
    </motion.div>
  );
}
