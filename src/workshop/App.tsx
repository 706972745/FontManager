import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Check, CircleHelp, Download, Puzzle, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyWorkshopFilters,
  humanBytes,
  meetsMinAppVersion,
  parseWorkshopIndexStrict,
  touchesFontLibrary,
  workshopAuthorLabel,
  type WorkshopEntry,
  type WorkshopKindFilter,
  type WorkshopRuntime,
} from "../lib/workshop.ts";
import {
  BadRegistryDirError,
  fetchIndexText,
  installRequestFor,
  panelApi,
  releaseBlurGuard,
  PanelSessionExpired,
  type InstalledPlugin,
  type PanelRuntimes,
} from "./api.ts";
import { isPanelLocale, panelT, type PanelLocale } from "./i18n.ts";
import { UploadDialog } from "./UploadDialog.tsx";

/**
 * 插件中心面板（M1，v3）。
 *
 * 页面骨架照搬在线页（OnlineView）的实现与 CSS 模式：顶栏搜索 + 筛选 chips、
 * 信息行、卡片网格、右侧详情弹层。面板是独立产物，所以：
 * - 自己的 i18n（`i18n.ts`，跟随主程序下发的语言）；
 * - 自己的 CSS（`panel.css`，不依赖主包的 token）；
 * - 安装/卸载一律走主程序的回环服务（自己碰不到文件系统）。
 */

/** 与在线页同一个「X 分钟前更新」口径 */
function ago(fetchedAt: number, locale: PanelLocale): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - fetchedAt);
  if (secs < 3600) return panelT(locale, "updatedMinutes", { count: Math.max(1, Math.floor(secs / 60)) });
  if (secs < 86400) return panelT(locale, "updatedHours", { count: Math.floor(secs / 3600) });
  return panelT(locale, "updatedDays", { count: Math.floor(secs / 86400) });
}

const KIND_FILTERS: WorkshopKindFilter[] = ["all", "official", "community"];
const RUNTIME_FILTERS = ["python", "node", "none"] as const;

/** 缓存有效期（毫秒）：与在线页一致，1 分钟内不重复拉 */
const CACHE_TTL_MS = 60_000;

interface Cache {
  entries: WorkshopEntry[];
  fetchedAt: number;
}
let cache: Cache | null = null;

/**
 * 清单缓存**落盘**（2026-11-15 用户：「插件中心加载的有点慢」）。
 *
 * 根因：面板每次打开都是一个**新窗口**，模块级 `cache` 随窗口销毁 ——
 * 所以「1 分钟缓存」只在同一次打开里有效，每次点开都要重新走一遍
 * raw.githubusercontent.com（这个域名在国内又时快时慢）。
 *
 * 做法：成功拉到清单后写进 localStorage，下次打开**同步**读出来先渲染，
 * 再在后台按 TTL 决定要不要刷新。用户看到的是「秒开 + 数据可能旧 1 分钟」，
 * 而不是「空白等网络」。
 */
const INDEX_CACHE_KEY = "fontmanager.workshop.index.v1";
/** 超过这个体积就不写盘：清单正常几十 KB，3MB 只可能是异常数据，别把配额顶爆 */
const INDEX_CACHE_MAX_CHARS = 3_000_000;

let hydrated: Cache | null | undefined;

function persistedCache(): Cache | null {
  if (hydrated !== undefined) return hydrated;
  hydrated = null;
  try {
    const raw = localStorage.getItem(INDEX_CACHE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Cache;
      if (Array.isArray(v?.entries) && typeof v?.fetchedAt === "number") {
        hydrated = { entries: v.entries, fetchedAt: v.fetchedAt };
      }
    }
  } catch {
    // 隐私模式 / 配额异常 / JSON 坏了：当没有缓存，走网络
  }
  return hydrated;
}

function savePersistedCache(c: Cache) {
  try {
    const payload = JSON.stringify({ entries: c.entries, fetchedAt: c.fetchedAt });
    if (payload.length > INDEX_CACHE_MAX_CHARS) return;
    localStorage.setItem(INDEX_CACHE_KEY, payload);
  } catch {
    // 写不进去不影响本次使用
  }
}

function readSession(): { locale: PanelLocale; theme: string } {
  const params = new URLSearchParams(location.search);
  const lang = params.get("lang");
  const theme = params.get("theme") ?? "system";
  return { locale: isPanelLocale(lang) ? lang : "en", theme };
}

export function WorkshopPanel() {
  const { locale, theme } = useMemo(readSession, []);
  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => panelT(locale, key, vars),
    [locale],
  );

  // 主题：主程序下发（?theme=light|dark|system）；system 交给系统的 prefers-color-scheme
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = locale;
  }, [theme, locale]);

  /**
   * 面板窗口**重新拿到焦点** = 用户从「系统文件对话框 / 外部浏览器」回来了
   * → 把失焦守位清掉，恢复「点别处就藏」的正常行为。
   */
  useEffect(() => {
    const onFocus = () => releaseBlurGuard();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // 首帧就用上次落盘的清单（有的话）：面板每次都是新窗口，等网络 = 每次都要看
  // 一遍「正在读取社区插件清单…」。读盘是同步的，所以第一帧就有内容。
  const [entries, setEntries] = useState<WorkshopEntry[] | null>(
    () => persistedCache()?.entries ?? null,
  );
  const [fetchedAt, setFetchedAt] = useState<number | null>(
    () => persistedCache()?.fetchedAt ?? null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<WorkshopKindFilter>("all");
  const [runtime, setRuntime] = useState<"any" | "python" | "node" | "none">("any");
  const [installedOnly, setInstalledOnly] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [runtimes, setRuntimes] = useState<PanelRuntimes>({ python: false, node: false });
  const [appVersion, setAppVersion] = useState<string>("");
  // 本地 API 开关：默认按「开着」渲染，等服务端答复再纠正 —— 否则每次开面板
  // 都会先闪一条「API 关着」的红条（老版本主程序不返回这个字段，也走这条默认）。
  const [apiEnabled, setApiEnabled] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  /** 上传弹窗（M3）：面板里直接完成，不跳网页 */
  const [uploadOpen, setUploadOpen] = useState(false);

  const installedIds = useMemo(() => new Set(installed.map((p) => p.id)), [installed]);

  /**
   * 拉清单：普通进来用 1 分钟缓存，刷新强拉。
   *
   * 返回这次**实际拿到**的条目（缓存命中就是缓存里的），失败返回空数组 ——
   * 调用方（安装自愈重试）要的是「此刻的最新清单」，不能回头去读模块级
   * `cache`：TS 在 `cache = null` 之后会把它的类型收窄成 `null`，
   * 而且 `load` 内部的赋值对调用方的类型收窄也不可见。
   */
  const load = useCallback(async (force: boolean): Promise<WorkshopEntry[]> => {
    // 两级缓存：模块级（同一次打开内）→ localStorage（跨窗口）。
    // 只有后者能让「点开面板」不再每次都等网络。
    if (!force) {
      const hit = cache ?? persistedCache();
      if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
        cache = hit;
        setEntries(hit.entries);
        setFetchedAt(hit.fetchedAt);
        return hit.entries;
      }
    }
    setLoading(true);
    setError(null);
    try {
      const text = await fetchIndexText();
      const index = parseWorkshopIndexStrict(text);
      const next: Cache = { entries: index.entries, fetchedAt: Date.now() };
      cache = next;
      savePersistedCache(next);
      // 再往主程序的数据目录写一份（跨窗口/跨重启都在）—— 尽力而为，失败不影响本次
      void panelApi.setIndexCache(next.entries, next.fetchedAt).catch(() => {});
      setEntries(next.entries);
      setFetchedAt(next.fetchedAt);
      return next.entries;
    } catch (err) {
      setError(String(err));
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * 把面板的错误翻译成一句本地化的话。
   *
   * 服务端的报错原文是中文（Rust 侧统一口径），直接透给界面会让 8 个
   * 非中文用户在报错时看到中文。所以：**会话失效**（唯一有明确分类的）
   * 走本地化文案；其余错误用本地化的「动作失败」打头，细节照原样附在后面
   * ——细节是排障信息，翻译不了就保留原文，但不能让它顶在前面。
   */
  const describeError = useCallback(
    (err: unknown, action: "install" | "uninstall" | "query"): string => {
      if (err instanceof PanelSessionExpired) return t("sessionExpired");
      // 清单的目录字段不合法：给一句准话，别把路径糊到界面上
      if (err instanceof BadRegistryDirError) return t("badDir");
      const detail = err instanceof Error ? err.message : String(err);
      if (action === "install") return `${t("installFailed")}: ${detail}`;
      if (action === "uninstall") return `${t("uninstallFailed")}: ${detail}`;
      return detail;
    },
    [t],
  );

  /**
   * 权限名 → 人话。
   *
   * 字典里没有这条（主程序将来新增了权限）就退回显示原始权限名 ——
   * `panelT` 查不到会原样返回 key，界面上就会冒出「perm.read:xxx」这种鬼东西。
   */
  const permText = useCallback(
    (p: string) => {
      const key = `perm.${p}`;
      const text = t(key);
      return text === key ? p : text;
    },
    [t],
  );

  /** 已装清单 + 解释器探活 + 主程序版本 + 本地 API 开关（主程序侧查） */
  const refreshInstalled = useCallback(async () => {
    try {
      const res = await panelApi.plugins();
      setInstalled(res.plugins);
      setRuntimes(res.runtimes);
      setAppVersion(res.appVersion ?? "");
      // 老版本主程序不返回这个字段 → undefined → 按「开着」处理，不误报
      setApiEnabled(res.apiEnabled !== false);
      // 首次导览：只在第一次拿到状态时决定，之后手动「重看」不受影响
      if (!tourInit.current) {
        tourInit.current = true;
        if (res.tourDone !== true) setTourStep(0);
      }
    } catch (err) {
      setNotice(describeError(err, "query"));
    }
  }, [describeError]);

  useEffect(() => {
    let alive = true;
    // 首屏三级缓存（2026-11-15，用户反馈「加载有点慢」）：
    //   ① localStorage —— 同一次运行内再打开面板（端口不变）时**同步**命中，第一帧就有内容；
    //   ② 主程序数据目录 —— 跨重启都在（面板端口随机，localStorage 的 origin 会变）；
    //   ③ 网络 —— 前面都没有、或者已经过期，才去拉 index.json。
    // ② 是本地回环，毫秒级；只有 ③ 才慢，而 ③ 现在只负责「后台刷新」。
    void (async () => {
      if (!cache) {
        try {
          const r = await panelApi.getIndexCache();
          const c = r.cache;
          if (alive && c && Array.isArray(c.entries) && c.entries.length > 0) {
            const restored: Cache = {
              entries: c.entries as WorkshopEntry[],
              fetchedAt: typeof c.fetchedAt === "number" ? c.fetchedAt : 0,
            };
            cache = restored;
            savePersistedCache(restored);
            setEntries(restored.entries);
            setFetchedAt(restored.fetchedAt);
          }
        } catch {
          // 老版本主程序没有这个端点：当作没有缓存，走网络
        }
      }
      const hit = cache ?? persistedCache();
      const fresh = hit ? Date.now() - hit.fetchedAt < CACHE_TTL_MS : false;
      // 过期或没有：后台刷新（有缓存时界面已经有内容了，不会白屏）
      if (!fresh) void load(false);
    })();
    void refreshInstalled();
    return () => {
      alive = false;
    };
  }, [load, refreshInstalled]);

  const visible = useMemo(() => {
    if (!entries) return [];
    return applyWorkshopFilters(entries, { query, kind, runtime, installedOnly, installedIds });
  }, [entries, query, kind, runtime, installedOnly, installedIds]);

  const detail = useMemo(
    () => entries?.find((e) => e.id === detailId) ?? null,
    [entries, detailId],
  );

  // 首次温馨提醒：localStorage 记忆已读（方案 §7.3 第 1 条）
  const [bannerSeen, setBannerSeen] = useState(() => {
    try {
      return localStorage.getItem("workshop.noticeAck") === "1";
    } catch {
      return false;
    }
  });
  const dismissBanner = () => {
    try {
      localStorage.setItem("workshop.noticeAck", "1");
    } catch {
      // 隐私模式下写不了：退化为每次都显示（多看一眼没坏处）
    }
    setBannerSeen(true);
  };

  /**
   * 首次导览（-1 = 不显示）。**状态在主程序 prefs 里**（`tourDone`），不在
   * 面板的 localStorage —— 面板窗口每次打开都是随机端口，origin 一变
   * localStorage 就换一份，导览会每次都弹（2026-11-15 实测）。
   * 初值给 -1，等 `/api/plugins` 答复再决定弹不弹，避免老用户闪一下。
   */
  const TOUR_STEPS = 3;
  const [tourStep, setTourStep] = useState<number>(-1);
  const tourInit = useRef(false);
  const endTour = () => {
    setTourStep(-1);
    // 写失败不影响本次关闭：下次打开顶多再讲一遍
    void panelApi.markTourDone().catch(() => {});
  };

  const runtimeReady = useCallback(
    (r: WorkshopRuntime): boolean => {
      if (!r) return true;
      return r === "python" ? runtimes.python : runtimes.node;
    },
    [runtimes],
  );

  /** sha 校验失败 = registry 刚更新过、面板手里还是旧清单（raw 有几分钟 CDN 缓存） */
  const isShaMismatch = (err: unknown): boolean => {
    const detail = err instanceof Error ? err.message : String(err);
    return detail.includes("sha256 校验失败");
  };

  const onInstall = async (entry: WorkshopEntry) => {
    setBusyId(entry.id);
    setNotice(null);
    const done = async (e: WorkshopEntry) => {
      await panelApi.install(installRequestFor(e));
      await refreshInstalled();
      // 装完 ≠ 能用：插件默认是关的；本地 API 若也关着，插件连数据都读不到。
      // 两条都如实说清楚，但**只提示、不替用户开**（开关在设置页，是用户的决定）。
      setNotice(
        `${t("installedToast", { name: e.name, version: e.version })} ${
          apiEnabled ? t("installHint") : t("apiOff")
        }`,
      );
    };
    try {
      await done(entry);
    } catch (err) {
      if (isShaMismatch(err)) {
        // 清单陈旧自愈：清掉 1 分钟缓存强拉一次 index.json，用新清单再试一回；
        // sha256 硬门槛本身不放宽（缺/不符一律拒），自愈只发生在面板侧。
        try {
          cache = null;
          const freshEntries = await load(true);
          const fresh = freshEntries.find((e) => e.id === entry.id) ?? entry;
          await done(fresh);
        } catch (retryErr) {
          setNotice(
            isShaMismatch(retryErr) ? t("staleRegistry") : describeError(retryErr, "install"),
          );
        }
      } else {
        setNotice(describeError(err, "install"));
      }
    } finally {
      setBusyId(null);
    }
  };

  const onUninstall = async (entry: WorkshopEntry) => {
    setBusyId(entry.id);
    setNotice(null);
    try {
      await panelApi.uninstall(entry.id);
      await refreshInstalled();
      setNotice(t("uninstalledToast", { name: entry.name }));
    } catch (err) {
      setNotice(describeError(err, "uninstall"));
    } finally {
      setBusyId(null);
    }
  };

  // 错误态 / 加载态 / 正常态（与在线页同一骨架，不白屏）
  if (error && !entries) {
    return (
      <motion.div className="ws-empty" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
        <span className="ws-empty-tile"><Puzzle size={26} strokeWidth={1.5} /></span>
        <h2>{t("errorTitle")}</h2>
        <p className="ws-mono">{error}</p>
        <button className="ws-cta" onClick={() => void load(true)}>
          <RefreshCw size={14} strokeWidth={1.5} /> {t("retry")}
        </button>
      </motion.div>
    );
  }

  if (loading && !entries) {
    return (
      <motion.div className="ws-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <span className="ws-empty-tile"><Puzzle size={26} strokeWidth={1.5} /></span>
        <h2>{t("loadingTitle")}</h2>
        <p>{t("loadingBody")}</p>
      </motion.div>
    );
  }

  return (
    <div className="ws-view">
      {/* 面板标题：独立窗口（不是主程序里的一页），得自己说清「这是什么」。
          图标用 lucide `Puzzle`（拼图块）—— 尺寸与 strokeWidth 照同区域的
          工具栏图标：13 / 1.5（与刷新按钮那个一致）。 */}
      <header className="ws-head">
        <Puzzle size={13} strokeWidth={1.5} className="ws-head-icon" />
        <h1 className="ws-head-title">{t("title")}</h1>
        <span className="ws-spacer" />
        {/* 上传插件（M3）：全流程在面板内完成（弹窗），不跳网页。
            放在这里是因为它是**作用于整个中心**的动作，和刷新/帮助同级。 */}
        <button className="ws-upload-btn" onClick={() => setUploadOpen(true)}>
          <Upload size={13} strokeWidth={1.5} />
          {t("upload")}
        </button>
        {/* 重看导览：看过的用户也可能想再确认一遍「装完还要自己开」这件事 */}
        <button
          className="ws-head-help"
          onClick={() => setTourStep(0)}
          aria-label={t("tourReplay")}
          title={t("tourReplay")}
        >
          <CircleHelp size={13} strokeWidth={1.5} />
        </button>
      </header>
      <div className="ws-bar">
        <div className="ws-search">
          <Search size={14} strokeWidth={1.5} className="ws-search-icon" />
          <input
            className="ws-search-input"
            type="text"
            value={query}
            placeholder={t("searchPlaceholder")}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t("searchPlaceholder")}
          />
          {query && (
            <button className="ws-clear" onClick={() => setQuery("")} aria-label="clear">
              <X size={12} strokeWidth={2} />
            </button>
          )}
        </div>
        <div className="ws-chips" role="group" aria-label={t("filter.all")}>
          {KIND_FILTERS.map((k) => (
            <button
              key={k}
              className={`ws-chip${kind === k ? " ws-chip-on" : ""}`}
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
            >
              {t(`filter.${k}`)}
            </button>
          ))}
        </div>
        <div className="ws-chips" role="group" aria-label={t("runtimeNone")}>
          {RUNTIME_FILTERS.map((r) => (
            <button
              key={r}
              className={`ws-chip${runtime === r ? " ws-chip-on" : ""}`}
              onClick={() => setRuntime(r)}
              aria-pressed={runtime === r}
            >
              {r === "none" ? t("runtimeNone") : r === "python" ? "Python" : "Node"}
            </button>
          ))}
        </div>
        <label className="ws-toggle">
          <input
            type="checkbox"
            checked={installedOnly}
            onChange={(e) => setInstalledOnly(e.target.checked)}
          />
          <span>{t("installedOnly")}</span>
        </label>
      </div>

      <div className="ws-meta">
        <span className="ws-tabular">{t("count", { count: visible.length })}</span>
        {fetchedAt && <span>· {ago(fetchedAt, locale)}</span>}
        <button className="ws-refresh" onClick={() => void load(true)} disabled={loading}>
          <RefreshCw size={13} strokeWidth={1.5} className={loading ? "ws-spin" : undefined} />
          {t("refresh")}
        </button>
        {notice && <span className="ws-notice">{notice}</span>}
      </div>

      {!bannerSeen && (
        <div className="ws-banner" role="note">
          <span className="ws-banner-text">{t("banner")}</span>
          <button className="ws-banner-close" onClick={dismissBanner} aria-label={t("bannerDismiss")}>
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      )}

      {/* 本地 API 关着：装了也读不到数据。只提醒，**不替用户打开** ——
          那个开关在设置页，属于用户自己的决定（方案 §7.3 的同一条口径）。 */}
      {!apiEnabled && (
        <div className="ws-apiwarn" role="status">
          <AlertTriangle size={13} strokeWidth={1.8} className="ws-apiwarn-icon" />
          <span className="ws-apiwarn-text">{t("apiOff")}</span>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="ws-empty">
          <h2>{t("emptyTitle")}</h2>
          <p>{t("emptyBody")}</p>
        </div>
      ) : (
        <div className="ws-grid">
          {visible.map((entry, i) => (
            <WsCard
              key={entry.id}
              entry={entry}
              index={i}
              installed={installedIds.has(entry.id)}
              t={t}
              onOpen={() => setDetailId(entry.id)}
            />
          ))}
        </div>
      )}

      <p className="ws-footer">{t("footer")}</p>

      <AnimatePresence>
        {detail && (
          <motion.div
            className="ws-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => !busyId && setDetailId(null)}
          >
            <motion.div
              className="ws-detail"
              role="dialog"
              aria-modal="true"
              aria-label={detail.name}
              initial={{ opacity: 0, y: 24, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.98 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="ws-detail-head">
                <div>
                  <h2 className="ws-detail-name">{detail.name}</h2>
                  <div className="ws-detail-sub">
                    <span>{workshopAuthorLabel(detail) || t("officialBadge")}</span>
                    <span>· v{detail.version || "?"}</span>
                    {detail.runtime && (
                      <span>· {detail.runtime === "python" ? "Python" : "Node"}</span>
                    )}
                  </div>
                </div>
                <button className="ws-clear" onClick={() => setDetailId(null)} aria-label="close">
                  <X size={14} strokeWidth={2} />
                </button>
              </div>

              {detail.detail && <p className="ws-detail-desc">{detail.detail}</p>}

              {/* 运行时缺失提示（M1 只出文案，自动下载在 M4） */}
              {!runtimeReady(detail.runtime) && (
                <p className="ws-runtime-note">
                  {t("runtimeMissing", {
                    runtime: detail.runtime === "python" ? "Python" : "Node",
                  })}
                </p>
              )}
              {appVersion && !meetsMinAppVersion(appVersion, detail.minAppVersion) && (
                <p className="ws-runtime-note">
                  {t("minApp", { version: detail.minAppVersion ?? "" })}
                </p>
              )}

              {/* 会改动字体库文件夹的插件：安装前必须让用户看清（2026-11-15 用户要求）。
                  判定只看权限（`touchesFontLibrary`），不看插件自己的描述。 */}
              {touchesFontLibrary(detail.permissions) && (
                <div className="ws-libwarn" role="alert">
                  <AlertTriangle size={14} strokeWidth={1.8} className="ws-libwarn-icon" />
                  <div className="ws-libwarn-text">
                    <p className="ws-libwarn-title">{t("libWarnTitle")}</p>
                    <p className="ws-libwarn-body">{t("libWarnBody")}</p>
                  </div>
                </div>
              )}

              {/* 权限：逐条给「权限名 + 人话」。只列出，不授予 —— 真正的授权
                  发生在用户打开插件开关的那一刻（设置页），面板不碰权限。 */}
              {detail.permissions.length > 0 ? (
                <div className="ws-section">
                  <span className="ws-section-label">{t("permTitle")}</span>
                  <ul className="ws-perms">
                    {detail.permissions.map((p) => (
                      <li key={p} className="ws-perm-row">
                        <code className="ws-perm-name">{p}</code>
                        <span className="ws-perm-desc">{permText(p)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="ws-perm-none">{t("permNone")}</p>
              )}

              {!detail.official && detail.files && detail.files.length > 0 && (
                <div className="ws-section">
                  <span className="ws-section-label">{t("files")}</span>
                  <ul className="ws-files">
                    {detail.files.map((f) => (
                      <li key={f.path}>
                        <span className="ws-mono ws-file-name">{f.path}</span>
                        <span className="ws-file-size">{humanBytes(f.size) ?? ""}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="ws-detail-foot">
                <span className="ws-mono ws-source">
                  {detail.official
                    ? t("sourceOfficial")
                    : t("sourceCommunity", { author: workshopAuthorLabel(detail) })}
                </span>
                <div className="ws-actions">
                  {installedIds.has(detail.id) ? (
                    <button
                      className="ws-btn ws-btn-ghost"
                      onClick={() => void onUninstall(detail)}
                      disabled={!!busyId}
                    >
                      {busyId === detail.id ? (
                        <RefreshCw size={14} strokeWidth={1.5} className="ws-spin" />
                      ) : (
                        <Trash2 size={14} strokeWidth={1.5} />
                      )}
                      {t("uninstall")}
                    </button>
                  ) : (
                    <button
                      className="ws-btn ws-btn-primary"
                      onClick={() => void onInstall(detail)}
                      disabled={!!busyId}
                    >
                      {busyId === detail.id ? (
                        <>
                          <RefreshCw size={14} strokeWidth={1.5} className="ws-spin" />
                          {t("installing")}
                        </>
                      ) : (
                        <>
                          <Download size={14} strokeWidth={1.5} />
                          {t("install")}
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 上传弹窗（M3）：连账号 → 选文件夹 → 填清单 → 提交 PR，全在面板内 */}
      <AnimatePresence>
        {uploadOpen && (
          <UploadDialog t={t} locale={locale} onClose={() => setUploadOpen(false)} />
        )}
      </AnimatePresence>

      {/* 首次导览：三步，讲清「来源 / 权限 / 装完还要自己开」。
          只在第一次打开时出现，localStorage 记住已读。 */}
      <AnimatePresence>
        {tourStep >= 0 && (
          <motion.div
            className="ws-tour-mask"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="ws-tour"
              role="dialog"
              aria-modal="true"
              aria-label={t(`tour${tourStep + 1}Title`)}
              initial={{ opacity: 0, y: 18, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="ws-tour-head">
                <span className="ws-tour-count">
                  {tourStep + 1} / {TOUR_STEPS}
                </span>
                <button className="ws-clear" onClick={endTour} aria-label={t("tourSkip")}>
                  <X size={13} strokeWidth={2} />
                </button>
              </div>
              <h3 className="ws-tour-title">{t(`tour${tourStep + 1}Title`)}</h3>
              <p className="ws-tour-body">{t(`tour${tourStep + 1}Body`)}</p>
              <div className="ws-tour-actions">
                <button className="ws-btn ws-btn-ghost" onClick={endTour}>
                  {t("tourSkip")}
                </button>
                <span className="ws-spacer" />
                {tourStep > 0 && (
                  <button
                    className="ws-btn ws-btn-ghost"
                    onClick={() => setTourStep(tourStep - 1)}
                  >
                    {t("tourPrev")}
                  </button>
                )}
                <button
                  className="ws-btn ws-btn-primary"
                  onClick={() => (tourStep < TOUR_STEPS - 1 ? setTourStep(tourStep + 1) : endTour())}
                >
                  {tourStep < TOUR_STEPS - 1 ? t("tourNext") : t("tourDone")}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function WsCard({
  entry,
  index,
  installed,
  t,
  onOpen,
}: {
  entry: WorkshopEntry;
  index: number;
  installed: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onOpen: () => void;
}) {
  const author = workshopAuthorLabel(entry);
  const sizeText = humanBytes(entry.size);
  return (
    <motion.article
      className="ws-card"
      tabIndex={0}
      role="button"
      aria-label={entry.name}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 24) * 0.04 }}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onOpen();
        }
      }}
    >
      <div className="ws-card-head">
        <span className="ws-card-name">{entry.name}</span>
        <span className="ws-spacer" />
        {entry.official ? (
          <span className="ws-author ws-author-official">{t("officialBadge")}</span>
        ) : (
          <span className={`ws-author${author === "anonymous" ? " ws-author-anon" : ""}`}>
            {author}
          </span>
        )}
        {installed && (
          <span className="ws-installed">
            <Check size={10} strokeWidth={2.5} /> {t("installedBadge")}
          </span>
        )}
      </div>
      {entry.brief && <p className="ws-card-brief">{entry.brief}</p>}
      <div className="ws-card-foot">
        <span>{entry.version || "?"}</span>
        {sizeText && <span>· {sizeText}</span>}
        {entry.runtime && (
          <span className="ws-runtime-chip">
            {entry.runtime === "python" ? "Python" : "Node"}
          </span>
        )}
        {/* 会动字体库的插件：在卡片上就标出来，别等点进详情才知道 */}
        {touchesFontLibrary(entry.permissions) && (
          <span className="ws-lib-chip" title={t("libWarnBody")}>
            <AlertTriangle size={9} strokeWidth={2} />
            {t("libWarnBadge")}
          </span>
        )}
      </div>
    </motion.article>
  );
}
