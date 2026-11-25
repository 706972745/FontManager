import { motion } from "motion/react";
import { scrimFade, springSoft } from "../design/springs.ts";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  FileArchive,
  FolderOpen,
  LoaderCircle,
  LogIn,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BlinkCaretInput } from "../design/primitives/BlinkCaretInput.tsx";
import { holdBlurGuard, panelApi } from "./api.ts";
import { useGithubAuth } from "./auth.ts";
import {
  ALLOWED_EXTS,
  MAX_NAME,
  canMaintain,
  deletePluginsDirect,
  GhError,
  PERMS,
  pickedFromApp,
  readManifest,
  requestTakedown,
  uploadPlugins,
  UploadMessage,
  validatePlugin,
  type PickedFile,
  type PluginForm,
  type UploadItem,
  type UploadPhase,
} from "./upload.ts";
import { communityDirFor, type WorkshopEntry } from "../lib/workshop.ts";

/**
 * 上传弹窗（M3）：连账号 → 选目录（**可多选**）→ 逐个确认清单 → 勾规则 → 一次提交。
 *
 * 多个插件共用一次提交、一个 PR：它们本来就是同一批东西，让维护者点 5 次合并
 * 是给自己找事。每个目录各有一份 plugin.json，有清单就自动预填，没有就点开手填 ——
 * 字段和单插件时完全一样。
 */

type TFn = (key: string, vars?: Record<string, string | number>) => string;

const EMPTY_FORM: PluginForm = {
  id: "",
  name: "",
  entry: "",
  version: "1.0.0",
  apiLevel: 1,
  permissions: [],
  brief: "",
  detail: "",
  runtime: null,
  lang: "zh-CN",
  minAppVersion: "",
};

/** 目录里没有 plugin.json 时，靠后缀猜一个入口（只有一个候选才敢猜） */
function guessEntry(files: PickedFile[]): string {
  const cands = files.filter((f) => /\.(py|js|mjs|cjs)$/i.test(f.path));
  return cands.length === 1 ? cands[0].path : "";
}

interface Draft {
  key: string;
  dirName: string;
  files: PickedFile[];
  form: PluginForm;
  hasManifest: boolean;
  /**
   * 已经提交过的草稿。
   *
   * 提交成功后不把草稿丢掉、也不让表单继续挂着旧内容：这一行改成「已提交 #N」，
   * 不能再编辑、也**不可能再提交一次**（以前草稿原样留着，一点又开一个重复 PR）。
   * 表单空出来，用户可以接着传下一个插件。
   */
  submitted?: { prNumber: number; prUrl: string };
}

/** `plugins/<id>__<author>` 的署名部分 —— 用来判断这条是不是当前账号自己的 */
function ownerOf(dir: string): string {
  const cut = dir.lastIndexOf("__");
  return cut >= 0 ? dir.slice(cut + 2) : "";
}

export function UploadDialog({
  t,
  locale,
  entries,
  removedIds,
  onRemoved,
  onClose,
}: {
  t: TFn;
  locale: string;
  /** 清单里的条目：用来列「我上传的插件」（下架入口） */
  entries: WorkshopEntry[];
  /** 已经在本机确认下架、只是清单还没重算的那些（父组件已经从目录里藏掉了） */
  removedIds: string[];
  /** 下架提交成功 → 让父组件立刻把它从插件中心里藏掉 */
  onRemoved: (id: string) => void;
  onClose: () => void;
}) {
  /**
   * 账号：**只认 GitHub 设备码登录**（2026-11-19 用户口径）。
   *
   * 面板不再收粘贴进来的令牌、也不内置令牌 —— 令牌由主程序在登录成功那一刻
   * 直接写进 DPAPI 文件，面板要用时才通过一次性会话 key 取一次。
   */
  const auth = useGithubAuth(t);
  const token = auth.state.token;
  const login = auth.state.login;
  const [copied, setCopied] = useState(false);
  /** 账号区的即时提示（比如「还没连账号就点了提交」） */
  const [accountError, setAccountError] = useState<string | null>(null);

  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);

  const [phase, setPhase] = useState<UploadPhase | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * 刚提交成功的那一次（内联提示条，不是全屏浮层）。
   *
   * 以前成功后弹一个全屏对话框：点「知道了」回到表单，草稿还是刚才那份内容，
   * 人也没被告知「接下来要等维护者合并」。现在改成面板顶部的内联条 + 草稿转
   * 「已提交」行，人不离开这个面板就能继续看/继续传。
   */
  const [banner, setBanner] = useState<{ prUrl: string; prNumber: number } | null>(null);
  /** 正在下架的目录（按钮显示 loading、其余禁用） */
  const [deleting, setDeleting] = useState<string | null>(null);
  /**
   * 本次会话里已提交下架的目录。
   *
   * 以前提交完就把这一行从「我的插件」里剔掉：列表瞬间少一条，用户除了底下那句提示
   * 之外没有任何「它还在生效中」的反馈，容易以为点空了或者点错了。现在保留这一行、
   * 压灰并挂「已下架（待生效）」，等清单重算后条目真的消失，这行才跟着走。
   */
  const [deleted, setDeleted] = useState<string[]>([]);
  const [deleteMsg, setDeleteMsg] = useState<string | null>(null);
  /**
   * 待确认的下架请求。
   *
   * 这里**不能**用 `window.confirm`：Tauri 会把它转发成 `plugin:dialog|confirm`，
   * 而插件中心是独立窗口，capability 只覆盖 main / splash / setup，没有 dialog 权限，
   * 结果就是面板直接白屏报 `Command plugin:dialog|confirm not allowed by ACL`，
   * 下架按钮点了没反应。用自己的弹窗既避开 ACL，也和面板其它弹层样式一致。
   */
  const [askRemove, setAskRemove] = useState<{
    id: string;
    dir: string;
    name: string;
    allowAny: boolean;
  } | null>(null);
  /**
   * 当前账号是不是仓库维护者。
   *
   * 非维护者只能下架**自己署名的**目录（目录名后缀 = 登录名）；维护者才能删别人的。
   * 这只是界面层：非维护者压根推不动 main，直推会 403 并退回开 PR，
   * 而 PR 那关有 CI 的归属校验 —— 真正的闸门在那边。
   */
  const [isMaintainer, setIsMaintainer] = useState(false);

  // 登录后问一次仓库权限：维护者（admin / maintain）才能删别人的插件
  useEffect(() => {
    let alive = true;
    if (!token) {
      setIsMaintainer(false);
      return;
    }
    void canMaintain(token)
      .then((ok) => {
        if (alive) setIsMaintainer(ok);
      })
      .catch(() => {
        if (alive) setIsMaintainer(false);
      });
    return () => {
      alive = false;
    };
  }, [token]);

  /**
   * Esc 关闭（按层级退：下架确认 → 顶部提示条 → 整个弹窗）。
   *
   * 弹窗只能点遮罩或右上角 ×，键盘用户没路可走；而遮罩点击在「上传进行中」
   * 是被忽略的，什么都不发生更容易让人以为卡死了。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 上传进行中不许中途退出：此时关掉面板，人只会以为请求丢了
      if (e.key !== "Escape" || phase !== null) return;
      if (askRemove) {
        setAskRemove(null);
        return;
      }
      if (banner) {
        setBanner(null);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [askRemove, banner, onClose, phase]);

  /**
   * 「我上传的插件」= 目录名后半段等于**当前登录名**的社区件。
   *
   * 归属按署名认、不按机器：目录名是 `plugins/<id>__<登录名>`，所以在任何一台
   * 电脑上登录同一个账号都能看到自己的插件（覆盖更新与下架都走同一条路）。
   * 匿名代传（`anonymous-xxxx`）2026-11-19 起已取消，这里不再兼容那个前缀。
   */
  const mine = useMemo(() => {
    if (!login) return [];
    const out: { entry: WorkshopEntry; dir: string; pending: boolean }[] = [];
    for (const e of entries) {
      if (e.official) continue;
      // registry 的 `dir` 是仓库相对路径（`plugins/<id>__<作者>`）——下架只认最后一段
      // 目录名，`communityDirFor` 干的就是这件事（与 Rust 的 `dir_name_of` 同口径）
      const dir = communityDirFor(e);
      if (!dir) continue;
      const cut = dir.lastIndexOf("__");
      if (cut < 0) continue;
      // 别人的插件只有维护者能删；普通用户看到的是「我的插件」列表。
      // 登录名大小写不敏感（GitHub 允许清单里写成 `Helloooooseff`）。
      if (dir.slice(cut + 2).toLowerCase() !== login.toLowerCase() && !isMaintainer) continue;
      // 本会话提交的（deleted）或父组件已经确认下架的（removedIds）都算「待生效」
      out.push({ entry: e, dir, pending: deleted.includes(dir) || removedIds.includes(e.id) });
    }
    return out;
  }, [entries, login, deleted, removedIds, isMaintainer]);

  // 清单重算后，已下架的目录会从 entries 里消失。这里把「孤儿」标记清掉，否则
  // 维护者手动把插件恢复上架（或聚合失败回滚）之后，那一行会永远只剩灰条、按钮回不来。
  useEffect(() => {
    if (!deleted.length) return;
    const present = new Set(
      entries.map((e) => communityDirFor(e)).filter((d): d is string => !!d),
    );
    const kept = deleted.filter((d) => present.has(d));
    if (kept.length !== deleted.length) setDeleted(kept);
  }, [entries, deleted]);

  const removeOne = useCallback(
    async (id: string, dir: string, name: string, allowAny: boolean) => {
      if (!token || !login) return;
      setDeleting(dir);
      setError(null);
      setDeleteMsg(null);
      // 刚上传成功的提示条会占住面板顶部，先收起来，免得下架的反馈被压在下面
      setBanner(null);
      try {
        // 维护者（admin / maintain）直推：即时生效，不留 issue 噪音。
        if (isMaintainer) {
          try {
            await deletePluginsDirect({ token, login, dirs: [dir], onPhase: setPhase, allowAny });
            setDeleted((d) => [...d, dir]);
            // 直推已经删完了：目录当场就该从中心里消失，别等下一次刷新
            onRemoved(id);
            setDeleteMsg(t("uploadDeleteDone", { name }));
            return;
          } catch (e) {
            // 直推被拒（期间有人推了 main / 规则又加了限制）→ 退回 issue 通道，不能什么都不做
            if (!(e instanceof GhError && [403, 404, 409, 422].includes(e.status))) throw e;
          }
        }
        // 作者：开一个 `[takedown]` issue，仓库 Action 校验「发起人 == 目录署名者」后直接删。
        // 不走 fork，所以不存在「fork 落后 → 同步失败 → 404 变成没有权限」那条死路。
        const out = await requestTakedown({ token, login, dirs: [dir], onPhase: setPhase, allowAny });
        setDeleted((d) => [...d, dir]);
        // 请求已经进闸门了：先在本地把它从中心里藏掉，父组件会轮询清单确认。
        // 不藏的话「已经下架还在显示、刷新也没用」—— 聚合脚本最慢要 2 分半。
        onRemoved(id);
        setDeleteMsg(t("uploadDeleteSubmitted", { number: out.issueNumber }));
      } catch (e) {
        setError(
          e instanceof UploadMessage
            ? t(e.key)
            : `${t("uploadFail")} — ${String((e as Error).message)}`,
        );
      } finally {
        setDeleting(null);
        setPhase(null);
      }
    },
    [isMaintainer, login, onRemoved, t, token],
  );

  /** 上传时的署名就是登录名（不再有匿名分支） */
  const author = login ?? "";

  /** 还没提交的草稿：校验、计数、提交都只看这一批 */
  const pending = useMemo(() => drafts.filter((d) => !d.submitted), [drafts]);

  /** 每个草稿各自的校验结果（已提交的不再校验，它已经进闸门了） */
  const issuesByKey = useMemo(() => {
    const map = new Map<string, ReturnType<typeof validatePlugin>>();
    for (const d of pending) map.set(d.key, validatePlugin(d.form, d.files));
    return map;
  }, [pending]);

  /** 跨插件：两个目录撞成同一个 `plugins/<id>__<author>` 会互相覆盖 */
  const dupKeys = useMemo(() => {
    const seen = new Map<string, string>();
    const dup = new Set<string>();
    for (const d of pending) {
      const dir = `${d.form.id.trim()}__${author}`;
      const prev = seen.get(dir);
      if (prev) {
        dup.add(d.key);
        dup.add(prev);
      } else seen.set(dir, d.key);
    }
    return dup;
  }, [pending, author]);

  const errorCount = useMemo(() => {
    let n = 0;
    for (const issues of issuesByKey.values()) n += issues.filter((i) => i.level === "error").length;
    return n;
  }, [issuesByKey]);

  const busy = phase !== null;
  const active = pending.find((d) => d.key === activeKey) ?? null;
  const ready = pending.length > 0 && errorCount === 0 && dupKeys.size === 0;

  /** 把「选目录 / 选 zip」两种来源统一塞进 drafts：来源不同，落地形态一样 */
  const mergePicked = useCallback(
    (dirs: { dirName: string; files: { path: string; size: number; content: string }[] }[]) => {
      setDrafts((prev) => {
        const next = [...prev];
        let lastKey: string | null = null;
        for (const dir of dirs) {
          const files = pickedFromApp(dir.files);
          const mf = readManifest(files);
          const form: PluginForm = {
            ...EMPTY_FORM,
            lang: locale,
            ...(mf ?? {}),
            entry: mf?.entry ?? guessEntry(files),
          };
          const draft: Draft = {
            key: `${dir.dirName}#${next.length}-${Date.now()}`,
            dirName: dir.dirName,
            files,
            form,
            hasManifest: mf !== null,
          };
          // 同名目录再选一次 = 替换，不是并排两份
          const at = next.findIndex((d) => d.dirName === dir.dirName);
          if (at >= 0) next[at] = draft;
          else next.push(draft);
          lastKey = draft.key;
        }
        if (lastKey) setActiveKey(lastKey);
        return next;
      });
    },
    [locale],
  );

  const onPick = useCallback(async () => {
    // 系统对话框会让面板失焦（面板是失焦即藏）→ 先置守位
    void holdBlurGuard();
    try {
      const r = await panelApi.pickFolders();
      if (r.cancelled || r.dirs.length === 0) return;
      setError(null);
      mergePicked(r.dirs);
    } catch (e) {
      setError(
        e instanceof UploadMessage
          ? t(e.key)
          : `${t("uploadFail")} — ${String((e as Error).message)}`,
      );
    }
  }, [mergePicked, t]);

  /**
   * 选 zip 分发包：主程序在内存里解压（剥掉多余的外层目录），回来的结构与选目录一致。
   * 这样作者不用先解压、也不用担心解压工具多套一层导致「缺 plugin.json」。
   */
  const onPickZip = useCallback(async () => {
    void holdBlurGuard();
    try {
      const r = await panelApi.pickPackages();
      if (r.cancelled || r.dirs.length === 0) return;
      setError(null);
      mergePicked(r.dirs);
    } catch (e) {
      setError(
        e instanceof UploadMessage
          ? t(e.key)
          : `${t("uploadFail")} — ${String((e as Error).message)}`,
      );
    }
  }, [mergePicked, t]);

  const removeDraft = (key: string) => {
    setDrafts((prev) => {
      const next = prev.filter((d) => d.key !== key);
      if (activeKey === key) setActiveKey(next[0]?.key ?? null);
      return next;
    });
  };

  const setField = <K extends keyof PluginForm>(key: K, value: PluginForm[K]) => {
    if (!active) return;
    setDrafts((prev) =>
      prev.map((d) => (d.key === active.key ? { ...d, form: { ...d.form, [key]: value } } : d)),
    );
  };

  const togglePerm = (perm: string) => {
    if (!active) return;
    const has = active.form.permissions.includes(perm);
    setField(
      "permissions",
      has
        ? active.form.permissions.filter((p) => p !== perm)
        : [...active.form.permissions, perm],
    );
  };

  const submit = useCallback(async () => {
    if (!token || !login) {
      setAccountError(t("uploadNeedAccount"));
      return;
    }
    setAccountError(null);
    if (!agreed || !ready) return;
    setError(null);
    setBanner(null);
    setPhase("fork");
    setProgress(null);
    const batch = pending;
    try {
      const items: UploadItem[] = batch.map((d) => ({
        author: author || login,
        form: d.form,
        files: d.files,
      }));
      const out = await uploadPlugins({
        token,
        login,
        items,
        onPhase: (p, done, total) => {
          setPhase(p);
          if (p === "upload" && done !== undefined && total !== undefined) {
            setProgress({ done, total });
          }
        },
      });
      // 这一批已经进闸门：转成「已提交」行（不可编辑、不可重复提交），
      // 表单空出来给下一个插件 —— 提交完人还留在面板里，不用重开。
      setDrafts((prev) =>
        prev.map((d) =>
          batch.some((b) => b.key === d.key)
            ? { ...d, submitted: { prNumber: out.prNumber, prUrl: out.prUrl } }
            : d,
        ),
      );
      setActiveKey(null);
      setBanner({ prUrl: out.prUrl, prNumber: out.prNumber });
    } catch (e) {
      // UploadMessage 自带 i18n key（还没选插件 / fork 没就绪）—— 直接翻，别再包一层
      if (e instanceof UploadMessage) setError(t(e.key));
      else if (e instanceof GhError) {
        if (e.status === 401) setError(t("uploadTokenInvalid"));
        else if (e.status === 403 || e.status === 429) setError(t("uploadRateLimited"));
        else setError(`${t("uploadFail")} — ${e.apiMessage}`);
      } else {
        setError(`${t("uploadFail")} — ${String((e as Error).message)}`);
      }
    } finally {
      setPhase(null);
      setProgress(null);
    }
  }, [agreed, author, login, pending, ready, t, token]);

  const phaseText = useMemo(() => {
    if (phase === "fork") return t("uploadPhaseFork");
    if (phase === "upload")
      return t("uploadPhaseUpload", {
        done: progress?.done ?? 0,
        total: progress?.total ?? 0,
      });
    if (phase === "commit") return t("uploadPhaseCommit");
    if (phase === "pr") return t("uploadPhasePr");
    return "";
  }, [phase, progress, t]);

  const activeIssues = active ? (issuesByKey.get(active.key) ?? []) : [];

  return (
    <motion.div
      className="ws-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={scrimFade}
      onClick={() => !busy && onClose()}
    >
      <motion.div
        className="ws-upload"
        role="dialog"
        aria-modal="true"
        aria-label={t("uploadTitle")}
        initial={{ opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 16, scale: 0.98 }}
        transition={springSoft}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ws-upload-head">
          <Upload size={14} strokeWidth={1.5} />
          <h2 className="ws-upload-title">{t("uploadTitle")}</h2>
          <button className="ws-clear" onClick={onClose} disabled={busy} aria-label={t("uploadClose")}>
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="ws-upload-body">
          <p className="ws-upload-intro">{t("uploadIntro")}</p>

          {/* 刚提交成功：内联提示条（不是全屏浮层）。
              人不用离开表单，也顺带被明确告知「还要等维护者合并」——
              这条以前完全没有，用户以为点完就已经上架了。 */}
          {banner && (
            <motion.div
              className="ws-up-banner"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={springSoft}
            >
              <span className="ws-up-banner-icon">
                <Check size={13} strokeWidth={2.6} />
              </span>
              <div className="ws-up-banner-text">
                <strong>{t("uploadSuccessTitle")}</strong>{" "}
                {t("uploadSuccessInline", { number: banner.prNumber })}
                <div className="ws-up-banner-note">{t("uploadPendingMerge")}</div>
              </div>
              <button
                className="ws-linkbtn ws-up-banner-link"
                onClick={() => void panelApi.openUrl(banner.prUrl)}
              >
                {t("uploadOpenPr")}
              </button>
              <button
                className="ws-banner-close"
                onClick={() => setBanner(null)}
                aria-label={t("uploadClose")}
              >
                <X size={13} strokeWidth={2} />
              </button>
            </motion.div>
          )}

          {/* ① 账号 —— 只走 GitHub 设备码登录（面板不收令牌、也不内置令牌） */}
          <section className="ws-up-sec">
            <h3 className="ws-up-sec-title">{t("uploadAccountTitle")}</h3>
            {login ? (
              <div className="ws-up-account">
                <span className="ws-up-login">
                  <Check size={12} strokeWidth={2.4} />@{login}
                </span>
                <button
                  className="ws-linkbtn"
                  onClick={() => void auth.signOut()}
                  disabled={busy}
                >
                  {t("uploadSignOut")}
                </button>
              </div>
            ) : !auth.state.configured ? (
              // 软件还没配 OAuth App：这不是用户能自己解决的问题，必须说清找谁
              <p className="ws-up-hint ws-up-hint-warn">{t("uploadNotConfigured")}</p>
            ) : auth.state.device ? (
              <div className="ws-up-device">
                <p className="ws-up-hint">{t("uploadDeviceHint")}</p>
                <div className="ws-up-device-row">
                  <code className="ws-up-code">{auth.state.device.userCode}</code>
                  <button
                    className="ws-iconbtn"
                    aria-label={t("uploadDeviceCopy")}
                    title={t("uploadDeviceCopy")}
                    onClick={() => {
                      void auth.copyCode().then((ok) => {
                        if (!ok) return;
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 1600);
                      });
                    }}
                  >
                    {copied ? (
                      <Check size={13} strokeWidth={2.2} />
                    ) : (
                      <Copy size={13} strokeWidth={1.8} />
                    )}
                  </button>
                  <button
                    className="ws-cta"
                    onClick={() =>
                      void panelApi.openUrl(auth.state.device!.verificationUri).catch(() => {})
                    }
                  >
                    <ExternalLink size={12} strokeWidth={1.8} />
                    {t("uploadDeviceOpen")}
                  </button>
                </div>
                <p className="ws-up-hint ws-up-device-wait">
                  <LoaderCircle size={12} className="ws-spin" />
                  {t("uploadDeviceWaiting")}
                </p>
                <button className="ws-linkbtn" onClick={auth.cancel}>
                  {t("uploadDeviceCancel")}
                </button>
              </div>
            ) : (
              <>
                <button
                  className="ws-cta"
                  onClick={() => void auth.start()}
                  disabled={auth.state.status === "starting"}
                >
                  {auth.state.status === "starting" ? (
                    <LoaderCircle size={13} className="ws-spin" />
                  ) : (
                    <LogIn size={13} strokeWidth={1.8} />
                  )}
                  {t("uploadSignIn")}
                </button>
                <p className="ws-up-hint">{t("uploadSignInHint")}</p>
                <p className="ws-up-hint">{t("uploadPurpose")}</p>
              </>
            )}
            {(accountError ?? auth.state.error) && (
              <p className="ws-up-error">{accountError ?? auth.state.error}</p>
            )}
          </section>

          {/* ①b 我上传过的插件：下架入口。
              归属按**署名**认，不按"这台电脑"：目录名是 `plugins/<id>__<登录名>`，
              所以换任何一台电脑登录同一个账号，既能覆盖更新，也能在这里下架。 */}
          {login && mine.length > 0 && (
            <section className="ws-up-sec">
              <h3 className="ws-up-sec-title">{t("uploadMineTitle")}</h3>
              <p className="ws-up-hint">{t("uploadMineHint")}</p>
              <ul className="ws-up-list">
                {mine.map(({ entry: e, dir, pending }) => (
                  <li
                    key={dir}
                    className={"ws-up-item" + (pending ? " ws-up-item-pending" : "")}
                  >
                    <span className="ws-up-item-main" style={{ cursor: "default" }}>
                      <span className="ws-up-item-name">
                        {e.name}
                        {!pending && ownerOf(dir) !== login && (
                          <span className="ws-up-item-tag">{t("uploadOwnerTag")}</span>
                        )}
                      </span>
                      <span className="ws-up-item-meta">
                        v{e.version} · plugins/{dir}
                      </span>
                    </span>
                    {pending ? (
                      // 已提交、等清单重算：右侧按钮换成灰标签，避免「再点一次」造出重复请求
                      <span className="ws-up-tag-pending">{t("uploadDeletePendingTag")}</span>
                    ) : (
                      <button
                        className="ws-linkbtn"
                        onClick={() =>
                          setAskRemove({
                            id: e.id,
                            dir,
                            name: e.name,
                            allowAny: ownerOf(dir) !== login,
                          })
                        }
                        disabled={deleting !== null}
                      >
                        {deleting === dir ? t("uploadDeleting") : t("uploadDelete")}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {deleteMsg && <p className="ws-up-hint">{deleteMsg}</p>}
            </section>
          )}

          {/* ② 目录（可多选） */}
          <section className="ws-up-sec">
            <h3 className="ws-up-sec-title">{t("uploadPickTitle")}</h3>
            <div className="ws-up-pickrow">
              <button className="ws-cta" onClick={() => void onPick()} disabled={busy}>
                <FolderOpen size={13} strokeWidth={1.5} />
                {pending.length ? t("uploadRepick") : t("uploadPick")}
              </button>
              <button className="ws-btn ws-btn-ghost" onClick={() => void onPickZip()} disabled={busy}>
                <FileArchive size={13} strokeWidth={1.5} />
                {t("uploadPickZip")}
              </button>
              {pending.length > 0 && (
                <span className="ws-up-pickmeta">
                  {t("uploadCount", { count: pending.length })}
                </span>
              )}
            </div>

            {drafts.length > 0 && (
              <ul className="ws-up-list">
                {drafts.map((d) => {
                  const errs = (issuesByKey.get(d.key) ?? []).filter((i) => i.level === "error").length;
                  const isDup = dupKeys.has(d.key);
                  const done = d.submitted;
                  const bad = !done && (errs > 0 || isDup || !d.hasManifest);
                  return (
                    <li
                      key={d.key}
                      className={
                        "ws-up-item" +
                        (d.key === activeKey && !done ? " ws-up-item-on" : "") +
                        (bad ? " ws-up-item-bad" : "") +
                        (done ? " ws-up-item-done" : "")
                      }
                    >
                      <button
                        className="ws-up-item-main"
                        // 已提交的行不再进编辑态：它已经进闸门，改表单只会让人以为改动生效了
                        onClick={() => !done && setActiveKey(d.key)}
                        disabled={!!done}
                      >
                        <span className="ws-up-item-name">
                          {d.form.name || d.dirName}
                          {done && (
                            <span className="ws-up-donetag">
                              {t("uploadSubmittedTag", { number: done.prNumber })}
                            </span>
                          )}
                        </span>
                        <span className="ws-up-item-meta">
                          v{d.form.version || "?"} · {d.form.id || "—"}
                        </span>
                        <span
                          className="ws-up-item-state"
                          title={
                            done
                              ? t("uploadSubmittedHint")
                              : errs > 0
                                ? t("uploadItemErrors", { count: errs })
                                : undefined
                          }
                        >
                          {done
                            ? t("uploadSubmittedHint")
                            : isDup
                              ? t("uploadDup")
                              : !d.hasManifest
                                ? t("uploadNoManifest")
                                : errs > 0
                                  ? t("uploadItemErrors", { count: errs })
                                  : t("uploadItemOk")}
                        </span>
                      </button>
                      {done ? (
                        <button
                          className="ws-clear"
                          onClick={() => void panelApi.openUrl(done.prUrl)}
                          aria-label={t("uploadOpenPr")}
                          title={t("uploadOpenPr")}
                        >
                          <ExternalLink size={13} strokeWidth={1.5} />
                        </button>
                      ) : (
                        <button
                          className="ws-clear"
                          onClick={() => removeDraft(d.key)}
                          disabled={busy}
                          aria-label={t("uploadRemove")}
                        >
                          <Trash2 size={13} strokeWidth={1.5} />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* ③ 当前选中的那个插件的清单 —— 提交完这一批就自动空出来，
              下一个插件直接从上面选，不用关掉重开 */}
          {active && (
            <section className="ws-up-sec">
              <h3 className="ws-up-sec-title">
                {t("uploadFormTitle")} · {active.dirName}
                {/* 上传的署名就是当前登录名（目录后缀），先说清归属 */}
                <span className="ws-up-signas">{t("uploadSignAs", { login: author })}</span>
              </h3>
              <div className="ws-up-grid">
                {/* 字段标签一律走 t()；**填的东西必须是特定写法**（id 只能小写、入口要相对路径、
                    Python/Node 是产品名……），这些没法翻译，所以整块 label 挂 title：
                    鼠标停在标签或输入框上就出当前语言的说明。 */}
                <label className="ws-up-field" title={t("fIdTip")}>
                  <span className="ws-up-tip">{t("fId")}</span>
                  <BlinkCaretInput
                    className="ws-input"
                    value={active.form.id}
                    onChange={(e) => setField("id", e.target.value)}
                    placeholder="my-plugin"
                    spellCheck={false}
                  />
                </label>
                <label className="ws-up-field" title={t("fNameTip")}>
                  <span className="ws-up-tip">
                    {t("fName")}
                    {/* 边打字边看还剩几个字：超过 MAX_NAME 会变红并直接拦住提交 */}
                    <span
                      className={
                        "ws-up-count" +
                        ([...active.form.name].length > MAX_NAME ? " ws-up-count-bad" : "")
                      }
                    >
                      {[...active.form.name].length}/{MAX_NAME}
                    </span>
                  </span>
                  <BlinkCaretInput
                    className="ws-input"
                    value={active.form.name}
                    onChange={(e) => setField("name", e.target.value)}
                  />
                </label>
                <label className="ws-up-field" title={t("fVersionTip")}>
                  <span className="ws-up-tip">{t("fVersion")}</span>
                  <BlinkCaretInput
                    className="ws-input"
                    value={active.form.version}
                    onChange={(e) => setField("version", e.target.value)}
                    placeholder="1.0.0"
                    spellCheck={false}
                  />
                </label>
                <label className="ws-up-field" title={t("fEntryTip")}>
                  <span className="ws-up-tip">{t("fEntry")}</span>
                  <BlinkCaretInput
                    className="ws-input"
                    value={active.form.entry}
                    onChange={(e) => setField("entry", e.target.value)}
                    placeholder="main.py"
                    spellCheck={false}
                  />
                </label>
                <label className="ws-up-field" title={t("fRuntimeTip")}>
                  <span className="ws-up-tip">{t("fRuntime")}</span>
                  <select
                    className="ws-input"
                    value={active.form.runtime ?? "none"}
                    onChange={(e) =>
                      setField(
                        "runtime",
                        e.target.value === "none" ? null : (e.target.value as "python" | "node"),
                      )
                    }
                  >
                    <option value="none">{t("fRuntimeNone")}</option>
                    <option value="python">Python</option>
                    <option value="node">Node</option>
                  </select>
                </label>
                <label className="ws-up-field" title={t("fApiLevelTip")}>
                  <span className="ws-up-tip">{t("fApiLevel")}</span>
                  <input
                    className="ws-input"
                    type="number"
                    min={1}
                    value={active.form.apiLevel}
                    onChange={(e) => setField("apiLevel", Number(e.target.value) || 0)}
                  />
                </label>
                <label className="ws-up-field ws-up-wide">
                  <span>{t("fBrief", { max: 200 })}</span>
                  <BlinkCaretInput
                    className="ws-input"
                    value={active.form.brief}
                    maxLength={200}
                    onChange={(e) => setField("brief", e.target.value)}
                  />
                </label>
                <label className="ws-up-field ws-up-wide">
                  <span>{t("fDetail", { max: 1000 })}</span>
                  <textarea
                    className="ws-input ws-up-textarea"
                    value={active.form.detail}
                    maxLength={1000}
                    rows={3}
                    onChange={(e) => setField("detail", e.target.value)}
                  />
                </label>
              </div>

              {/* 权限：**标识符原样（要写进 plugin.json，翻了就对不上）**，
                  旁边跟一句当前语言的说明；整行挂 title，悬停看完整解释。 */}
              <div className="ws-up-perms">
                <span className="ws-up-field-label ws-up-tip" title={t("fPermsTip")}>
                  {t("fPerms")}
                </span>
                <div className="ws-up-permlist">
                  {PERMS.map((p) => {
                    const desc = t(`perm.${p}`);
                    return (
                      <label key={p} className="ws-up-perm" title={`${p} — ${desc}`}>
                        <input
                          type="checkbox"
                          checked={active.form.permissions.includes(p)}
                          onChange={() => togglePerm(p)}
                        />
                        <code>{p}</code>
                        <span className="ws-up-perm-desc">{desc}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {activeIssues.length > 0 && (
                <ul className="ws-up-issues">
                  {activeIssues.map((i, n) => (
                    <li
                      key={n}
                      className={`ws-up-issue ws-up-issue-${i.level === "error" ? "err" : "warn"}`}
                      // 报的是后缀，就把白名单后缀列出来（悬停）
                      title={
                        i.key === "uploadErrExt"
                          ? t("uploadAllowedExt", { exts: ALLOWED_EXTS.join(" ") })
                          : undefined
                      }
                    >
                      <AlertTriangle size={12} strokeWidth={1.8} />
                      {t(i.key, i.vars)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* ④ 规则 */}
          <section className="ws-up-sec">
            <h3 className="ws-up-sec-title">{t("uploadRulesTitle")}</h3>
            <ul className="ws-up-rules">
              <li>{t("uploadRule1")}</li>
              <li>{t("uploadRule2")}</li>
              <li>{t("uploadRule3")}</li>
              <li>{t("uploadRule4")}</li>
              <li>{t("uploadRule5")}</li>
            </ul>
            <label className="ws-up-agree">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              <span>{t("uploadAgree")}</span>
            </label>
            {/* 匿名代传 2026-11-19 起取消：上传一律按登录名署名，
                这样「谁传的」在 GitHub 上就是可追溯的（PR 作者 = 目录名后缀）。 */}
          </section>

          {error && <p className="ws-up-error">{error}</p>}
        </div>

        <div className="ws-upload-foot">
          {busy ? (
            <span className="ws-up-phase">
              <LoaderCircle size={13} className="ws-spin" />
              {phaseText}
            </span>
          ) : (
            <span className="ws-up-phase ws-up-footnote">
              {/* 按钮为什么是灰的，得说出来 —— 以前只有禁用，用户点不动却不知道缺什么 */}
              {pending.length > 0 && !agreed
                ? t("uploadNeedAgree")
                : pending.length > 0
                  ? t("uploadPendingMerge")
                  : ""}
            </span>
          )}
          <button
            className="ws-cta ws-up-submit"
            onClick={() => (pending.length === 0 ? onClose() : void submit())}
            disabled={busy || (pending.length > 0 && (!token || !login || !agreed || !ready))}
            // 全部提交完就把主按钮换成「关闭」：这时候还写「上传 0 个插件」既没意义也点不动
          >
            {pending.length === 0 ? t("uploadClose") : t("uploadSubmit", { count: pending.length })}
          </button>
        </div>
      </motion.div>

      {/* 下架确认：用自己的弹窗（见 askRemove 的注释，window.confirm 会被 ACL 拦） */}
      {askRemove && (
        <div
          className="ws-upok-mask"
          onClick={() => deleting === null && setAskRemove(null)}
        >
          <motion.div
            className="ws-upok"
            role="alertdialog"
            aria-modal="true"
            aria-label={t("uploadDelete")}
            initial={{ opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={springSoft}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="ws-upok-icon ws-upok-icon-warn">
              <AlertTriangle size={20} strokeWidth={2} />
            </span>
            <h2 className="ws-upok-title">{t("uploadDelete")}</h2>
            <p className="ws-upok-body">
              {t("uploadDeleteConfirm", { name: askRemove.name })}
            </p>
            <div className="ws-upok-foot">
              <button
                className="ws-linkbtn"
                onClick={() => setAskRemove(null)}
                disabled={deleting !== null}
              >
                {t("uploadDeviceCancel")}
              </button>
              <button
                className="ws-cta ws-cta-danger"
                onClick={() => {
                  const target = askRemove;
                  setAskRemove(null);
                  void removeOne(target.id, target.dir, target.name, target.allowAny);
                }}
                disabled={deleting !== null}
              >
                {t("uploadDelete")}
              </button>
            </div>
          </motion.div>
        </div>
      )}

    </motion.div>
  );
}
