import { PenTool } from "lucide-react";
import { motion } from "motion/react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useT } from "../lib/i18n";
import { buildFaceMenu } from "../lib/menus";
import { openContextMenu, openContextMenuAt } from "../design/primitives/ContextMenu";
import { spring, staggerDelay } from "../design/springs";
import { useScriptStatus } from "../lib/scriptCoverage";
import { INTRO_OFF, useIntro } from "../lib/useIntro";
import type { FontFace } from "../lib/ipc";
import type { Family } from "../state/fontStore";
import { ScriptChip } from "./ScriptChip";

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
  const intro = useIntro();
  const scriptStatus = useScriptStatus(face, probeText);
  // style 为空时退回 PostScript 名，不然整行只有一个空白按钮
  const styleLabel = face.style?.trim() || face.postscriptName || "Regular";
  const fullName = `${family.name} ${styleLabel}`.trim();

  const title = t("quickbar.previewFaceHint", { name: fullName });
  const onContext = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e, buildFaceMenu(family, face));
  };
  const body = (
    <>
      <span className="face-line-name" title={title}>
        {styleLabel}
      </span>
      <ScriptChip status={scriptStatus} />
      <button
        type="button"
        className="face-line-apply"
        aria-label={t("menu.faceActions", { name: styleLabel })}
        title={t("menu.faceActions", { name: styleLabel })}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          openContextMenuAt(r.left, r.bottom + 4, buildFaceMenu(family, face));
        }}
      >
        <PenTool size={11} strokeWidth={1.75} />
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
