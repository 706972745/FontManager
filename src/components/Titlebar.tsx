import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { Minus, PanelTop, Puzzle, RefreshCw, Square, X } from "lucide-react";
import { useFontStore } from "../state/fontStore";
import { motion, useReducedMotion } from "motion/react";
import { springSnappy, springSoft } from "../design/springs";
import { INTRO_OFF, useIntro } from "../lib/useIntro";
import { useT } from "../lib/i18n";
import { useState } from "react";
import { useWorkshopInstalled } from "../lib/useWorkshopPanel";
import { OPEN_WORKSHOP_EVENT } from "./PanelHost";

function SettingsGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="2.75" y1="4.75" x2="7.5" y2="4.75" />
      <line x1="12.9" y1="4.75" x2="13.25" y2="4.75" />
      <circle cx="10.2" cy="4.75" r="2" />
      <line x1="2.75" y1="11.25" x2="3.1" y2="11.25" />
      <line x1="8.5" y1="11.25" x2="13.25" y2="11.25" />
      <circle cx="5.8" cy="11.25" r="2" />
    </svg>
  );
}

/**
 * 「导入文件夹」与「重新扫描」——2026-11 从顶栏迁到标题栏。
 *
 * 为什么搬：这两个动作是**整库级**的（往字库里拷文件、重扫整个字体目录），
 * 却和「筛选 / 排序 / 对比」这些「当前视图内」的控件挤在同一条工具栏里，
 * 视觉权重一样重，用户会以为它们只作用于眼前这一屏。标题栏右侧是窗口级动作区，
 * 语义正好对上；顶栏右侧因此只剩「视图切换」一组。
 *
 * 结构上保留 `rescan-btn`（两个按钮原本共用它），标题栏变体参数由
 * `.rescan-btn.tb-action` 覆盖（见 app.css 文末追加段），基础规则一个字都没动。
 */
function ImportFolderButton() {
  const t = useT();
  const installPaths = useFontStore((s) => s.installPaths);
  const [busy, setBusy] = useState(false);
  return (
    <motion.button
      data-hint="hint.importFolder"
      className="rescan-btn tb-action"
      aria-label={t("top.importFolder")}
      disabled={busy}
      onClick={async () => {
        const dir = await open({
          directory: true,
          multiple: false,
          title: t("top.importFolder"),
        });
        if (typeof dir !== "string") return;
        setBusy(true);
        try {
          // 后端会递归展开目录：文件夹（含子目录）里的字体**复制**一份进字体库，
          // 原来的文件夹原样保留（用户 2026-10-30：不走链接、也不移动源文件）。
          await installPaths([dir], "copy");
        } finally {
          setBusy(false);
        }
      }}
      whileTap={{ scale: 0.94, transition: springSnappy }}
    >
      <ImportFolderGlyph />
    </motion.button>
  );
}

/**
 * 「导入文件夹」的图标：打开文件夹 + 右下角外挂加号。
 *
 * 用户 2026-11-13 从四个方案里定的 V2（角上叠放 + 底衬）：文件夹略缩到 86%，
 * 加号压在右下角 —— 但加号先垫一圈**标题栏底色的底衬**再叠上去，交叠处会自动
 * 留白，看起来是加号浮在文件夹上而不是穿过它（候选稿里加号直接压线的那版
 * 会糊成一团）。底衬用 `--canvas`：标题栏底色就是 canvas 上 1.5% 的 ink 水洗，
 * 深浅两套主题自动跟随，不需要分开处理。
 *
 * 纯内联 SVG（不走 lucide）：lucide 的 FolderPlus 是「闭合文件夹 + 内部加号」，
 * 形状和用户认可的「打开文件夹」不一致；这里是 FolderOpen 原路径 + 外挂加号，
 * 描边宽 / 圆角 / 端点风格与其它 lucide 图标完全一致。
 */
function ImportFolderGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g
        transform="scale(0.86)"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
      </g>
      <g strokeLinecap="round" fill="none">
        <path d="M17.9 14.7v6.3" stroke="var(--canvas)" strokeWidth={4.2} />
        <path d="M14.7 17.85h6.3" stroke="var(--canvas)" strokeWidth={4.2} />
        <path d="M17.9 14.7v6.3" stroke="currentColor" strokeWidth={1.5} />
        <path d="M14.7 17.85h6.3" stroke="currentColor" strokeWidth={1.5} />
      </g>
    </svg>
  );
}

function RescanButton() {
  const t = useT();
  const rescan = useFontStore((s) => s.rescan);
  const scanning = useFontStore((s) => s.phase === "scanning");
  /**
   * 减少动效下**不能**把转圈交给 motion（审计 P2-8）。
   *
   * `MotionConfig reducedMotion="always"` 会把 rotate 直接压成终态 → 图标停在半路，
   * 看起来像「扫描卡死了」。而「仍在工作」这个信号本身比动画更重要，
   * 所以这里换成 CSS 慢转（3s 一圈）：既没有快速旋转的刺激，也不会被读成死机。
   * 与 `.spin`（减少动效下 animation: none）口径不同，理由写在这里：
   * 那几处是**装饰**，这一处是**唯一的活动指示**。
   */
  const motionPref = useFontStore((s) => s.motionPref);
  const systemReduce = useReducedMotion();
  const slowSpin = systemReduce || motionPref === "reduced";
  return (
    <motion.button
      data-hint="hint.rescan"
      className="rescan-btn tb-action"
      aria-label={t("top.rescan")}
      disabled={scanning}
      onClick={() => void rescan()}
      whileTap={{ scale: 0.94, transition: springSnappy }}
    >
      <motion.span
        className={scanning && slowSpin ? "rescan-icon rescan-spin-slow" : "rescan-icon"}
        animate={scanning && !slowSpin ? { rotate: 360 } : { rotate: 0 }}
        transition={
          scanning && !slowSpin
            ? { duration: 1.2, repeat: Infinity, ease: "linear" }
            : { duration: 0.2 }
        }
      >
        <RefreshCw size={14} strokeWidth={1.5} />
      </motion.span>
    </motion.button>
  );
}

/**
 * 插件中心入口（2026-11-15 用户要求从侧栏搬上来）。
 *
 * 侧栏那一行会被「在线 / 回收站 / 关于 / 快捷键」这组导航淹没，而插件中心是**窗口级**
 * 的东西（点开是一个独立面板窗口），语义上该和导入 / 重扫 / 设置待在一起。
 * 所以只留图标、悬停出提示（`data-hint`，与标题栏其它按钮同一套）。
 *
 * **没装面板就不渲染** —— 装了才有这个入口，和侧栏时代同一条口径
 * （`useWorkshopInstalled` 读后端真相：prefs 标记 + 目录里真有 workshop.html）。
 */
function PluginCenterButton() {
  const t = useT();
  const installed = useWorkshopInstalled();
  if (!installed) return null;
  return (
    <motion.button
      className="rescan-btn tb-action"
      data-hint="side.pluginCenter"
      aria-label={t("side.pluginCenter")}
      onClick={() => {
        // 2026-11-19：插件中心改为在主窗口里以遮罩层打开（不再新开窗口）。
        // 这里**只发事件** —— 真正取地址、建 iframe、做单例去重都在 `PanelHost`，
        // 这样设置页里的同一个入口也走一条路径，不会出现两种打开行为。
        window.dispatchEvent(new CustomEvent(OPEN_WORKSHOP_EVENT));
      }}
      whileTap={{ scale: 0.94, transition: springSnappy }}
    >
      <Puzzle size={14} strokeWidth={1.5} />
    </motion.button>
  );
}

export function Titlebar() {
  const t = useT();
  const win = getCurrentWindow();
  const setSettingsOpen = useFontStore((s) => s.setSettingsOpen);
  const setQuickbar = useFontStore((s) => s.setQuickbar);
  const intro = useIntro();
  return (
    <motion.div
      className="titlebar"
      data-tauri-drag-region
      initial={intro ? { y: -28, opacity: 0 } : false}
      animate={{ y: 0, opacity: 1 }}
      transition={intro ? springSoft : INTRO_OFF}
    >
      <div className="titlebar-brand" data-tauri-drag-region>
        <img className="brand-mark" src="/icon.png" alt="" draggable={false} />
        <span className="titlebar-title" data-tauri-drag-region>
          FontManager
        </span>
      </div>
      <div className="titlebar-controls">
        {/* 动作区顺序（2026-11-15 用户定的口径）：**从右往左**依次是
            设置 → 速览 → 导入文件夹 → 刷新 → 插件中心，也就是 DOM 里从左到右反过来排。
            右边贴着窗口按钮（最小化/最大化/关闭），最常用、最不该动的留在原位不动。

            **以后再加按钮，一律加在这组的最左边**（即下面第一个位置）——
            新东西往外长，老按钮不挪窝，肌肉记忆才不会被一次改动打乱。

            外层 `.titlebar-actions` 不是可有可无的：五个按钮必须**同尺寸 + 同间距**，
            否则 30×30 的 tb-action 和 38×30 的窗口按钮混排，icon 中心间距会变成
            31 / 34 / 35 三种，肉眼就是「有的挤有的松」。详见 app.css 同名段。 */}
        <div className="titlebar-actions">
          <PluginCenterButton />
          <RescanButton />
          <ImportFolderButton />
          <button
            data-hint="hint.enterQuickbar"
            data-tour="quickbar"
            aria-label={t("quickbar.enter")}
            onClick={() => void setQuickbar(true)}
          >
            <PanelTop size={14} strokeWidth={1.5} />
          </button>
          <button
            data-hint="hint.settings"
            data-tour="settings"
            aria-label={t("titlebar.settings")}
            onClick={() => setSettingsOpen(true)}
          >
            <SettingsGlyph />
          </button>
        </div>
        <span className="titlebar-sep" />
        <button aria-label={t("titlebar.minimize")} onClick={() => void win.minimize()} data-hint="hint.minimize">
          <Minus size={13} strokeWidth={1.5} />
        </button>
        <button aria-label={t("titlebar.maximize")} onClick={() => void win.toggleMaximize()} data-hint="hint.maximize">
          <Square size={10} strokeWidth={1.5} />
        </button>
        <button className="tc-close" aria-label={t("titlebar.close")} onClick={() => void win.close()} data-hint="hint.close">
          <X size={13} strokeWidth={1.5} />
        </button>
      </div>
    </motion.div>
  );
}
