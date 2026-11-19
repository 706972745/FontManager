import { motion } from "motion/react";
import { scrimFade, springSoft } from "../design/springs.ts";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  FolderOpen,
  LoaderCircle,
  LogIn,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { BlinkCaretInput } from "../design/primitives/BlinkCaretInput.tsx";
import { holdBlurGuard, panelApi } from "./api.ts";
import { useGithubAuth } from "./auth.ts";
import {
  ALLOWED_EXTS,
  deletePlugins,
  GhError,
  PERMS,
  pickedFromApp,
  readManifest,
  uploadPlugins,
  UploadMessage,
  validatePlugin,
  type PickedFile,
  type PluginForm,
  type UploadItem,
  type UploadPhase,
} from "./upload.ts";
import type { WorkshopEntry } from "../lib/workshop.ts";

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
}

export function UploadDialog({
  t,
  locale,
  entries,
  onClose,
}: {
  t: TFn;
  locale: string;
  /** 清单里的条目：用来列「我上传的插件」（下架入口） */
  entries: WorkshopEntry[];
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
  const [result, setResult] = useState<{ prUrl: string; prNumber: number } | null>(null);
  /** 正在下架的目录（按钮显示 loading、其余禁用） */
  const [deleting, setDeleting] = useState<string | null>(null);
  /** 本次会话里已提交下架的目录（提交后先从列表里去掉，不必等 PR 合并） */
  const [deleted, setDeleted] = useState<string[]>([]);
  const [deleteMsg, setDeleteMsg] = useState<string | null>(null);

  /**
   * 「我上传的插件」= 目录名后半段等于**当前登录名**的社区件。
   *
   * 归属按署名认、不按机器：目录名是 `plugins/<id>__<登录名>`，所以在任何一台
   * 电脑上登录同一个账号都能看到自己的插件（覆盖更新与下架都走同一条路）。
   * 匿名代传（`anonymous-xxxx`）2026-11-19 起已取消，这里不再兼容那个前缀。
   */
  const mine = useMemo(() => {
    if (!login) return [];
    return entries.filter((e) => {
      if (e.official || !e.dir) return false;
      const cut = e.dir.lastIndexOf("__");
      if (cut < 0) return false;
      return e.dir.slice(cut + 2) === login && !deleted.includes(e.dir);
    });
  }, [entries, login, deleted]);

  const removeOne = useCallback(
    async (dir: string, name: string) => {
      if (!token || !login) return;
      if (!window.confirm(t("uploadDeleteConfirm", { name }))) return;
      setDeleting(dir);
      setError(null);
      setDeleteMsg(null);
      try {
        const out = await deletePlugins({ token, login, dirs: [dir], onPhase: setPhase });
        setDeleted((d) => [...d, dir]);
        setDeleteMsg(t("uploadDeleteSubmitted", { number: out.prNumber }));
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
    [login, t, token],
  );

  /** 上传时的署名就是登录名（不再有匿名分支） */
  const author = login ?? "";

  /** 每个草稿各自的校验结果 */
  const issuesByKey = useMemo(() => {
    const map = new Map<string, ReturnType<typeof validatePlugin>>();
    for (const d of drafts) map.set(d.key, validatePlugin(d.form, d.files));
    return map;
  }, [drafts]);

  /** 跨插件：两个目录撞成同一个 `plugins/<id>__<author>` 会互相覆盖 */
  const dupKeys = useMemo(() => {
    const seen = new Map<string, string>();
    const dup = new Set<string>();
    for (const d of drafts) {
      const dir = `${d.form.id.trim()}__${author}`;
      const prev = seen.get(dir);
      if (prev) {
        dup.add(d.key);
        dup.add(prev);
      } else seen.set(dir, d.key);
    }
    return dup;
  }, [drafts, author]);

  const errorCount = useMemo(() => {
    let n = 0;
    for (const issues of issuesByKey.values()) n += issues.filter((i) => i.level === "error").length;
    return n;
  }, [issuesByKey]);

  const busy = phase !== null;
  const active = drafts.find((d) => d.key === activeKey) ?? null;
  const ready = drafts.length > 0 && errorCount === 0 && dupKeys.size === 0;

  const onPick = useCallback(async () => {
    // 系统对话框会让面板失焦（面板是失焦即藏）→ 先置守位
    void holdBlurGuard();
    try {
      const r = await panelApi.pickFolders();
      if (r.cancelled || r.dirs.length === 0) return;
      setError(null);
      setDrafts((prev) => {
        const next = [...prev];
        let lastKey: string | null = null;
        for (const dir of r.dirs) {
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
    } catch (e) {
      setError(
        e instanceof UploadMessage
          ? t(e.key)
          : `${t("uploadFail")} — ${String((e as Error).message)}`,
      );
    }
  }, [locale, t]);

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
    setResult(null);
    setPhase("fork");
    setProgress(null);
    try {
      const items: UploadItem[] = drafts.map((d) => ({
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
      setResult({ prUrl: out.prUrl, prNumber: out.prNumber });
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
  }, [agreed, author, drafts, login, ready, t, token]);

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
                {mine.map((e) => (
                  <li key={e.dir} className="ws-up-item">
                    <span className="ws-up-item-main" style={{ cursor: "default" }}>
                      <span className="ws-up-item-name">{e.name}</span>
                      <span className="ws-up-item-meta">
                        v{e.version} · {e.dir}
                      </span>
                    </span>
                    <button
                      className="ws-linkbtn"
                      onClick={() => void removeOne(e.dir!, e.name)}
                      disabled={deleting !== null}
                    >
                      {deleting === e.dir ? t("uploadDeleting") : t("uploadDelete")}
                    </button>
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
                {drafts.length ? t("uploadRepick") : t("uploadPick")}
              </button>
              {drafts.length > 0 && (
                <span className="ws-up-pickmeta">{t("uploadCount", { count: drafts.length })}</span>
              )}
            </div>

            {drafts.length > 0 && (
              <ul className="ws-up-list">
                {drafts.map((d) => {
                  const errs = (issuesByKey.get(d.key) ?? []).filter((i) => i.level === "error").length;
                  const isDup = dupKeys.has(d.key);
                  const bad = errs > 0 || isDup || !d.hasManifest;
                  return (
                    <li
                      key={d.key}
                      className={
                        "ws-up-item" +
                        (d.key === activeKey ? " ws-up-item-on" : "") +
                        (bad ? " ws-up-item-bad" : "")
                      }
                    >
                      <button className="ws-up-item-main" onClick={() => setActiveKey(d.key)}>
                        <span className="ws-up-item-name">{d.form.name || d.dirName}</span>
                        <span className="ws-up-item-meta">
                          v{d.form.version || "?"} · {d.form.id || "—"}
                        </span>
                        <span className="ws-up-item-state">
                          {isDup
                            ? t("uploadDup")
                            : !d.hasManifest
                              ? t("uploadNoManifest")
                              : errs > 0
                                ? t("uploadItemErrors", { count: errs })
                                : t("uploadItemOk")}
                        </span>
                      </button>
                      <button
                        className="ws-clear"
                        onClick={() => removeDraft(d.key)}
                        disabled={busy}
                        aria-label={t("uploadRemove")}
                      >
                        <Trash2 size={13} strokeWidth={1.5} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* ③ 当前选中的那个插件的清单 */}
          {active && (
            <section className="ws-up-sec">
              <h3 className="ws-up-sec-title">
                {t("uploadFormTitle")} · {active.dirName}
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
                  <span className="ws-up-tip">{t("fName")}</span>
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

          {result && (
            <div className="ws-up-done">
              <Check size={14} strokeWidth={2} />
              <span>{t("uploadDone", { number: result.prNumber })}</span>
              <button className="ws-cta" onClick={() => void panelApi.openUrl(result.prUrl)}>
                {t("uploadOpenPr")}
                <ExternalLink size={12} strokeWidth={1.5} />
              </button>
            </div>
          )}
        </div>

        <div className="ws-upload-foot">
          {busy && (
            <span className="ws-up-phase">
              <LoaderCircle size={13} className="ws-spin" />
              {phaseText}
            </span>
          )}
          <button
            className="ws-cta ws-up-submit"
            onClick={() => void submit()}
            disabled={busy || !token || !login || !agreed || !ready}
          >
            {t("uploadSubmit", { count: drafts.length })}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
