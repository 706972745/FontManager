import { invoke } from "@tauri-apps/api/core";
import { motion } from "motion/react";
import {
  ArrowUpRight,
  Columns2,
  FolderOpen,
  Globe,
  Paintbrush,
  Puzzle,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Star,
} from "lucide-react";
import { spring, springSnappy, springSoft, staggerDelay } from "../design/springs";
import { toast } from "../design/primitives/Toast";
import { t as translate, useT, type TKey } from "../lib/i18n";
import { APP_LICENSE, displayVersion } from "../lib/version";

function GithubGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1.17-.02-2.12-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.24 2.76.12 3.05.74.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.77 1.05.77 2.12 0 1.53-.01 2.76-.01 3.14 0 .3.2.66.8.55A10.52 10.52 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

function openUrl(url: string) {
  invoke("open_url", { url }).catch((e) => toast.error(translate("toast.couldntOpenLink"), String(e)));
}

type LinkItem = { key: TKey; sub: string; url: string; icon: React.ReactNode };

/**
 * 链接区只有一层：**本项目自己的两个仓库**（应用 + 插件）。
 *
 * 2026-11-12 用户定：本项目与迭代起点（ZFontManager 0.8.0）早已没有关系，
 * 页面上不再出现上游仓库 / 作者 / 网站那组卡片 —— 只留一句「从 0.8.0 迭代而来」
 * 的说明（`about.linksTitle`），既不误导读者以为还要去别处看代码，也守住了出处。
 * 原来那层「② 上游项目」是按 2026-11-10 的参考图排的，现在整组删掉。
 *
 * 版式不变：**圆角玻璃卡、两列铺开、左图标 + 标题 + 一行描述**（R4 那套）。
 */
const LOCAL_LINKS: LinkItem[] = [
  {
    key: "about.appRepo",
    sub: "github.com/706972745/FontManager",
    url: "https://github.com/706972745/FontManager",
    icon: <GithubGlyph />,
  },
  {
    key: "about.pluginRepo",
    sub: "github.com/706972745/FontManager-Plugin",
    url: "https://github.com/706972745/FontManager-Plugin",
    // 插件用拼图图标，跟上面那张 GitHub 字形区分开（两张卡都是纯 GitHub 图标会看着像重复）
    icon: <Puzzle size={16} strokeWidth={1.5} />,
  },
];

/** 一张链接卡。 */
function LinkCard({ item, delay }: { item: LinkItem; delay: number }) {
  const t = useT();
  return (
    <motion.button
      type="button"
      className="about-link"
      onClick={() => openUrl(item.url)}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...springSoft, delay }}
      whileHover={{ y: -1, transition: spring }}
      whileTap={{ opacity: 0.96, transition: springSnappy }}
    >
      {/* 结构对齐参考图：第一行「图标 + 标题 + 箭头」，第二行地址跨整宽压在图标下方 */}
      <span className="about-link-icon">{item.icon}</span>
      <span className="about-link-label">{t(item.key)}</span>
      <ArrowUpRight size={14} strokeWidth={1.5} className="about-link-arrow" />
      <span className="about-link-sub detail-mono">{item.sub}</span>
    </motion.button>
  );
}

const STACK = ["Tauri v2", "Rust", "React 19", "TypeScript", "Vite", "pnpm"];

/** 这款软件现在真正有的能力（2026-11-05 重写口径：与 README 功能导览一致）
 *
 * 2.0.0 补三条，正好凑成 9 条 —— `.about-features` 是 3 列网格（`repeat(3, …)`），
 * 6 条时是 2×3，补到 9 条是 3×3，不会留半行空位。
 * 补的三条都是 1.6–1.9 已经落地、但「关于」页一直没写的：
 * 套用到设计软件（`apply in app` 那套 COM 自动化）、对比视图、多字体库。
 */
const FEATURES: { key: TKey; icon: React.ReactNode }[] = [
  { key: "about.featPreview", icon: <Search size={14} strokeWidth={1.5} /> },
  { key: "about.featToggle", icon: <SlidersHorizontal size={14} strokeWidth={1.5} /> },
  { key: "about.featApply", icon: <Paintbrush size={14} strokeWidth={1.5} /> },
  { key: "about.featOrganize", icon: <Star size={14} strokeWidth={1.5} /> },
  { key: "about.featCompare", icon: <Columns2 size={14} strokeWidth={1.5} /> },
  { key: "about.featLibraries", icon: <FolderOpen size={14} strokeWidth={1.5} /> },
  { key: "about.featAutomation", icon: <Puzzle size={14} strokeWidth={1.5} /> },
  { key: "about.featOnline", icon: <Globe size={14} strokeWidth={1.5} /> },
  { key: "about.featPrivacy", icon: <ShieldCheck size={14} strokeWidth={1.5} /> },
];

export function AboutView() {
  const t = useT();
  return (
    <motion.div
      className="about-view"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring}
    >
      <img className="about-icon" src="/icon-512.png" alt="" draggable={false} />
      <h1 className="about-name">FontManager</h1>
      <div className="about-version tabular">
        {t("about.version", { version: displayVersion(t), license: APP_LICENSE })}
      </div>
      <p className="about-desc">{t("about.desc")}</p>

      {/* 1.3.2：功能一览。About 是「这个软件现在是什么」，得跟 README 的功能导览对得上 */}
      <div className="about-features" aria-label={t("about.featuresTitle")}>
        {FEATURES.map((f, i) => (
          <motion.div
            key={f.key}
            className="about-feature"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...springSoft, delay: staggerDelay(i) }}
          >
            <span className="about-feature-icon">{f.icon}</span>
            <span className="about-feature-text">{t(f.key)}</span>
          </motion.div>
        ))}
      </div>

      <div className="about-stack" aria-label={t("about.stackAria")}>
        {STACK.map((t) => (
          <span key={t} className="about-chip tabular">
            {t}
          </span>
        ))}
      </div>

      {/* ① 本项目仓库 —— 只留这一层（2026-11-12 删掉上游那组卡片） */}
      <div className="about-section">
        <span className="about-section-title">{t("about.localTitle")}</span>
      </div>
      <div className="about-links">
        {LOCAL_LINKS.map((l, i) => (
          <LinkCard key={l.url} item={l} delay={staggerDelay(i)} />
        ))}
      </div>
      {/* 出处只写这一句：从 ZFontManager 0.8.0 迭代而来。不再给上游链接与作者卡片 ——
          两个项目现在没有关系，放一排「去上游看代码」的卡片只会让人以为代码在别处。 */}
      <p className="about-upstream-note">{t("about.linksTitle")}</p>
    </motion.div>
  );
}
