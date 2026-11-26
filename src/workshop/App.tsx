import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, ArrowUpCircle, Check, CircleHelp, Download, Puzzle, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyWorkshopFilters,
  communityDirFor,
  hasUpdate,
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
  probePluginDir,
  releaseBlurGuard,
  PanelSessionExpired,
  type InstalledPlugin,
  type PanelRuntimes,
} from "./api.ts";
import { isPanelLocale, panelT, type PanelLocale } from "./i18n.ts";
import { BlinkCaretInput } from "../design/primitives/BlinkCaretInput.tsx";
import { UploadDialog } from "./UploadDialog.tsx";
import { dropTakedown, pendingCount, readStore } from "./submissions.ts";
import { probePluginDirApi } from "./upload.ts";
import { STAGGER_CAP, STAGGER_STEP, scrimFade, springSoft } from "../design/springs.ts";

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
  // 刚点完「刷新」就显示「1 分钟前更新」，用户会以为按钮没反应 —— 1 分钟内说「刚刚」
  if (secs < 45) return panelT(locale, "updatedJustNow");
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

/**
 * 「已提交下架、清单还没重算」的插件（id → 提交时间），落 localStorage。
 *
 * 为什么要落盘：面板每次打开都是新窗口，模块级状态活不过一次关闭。下架后立刻关掉
 * 再打开，如果只靠内存，缓存里的旧清单会把它又摆回来 —— 看上去像「下架失败」。
 *
 * 30 分钟足够聚合脚本跑完（实测最慢 2 分半）；超时的标记直接丢掉，宁可多显示一次
 * 也不要永久藏掉一个其实还在架上的插件。
 */
const REMOVED_KEY = "fontmanager.workshop.removed.v1";
const REMOVED_TTL_MS = 30 * 60_000;

function readRemoved(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(REMOVED_KEY) ?? "{}") as Record<string, number>;
    const now = Date.now();
    const out: Record<string, number> = {};
    for (const [id, ts] of Object.entries(v ?? {})) {
      if (typeof ts === "number" && now - ts < REMOVED_TTL_MS) out[id] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

function saveRemoved(map: Record<string, number>) {
  try {
    localStorage.setItem(REMOVED_KEY, JSON.stringify(map));
  } catch {
    // 同上：写不进去只影响「重开面板后还藏不藏」，不影响本次
  }
}

function readSession(): { locale: PanelLocale; theme: string } {
  const params = new URLSearchParams(location.search);
  const lang = params.get("lang");
  const theme = params.get("theme") ?? "system";
  return { locale: isPanelLocale(lang) ? lang : "en", theme };
}

/**
 * 「宽限期到了、raw 探测还说目录在」→ 再问一次 GitHub API 才敢把它放回列表。
 *
 * raw 那条链路在国内常被 hosts 指到本地加速器：它**忽略查询串**、照缓存回 200，
 * 于是已经删掉的目录也会被探成「还在」。以前据此放回列表，表现就是
 * 「下架了，过一会儿又能点下架」（2026-11-26 用户报的第二条）。
 * API 的 contents 端点没这层缓存，404 才算没了；问不到（限流/断网）就维持隐藏。
 */
async function stillInRepo(
  ids: string[],
  dirOf: (id: string) => string | null,
): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    const dir = dirOf(id);
    if (!dir) continue;
    try {
      if (!(await probePluginDirApi(dir))) out.push(id);
    } catch {
      // 限流 / 断网：宁可继续藏着，也别把用户已经下架的东西放回来
    }
  }
  return out;
}

/**
 * 滚动条「靠近才变粗」—— 与主程序同一套（主包那份在 `src/App.tsx`）。
 *
 * 面板是独立产物，CSS 也只能自带（见 panel.css 末尾的 `*::-webkit-scrollbar`），
 * 但「1px 发丝线抓不住」这件事同样存在，所以这套交互也要搬过来：
 * 指针落在某个**能竖向滚动**的容器右缘 14px 内，就给该容器挂 `.scroll-hot`。
 *
 * 只判窗口右缘是不够的：上传弹窗的列表、详情弹层都缩在中间，窗口边上的判定
 * 永远不生效（主包 2026-11-10 二改就是为了这个）。指针压在滚动条本身时拿不到
 * mousemove，class 会保持上一次的结果 —— 正好，手按上去就能拖。
 */
function useScrollHot(): void {
  useEffect(() => {
    let raf = 0;
    let hot: HTMLElement | null = null;
    const clearHot = () => {
      hot?.classList.remove("scroll-hot");
      hot = null;
    };
    const onMove = (e: MouseEvent) => {
      if (raf) return;
      const { clientX, clientY, target } = e;
      raf = requestAnimationFrame(() => {
        raf = 0;
        let found: HTMLElement | null = null;
        for (let n = target as HTMLElement | null; n && n !== document.body; n = n.parentElement) {
          // 只有真能滚的容器才算（内容比可视区高），否则整页都会被误判
          if (n.scrollHeight - n.clientHeight <= 2) continue;
          const r = n.getBoundingClientRect();
          // 槽位 10px，再留 4px 余量：14px 内且指针确实在这个容器的上下范围里
          if (
            clientX >= r.right - 14 &&
            clientX <= r.right + 1 &&
            clientY >= r.top &&
            clientY <= r.bottom
          ) {
            found = n;
            break;
          }
        }
        if (found !== hot) {
          clearHot();
          if (found) found.classList.add("scroll-hot");
          hot = found;
        }
      });
    };
    const onLeave = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      clearHot();
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("mouseleave", onLeave);
    window.addEventListener("blur", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("blur", onLeave);
      if (raf) cancelAnimationFrame(raf);
      clearHot();
    };
  }, []);
}

export function WorkshopPanel() {
  // 全软件统一的滚动条手感：靠近容器右缘才从 1px 变 6px
  useScrollHot();

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
  /**
   * 本机已知「刚下架、清单还没重算」的插件（id → 提交时间）。
   *
   * 下架是作者点一下就生效的，但 `index.json` 要等仓库里的聚合脚本重算
   * （实测 10 秒到 2 分半都有），这中间中心里还挂着那个插件 —— 用户看到的就是
   * 「已经下架了还在显示，刷新也没用」。既然面板**确定**这次提交成功了，
   * 就先在本地把它藏掉，等新清单确认它真的没了再把标记清掉。
   */
  const [removed, setRemoved] = useState<Record<string, number>>(() => {
    const base = readRemoved();
    // 持久的下架记录也参与「先藏起来」：同一窗口里重开弹窗、重渲染都必须还认得它，
    // 否则灰条会变回「可以下架」（2026-11-26 用户反馈的那条）。
    for (const rec of readStore().takedowns) {
      if (base[rec.id] === undefined) base[rec.id] = rec.at;
    }
    return base;
  });
  /**
   * 「我提交了、但还没落地」的条数（上传等合并 + 下架等生效）。
   *
   * 它只影响一件事：**要不要持续强拉清单**。有未落地的动作时每 15 秒拉一次，
   * 合并 / 生效后中心里就能自己冒出来，不用用户手动点刷新。
   */
  const [subsVersion, setSubsVersion] = useState(0);
  const pendingSubs = useMemo(() => pendingCount(), [subsVersion]);
  const onSubsChanged = useCallback(() => setSubsVersion((n) => n + 1), []);

  const installedIds = useMemo(() => new Set(installed.map((p) => p.id)), [installed]);
  /**
   * 本机**已装版本**（2026-11-19 用户要求「有更新就给个按钮」）。
   *
   * 判据只看清单版本 vs 这里：`hasUpdate` 为 true 才出「更新」。
   * 不用 id 是否存在来判断 —— 已装但同版本不该显示「更新」，
   * 那是让用户白点一次（下载 + 重装 + 丢运行状态）。
   */
  const installedVersions = useMemo(
    () => new Map(installed.map((p) => [p.id, p.version])),
    [installed],
  );
  /** 这个条目能不能更新；返回清单版本（给按钮显示「更新到 vX」），不能更新返回 null */
  const updateTarget = useCallback(
    (entry: WorkshopEntry): string | null =>
      hasUpdate(entry.version, installedVersions.get(entry.id)) ? entry.version ?? null : null,
    [installedVersions],
  );

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
      // force（用户点刷新 / 下架后的轮询）必须绕开 raw 的 5 分钟缓存，否则拿回来
      // 的还是旧清单，看起来就是「刷新按钮没用」。
      const text = await fetchIndexText({ fresh: force });
      const index = parseWorkshopIndexStrict(text);
      const next: Cache = { entries: index.entries, fetchedAt: Date.now() };
      cache = next;
      savePersistedCache(next);
      // 再往主程序的数据目录写一份（跨窗口/跨重启都在）—— 尽力而为，失败不影响本次
      void panelApi.setIndexCache(next.entries, next.fetchedAt).catch(() => {});
      setEntries(next.entries);
      setFetchedAt(next.fetchedAt);
      // 新清单里已经没有的「待生效」标记可以收工了（它真的下架了）
      setRemoved((prev) => {
        const ids = Object.keys(prev);
        if (!ids.length) return prev;
        const present = new Set(next.entries.map((e) => e.id));
        const kept: Record<string, number> = {};
        let changed = false;
        for (const [id, ts] of Object.entries(prev)) {
          if (present.has(id)) kept[id] = ts;
          else changed = true;
        }
        if (!changed) return prev;
        saveRemoved(kept);
        return kept;
      });
      return next.entries;
    } catch (err) {
      setError(String(err));
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * 弹窗「请求面板强拉一次清单」用的回调。
   * 必须是**稳定的**：它进了弹窗那两个轮询 effect 的依赖数组，
   * 每次父组件重渲染都换一个新函数的话，定时器会被反复重置（探测节奏全乱）。
   */
  const refreshIndex = useCallback(() => void load(true), [load]);

  /**
   * 把面板的错误翻译成一句本地化的话。
   *
   * 服务端的报错原文是中文（Rust 侧统一口径），直接透给界面会让 8 个
   * 非中文用户在报错时看到中文。所以：**会话失效**（唯一有明确分类的）
   * 走本地化文案；其余错误用本地化的「动作失败」打头，细节照原样附在后面
   * ——细节是排障信息，翻译不了就保留原文，但不能让它顶在前面。
   */
  const describeError = useCallback(
    (err: unknown, action: "install" | "update" | "uninstall" | "query"): string => {
      if (err instanceof PanelSessionExpired) return t("sessionExpired");
      // 清单的目录字段不合法：给一句准话，别把路径糊到界面上
      if (err instanceof BadRegistryDirError) return t("badDir");
      const detail = err instanceof Error ? err.message : String(err);
      if (action === "install") return `${t("installFailed")}: ${detail}`;
      if (action === "update") return `${t("updateFailed")}: ${detail}`;
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
      // 首帧用缓存，随后**每次都**再拉一份真实清单（stale-while-revalidate）。
      //
      // 以前这里是「命中 1 分钟 TTL 就不拉」：刚下架的插件还挂在缓存里，点开面板
      // 看到的却是旧状态，用户只能反复点刷新 —— 而这正是「刷新按钮没用」的来源。
      // 现在缓存只负责「别白屏」，数据永远以新拉的为准。
      if (hit) void load(true);
      else void load(false);
    })();
    void refreshInstalled();
    return () => {
      alive = false;
    };
  }, [load, refreshInstalled]);

  const visible = useMemo(() => {
    if (!entries) return [];
    // 已经在本机确认下架、只是清单还没重算的那些先藏掉（见 `removed` 的注释）
    const live = Object.keys(removed).length
      ? entries.filter((e) => removed[e.id] === undefined)
      : entries;
    return applyWorkshopFilters(live, { query, kind, runtime, installedOnly, installedIds });
  }, [entries, removed, query, kind, runtime, installedOnly, installedIds]);

  const detail = useMemo(() => {
    if (!detailId || removed[detailId] !== undefined) return null;
    return entries?.find((e) => e.id === detailId) ?? null;
  }, [entries, detailId, removed]);
  /** 详情里这个插件能不能更新（能则新版号，不能则 null） */
  const detailUpdate = useMemo(
    () => (detail ? updateTarget(detail) : null),
    [detail, updateTarget],
  );

  /**
   * 下架提交成功 → 立刻从中心里藏掉。
   *
   * 不等聚合脚本：`index.json` 重算实测 10 秒到 2 分半，这中间中心里还挂着它，
   * 用户怎么点刷新都是旧的。本地先藏，再靠下面的轮询确认。
   */
  const markRemoved = useCallback((id: string) => {
    setRemoved((prev) => {
      if (prev[id] !== undefined) return prev;
      const next = { ...prev, [id]: Date.now() };
      saveRemoved(next);
      return next;
    });
    // 详情层正开着这一条的话一并关掉，否则会看到「详情还在、列表没了」
    setDetailId((cur) => (cur === id ? null : cur));
  }, []);

  /** 只认「有哪些 id」，避免每次 tick 都把定时器重置一遍 */
  const removedKey = useMemo(() => Object.keys(removed).sort().join(","), [removed]);

  // 轮询里要读最新值，但不该因为 entries 每 20 秒换一份就把定时器重置掉
  const entriesRef = useRef<WorkshopEntry[] | null>(entries);
  entriesRef.current = entries;
  const removedRef = useRef(removed);
  removedRef.current = removed;

  /**
   * 盯着「到底删掉了没有」，直到确认。
   *
   * 判定顺序（2026-11-25 真机踩出来的）：
   * 1. **目录探测为准**：`plugins/<dir>/plugin.json` 回 404 就是真没了。清单
   *    （`index.json`）会经过浏览器缓存 / CDN / 用户自己装的加速器，这台机器上
   *    实测能旧好几分钟。用户看到的「已经下架了还显示」就是这份旧清单。
   * 2. 清单本身也继续定时强拉：聚合脚本跑完后，这一行会自然消失（不用等探测）。
   * 3. 宽限期到点还探测到目录存在 → 说明这次下架**没生效**（workflow 拒了、
   *    或只删了一半），把它放回来。不能让用户以为已经没了。
   */
  useEffect(() => {
    if (!removedKey) return;
    let alive = true;
    /** 已确认目录没了的 id：保持隐藏（清单迟早跟上），不用再探 */
    const confirmed = new Set<string>();

    const dirOf = (id: string): string | null => {
      const e = (entriesRef.current ?? []).find((x) => x.id === id);
      return e ? communityDirFor(e) : null;
    };

    const probe = async () => {
      for (const id of Object.keys(removedRef.current)) {
        if (!alive || confirmed.has(id)) continue;
        const dir = dirOf(id);
        if (!dir) continue;
        try {
          if (await probePluginDir(dir)) {
            confirmed.add(id);
            // 一次探一个就够：探测是串行的，别把并行请求打满
            return;
          }
        } catch {
          // 网络抖动 / 加速器抽风：下一轮再试
        }
      }
    };

    const firstProbe = window.setTimeout(() => void probe(), 4_000);
    const probeTimer = window.setInterval(() => void probe(), 8_000);
    const firstLoad = window.setTimeout(() => {
      if (alive) void load(true);
    }, 12_000);
    const loadTimer = window.setInterval(() => {
      if (alive) void load(true);
    }, 20_000);

    const giveUp = window.setTimeout(() => {
      window.clearTimeout(firstProbe);
      window.clearInterval(probeTimer);
      window.clearTimeout(firstLoad);
      window.clearInterval(loadTimer);
      void (async () => {
        const stillThere: string[] = [];
        for (const id of Object.keys(removedRef.current)) {
          if (confirmed.has(id)) continue;
          const dir = dirOf(id);
          if (!dir) continue;
          try {
            if (!(await probePluginDir(dir))) stillThere.push(id);
          } catch {
            // 探不到就维持现状（宁可继续藏着）
          }
        }
        if (!alive || !stillThere.length) return;
        // 只有 GitHub API 能避开本地加速器的缓存（见 stillInRepo）
        const reallyThere = await stillInRepo(stillThere, dirOf);
        if (!alive || !reallyThere.length) return;
        const next = { ...removedRef.current };
        for (const id of reallyThere) delete next[id];
        saveRemoved(next);
        setRemoved(next);
        // 真没删掉：持久记录也要撤，否则弹窗里永远是灰条
        for (const id of reallyThere) {
          const dir = dirOf(id);
          if (dir) dropTakedown(dir);
        }
        setNotice(t("takedownFailed"));
      })();
    }, 180_000);

    return () => {
      alive = false;
      window.clearTimeout(firstProbe);
      window.clearInterval(probeTimer);
      window.clearTimeout(firstLoad);
      window.clearInterval(loadTimer);
      window.clearTimeout(giveUp);
    };
  }, [removedKey, load]);

  /**
   * 有「已经提交、还没落地」的动作（等合并的 PR / 等生效的下架）时，
   * 每 15 秒强拉一次清单：PR 合并后新插件就能自己出现在中心里，
   * 不用用户手动点刷新（2026-11-26 用户报的「上架了中心也不自动刷新」）。
   *
   * 只在弹窗开着时轮询：关掉弹窗后，等清单一变，弹窗下次打开也会重新读盘。
   */
  useEffect(() => {
    if (!uploadOpen || pendingSubs === 0) return;
    const timer = window.setInterval(() => void load(true), 15_000);
    return () => window.clearInterval(timer);
  }, [uploadOpen, pendingSubs, load]);

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

  /**
   * 安装 / 更新走同一条路（后端就是「把包解到插件目录」），只有两处不同：
   * 提示语（已安装 / 已更新）和错误前缀。**更新不清旧目录里的用户数据** ——
   * 解包只覆盖包内文件，插件的 config/state 不受影响，这是「更新」而不是「卸载重装」
   * 的意义（用户 2026-11-19 要的就是这一点）。
   */
  const onInstall = async (entry: WorkshopEntry, mode: "install" | "update" = "install") => {
    setBusyId(entry.id);
    setNotice(null);
    const done = async (e: WorkshopEntry) => {
      await panelApi.install(installRequestFor(e));
      await refreshInstalled();
      // 更新不需要再教「去设置里开启」（它本来就是开着的那个）；
      // 新装才要说清「装完 ≠ 能用」：插件默认关，本地 API 若也关着连数据都读不到。
      // 两条都如实说清楚，但**只提示、不替用户开**（开关在设置页，是用户的决定）。
      setNotice(
        mode === "update"
          ? t("updatedToast", { name: e.name, version: e.version })
          : `${t("installedToast", { name: e.name, version: e.version })} ${
              apiEnabled ? t("installHint") : t("apiOff")
            }`,
      );
    };
    const failAction = mode === "update" ? "update" : "install";
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
            isShaMismatch(retryErr) ? t("staleRegistry") : describeError(retryErr, failAction),
          );
        }
      } else {
        setNotice(describeError(err, failAction));
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
      <motion.div
        className="ws-empty"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={scrimFade}
      >
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
      <motion.div
        className="ws-empty"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={scrimFade}
      >
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
          <BlinkCaretInput
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
              updateTo={updateTarget(entry)}
              busy={busyId === entry.id}
              t={t}
              onOpen={() => setDetailId(entry.id)}
              onUpdate={() => void onInstall(entry, "update")}
            />
          ))}
        </div>
      )}

      {/* 常驻说明（不能放进 banner：banner 被 dismissBanner 关掉后就再也看不到了）。
          上传按钮 / GitHub 登录的真实用途，与上传弹窗里用的是同一条文案。 */}
      <p className="ws-footer">{t("footer")}</p>
      <p className="ws-footer ws-footer-note">{t("uploadPurpose")}</p>

      <AnimatePresence>
        {detail && (
          <motion.div
            className="ws-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={scrimFade}
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
              transition={springSoft}
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
                  {installedIds.has(detail.id) && (
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
                  )}
                  {/* 没装 → 安装；装了但清单更新 → 更新（覆盖安装，插件自己的
                      config/state 不动）；已是最新 → 不给按钮，免得白点一次。 */}
                  {(!installedIds.has(detail.id) || detailUpdate) && (
                    <button
                      className="ws-btn ws-btn-primary"
                      onClick={() =>
                        void onInstall(detail, installedIds.has(detail.id) ? "update" : "install")
                      }
                      disabled={!!busyId}
                    >
                      {busyId === detail.id ? (
                        <>
                          <RefreshCw size={14} strokeWidth={1.5} className="ws-spin" />
                          {t("installing")}
                        </>
                      ) : (
                        <>
                          {detailUpdate ? (
                            <ArrowUpCircle size={14} strokeWidth={1.5} />
                          ) : (
                            <Download size={14} strokeWidth={1.5} />
                          )}
                          {detailUpdate ? t("updateTo", { version: detailUpdate }) : t("install")}
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
          <UploadDialog
            t={t}
            locale={locale}
            entries={entries ?? []}
            removedIds={Object.keys(removed)}
            onRemoved={markRemoved}
            onRefresh={refreshIndex}
            onChanged={onSubsChanged}
            onClose={() => setUploadOpen(false)}
          />
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
            transition={scrimFade}
          >
            <motion.div
              className="ws-tour"
              role="dialog"
              aria-modal="true"
              aria-label={t(`tour${tourStep + 1}Title`)}
              initial={{ opacity: 0, y: 18, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
              transition={springSoft}
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
  updateTo,
  busy,
  t,
  onOpen,
  onUpdate,
}: {
  entry: WorkshopEntry;
  index: number;
  installed: boolean;
  /** 可更新的目标版本；null = 不需要更新（没装 / 已是最新 / 判不了） */
  updateTo: string | null;
  busy: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onOpen: () => void;
  onUpdate: () => void;
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
      transition={{ ...springSoft, delay: Math.min(index, STAGGER_CAP) * STAGGER_STEP }}
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
        {installed && !updateTo && (
          <span className="ws-installed">
            <Check size={10} strokeWidth={2.5} /> {t("installedBadge")}
          </span>
        )}
        {/* 有新版本：徽章换成「可更新」，卡片底部同时给按钮（用户 2026-11-19 要求） */}
        {updateTo && (
          <span className="ws-installed ws-installed-update" title={t("updateTo", { version: updateTo })}>
            <ArrowUpCircle size={10} strokeWidth={2.5} /> {t("updateBadge")}
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
        {/* 更新按钮：卡片本身就是按钮（点开详情），这里的点击必须拦住冒泡。
            键盘 Enter 也一样 —— 否则按回车会既更新又打开详情。 */}
        {updateTo && (
          <button
            type="button"
            className="ws-card-update"
            disabled={busy}
            title={t("updateTo", { version: updateTo })}
            onClick={(e) => {
              e.stopPropagation();
              onUpdate();
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {busy ? (
              <RefreshCw size={11} strokeWidth={2} className="ws-spin" />
            ) : (
              <ArrowUpCircle size={11} strokeWidth={2} />
            )}
            {t("update")}
          </button>
        )}
      </div>
    </motion.article>
  );
}
