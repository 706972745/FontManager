import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Minus, PanelTop, RefreshCw, Square, X } from "lucide-react";
import { useFontStore } from "../state/fontStore";
import { motion, useReducedMotion } from "motion/react";
import { springSnappy, springSoft } from "../design/springs";
import { INTRO_OFF, useIntro } from "../lib/useIntro";
import { useT } from "../lib/i18n";
import { useState } from "react";

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
      className="rescan-btn tb-action tb-action-first"
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
      <FolderOpen size={14} strokeWidth={1.5} />
    </motion.button>
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
        {/* 顺序固定：导入文件夹 → 重新扫描。两者都靠 Tab 可达，aria-label 与
            data-hint 原样保留；`-webkit-app-region: no-drag` 由 .titlebar-controls
            继承，不要给按钮单独加 drag 属性（加了反而会盖掉继承的 no-drag）。 */}
        <ImportFolderButton />
        <RescanButton />
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
