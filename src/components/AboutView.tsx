import { invoke } from "@tauri-apps/api/core";
import { motion } from "motion/react";
import {
  ArrowUpRight,
  Globe,
  Puzzle,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Star,
} from "lucide-react";
import { spring, springSoft, staggerDelay } from "../design/springs";
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
 * 链接区分上下两层（2026-11-10 定）。
 *
 * 这一页的信息其实是两件事，原来压在同一个列表里，读者分不出来：
 *   ① 「这个版本是谁做的、代码在哪」—— 本项目自己的两个仓库；
 *   ② 「它从哪来」—— 上游原作者的主页与仓库。
 *
 * 版式照用户给的参考图统一：**圆角玻璃卡、两列铺开、左图标 + 标题 + 一行描述**。
 * 两层各用一个小分组标题分开（9px 等宽强调蓝，R4 第 4 级的做法），
 * 不再用「整个列表一根分隔线」那种把两类信息混在一起的做法。
 *
 * 顺带说明一处**故意不改**的地方：`about.source` 的仓库名仍是 `ZFontManager`。
 * 上游原名就是它，本项目后来才改名 FontManager，这条链接必须指向上游原名，
 * 跟着改名会 404。
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

const UPSTREAM_LINKS: LinkItem[] = [
  {
    key: "about.source",
    sub: "github.com/TheHolyOneZ/ZFontManager",
    url: "https://github.com/TheHolyOneZ/ZFontManager",
    icon: <GithubGlyph />,
  },
  {
    key: "about.githubUser",
    sub: "github.com/TheHolyOneZ",
    url: "https://github.com/TheHolyOneZ",
    icon: <GithubGlyph />,
  },
];

/** 一张链接卡。两层共用，保证两张网格长得完全一样 */
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
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.99 }}
    >
      <span className="about-link-icon">{item.icon}</span>
      <span className="about-link-text">
        <span className="about-link-label">{t(item.key)}</span>
        <span className="about-link-sub detail-mono">{item.sub}</span>
      </span>
      <ArrowUpRight size={14} strokeWidth={1.5} className="about-link-arrow" />
    </motion.button>
  );
}

const STACK = ["Tauri v2", "Rust", "React 19", "TypeScript", "Vite", "pnpm"];

/** 这款软件现在真正有的能力（2026-11-05 重写口径：与 README 功能导览一致） */
const FEATURES: { key: TKey; icon: React.ReactNode }[] = [
  { key: "about.featPreview", icon: <Search size={14} strokeWidth={1.5} /> },
  { key: "about.featToggle", icon: <SlidersHorizontal size={14} strokeWidth={1.5} /> },
  { key: "about.featOrganize", icon: <Star size={14} strokeWidth={1.5} /> },
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

      {/* ① 本项目仓库 —— 这两张是本版真正的「去哪儿看代码」，放上面 */}
      <div className="about-section">
        <span className="about-section-title">{t("about.localTitle")}</span>
      </div>
      <div className="about-links">
        {LOCAL_LINKS.map((l, i) => (
          <LinkCard key={l.url} item={l} delay={staggerDelay(i)} />
        ))}
      </div>

      {/* ② 上游项目 —— 说清血缘，用同一套卡片，避免两类链接混在一张网格里 */}
      <div className="about-section">
        <span className="about-section-title">{t("about.upstreamTitle")}</span>
      </div>
      <div className="about-links">
        {UPSTREAM_LINKS.map((l, i) => (
          <LinkCard key={l.url} item={l} delay={staggerDelay(i + LOCAL_LINKS.length)} />
        ))}
      </div>
      <p className="about-upstream-note">{t("about.linksTitle")}</p>
    </motion.div>
  );
}
