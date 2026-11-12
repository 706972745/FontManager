import { Eye, EyeOff } from "lucide-react";
import { motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useT } from "../lib/i18n";
import { buildFaceMenu, canToggleFace, copyText } from "../lib/menus";
import { faceFullName, faceStyleLabel } from "../lib/faceName";
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

/** 「已复制」亮多久（毫秒）。与样张视图 / 速览那句 `copyName` 同一个时长，三处观感一致 */
const COPIED_MS = 1500;

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
  const styleLabel = faceStyleLabel(face);
  /**
   * 提示气泡里写的就是**将要复制的那一串**（`faceFullName`，原始族名 + 样式）。
   *
   * 2026-11-12 之前这里用的是界面语言的族名（`useDisplayName`）：「提示说复制『微软雅黑
   * Bold』，粘出来却是 `Microsoft YaHei Bold`」—— 提示与结果对不上，用户会以为复制错了。
   * 现在三处同口径：气泡文案 = 剪贴板内容 = 右键菜单的标题。
   */
  const fullName = faceFullName(family.name, face);

  /**
   * 点字重名 = 复制它的字体全名（2026-11-12）。
   *
   * 为什么加这个：字重名原来只是个 `<span>`，点了没反应，而右键菜单里明明有
   * 「复制名字」—— 想复制一个 Bold 的名字得先右键。复制内容和菜单走同一个
   * `faceFullName`，toast + tick 音效也仍由 `copyText` 统一发。
   *
   * 「已复制」照抄样张视图那套（`.specimen-copied`）：文字**一直占位、只切 opacity**，
   * 出现 / 消失时不会把右边的缺字提示、归属胶囊、眼睛按钮推来推去；连点同一行靠
   * 重置计时器解决，而不是叠加一堆定时器。
   */
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const copyFaceName = useCallback(() => {
    copyText(faceFullName(family.name, face), t("copy.faceName"));
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
  }, [family.name, face, t]);

  const title = t("hint.copyFaceName", { name: fullName });
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
      {/* 字重名是**按钮**（2026-11-12）：点一下复制字体全名，键盘 Enter / Space 同样可达。
          拦截分三层，各有各的理由，别合并成一句「都拦」：
          · `onClick` —— 完整界面里这一行在卡片内部，冒泡上去就成了「选中 / 取消选中整张卡」，
            详情面板会跟着开关（0.9.9-13 踩过一次同样的坑）；
          · `onPointerDown` —— 卡片本体有 `whileTap`（FamilyCard.tsx:258，整卡透明度掉到 0.9），
            按一下字重名不该连整卡一起暗一下（与 PillToggle.tsx:33、星标按钮同一套处理）；
          · `onKeyDown` —— **只吞 Enter / Space**。⚠️ 这里绝不能无差别 stopPropagation：
            全局快捷键挂在 `window` 的**冒泡**阶段（App.tsx:755），在按钮里拦掉就再也到不了
            那边 —— 点过任意一个字重名之后，Delete / Escape / 方向键 / Ctrl+A 会全部失效，
            直到用户用鼠标把焦点点走。这两个键才是按钮自己消费的
            （项目约定见 App.tsx 的 `spaceTakenByTarget`：「按钮只消费 Space / Enter」）。 */}
      <button
        type="button"
        className="face-line-name"
        data-hint-text={title}
        aria-label={title}
        onClick={(e) => {
          e.stopPropagation();
          copyFaceName();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") e.stopPropagation();
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {styleLabel}
      </button>
      {/* 「已复制」紧跟在名字后面就地出现：一直占位、只切 opacity，见 copyFaceName 的注释。
          ⚠️ 位置全靠下面这条 `.face-line-spacer`：名字不再是 `flex: 1`（那样它会吃掉整行剩余
          空间，「已复制」被顶到行尾贴着眼睛按钮，中间空出一大片），剩余空间改由占位条吃掉。 */}
      <span className={`face-line-copied ${copied ? "is-shown" : ""}`} aria-hidden={!copied}>
        {t("copy.done")}
      </span>
      {/* 纯占位：把 ScriptChip / 归属胶囊 / 眼睛按钮照旧推到行尾。空元素、`aria-hidden`，
          不参与可访问性树，也不可点。 */}
      <span className="face-line-spacer" aria-hidden="true" />
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
        className={`face-line ${copied ? "is-copied" : ""}`}
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
      className={`face-line ${copied ? "is-copied" : ""}`}
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
