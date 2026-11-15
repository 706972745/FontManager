/**
 * 插件运行时管理（1.4.11）。
 *
 * 背景：安装包不再内置 Python / Node 运行时（1.4.11 起按需下载）。
 * 这里让用户「看得见本机有哪些解释器、占多少空间、被哪些插件用」，
 * 缺了可以一键下载补全，不用了可以删掉省空间 —— 决定权全在用户手里。
 */
import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { HardDriveDownload, Trash2, RefreshCw } from "lucide-react";
import { ipc, type RuntimeProgress, type RuntimeStatus } from "../lib/ipc";
import { useT } from "../lib/i18n";

interface DlState {
  phase: RuntimeProgress["phase"];
  percent: number;
  error?: string;
}

/**
 * 版本比较：`"Python 3.13.14"` / `"v24.11.0"` / `"3.13"` 都取前三个数字段。
 *
 * 只用来说明「远端比本机新」，不承担语义化版本的完整规则（rc / post 不参与）——
 * 内置运行时是官方发行版，`3.13.14` 这样的三段号足够判先后。
 */
function verTuple(raw: string): [number, number, number] | null {
  const m = raw.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

function verNewer(a: string, b: string): boolean {
  const x = verTuple(a);
  const y = verTuple(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}

export function RuntimeManager() {
  const t = useT();
  const [rows, setRows] = useState<RuntimeStatus[] | null>(null);
  const [dl, setDl] = useState<Record<string, DlState>>({});
  const [busy, setBusy] = useState<string | null>(null);
  /** 最新 release 里的运行时版本（null = 还没问到；{} = 问过但拿不到） */
  const [remote, setRemote] = useState<Record<string, string> | null>(null);

  const refresh = useCallback(() => {
    ipc
      .runtimesStatus()
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  useEffect(() => {
    refresh();
    // 远端版本只用来「提示有新版」：断网/老 release 没有这个文件都返回 {}，
    // 属于正常情况，界面什么都不显示。
    void ipc
      .runtimesRemoteVersions()
      .then(setRemote)
      .catch(() => setRemote({}));
    const un = listen<RuntimeProgress>("runtime:progress", (e) => {
      const p = e.payload;
      if (p.phase === "done") {
        setDl((s) => {
          const next = { ...s };
          next[p.kind] = { phase: "done", percent: 100 };
          return next;
        });
        refresh(); // 拿到安装后的版本/大小
        window.setTimeout(
          () =>
            setDl((s) => {
              const next = { ...s };
              delete next[p.kind];
              return next;
            }),
          2500,
        );
        return;
      }
      setDl((s) => ({
        ...s,
        [p.kind]: { phase: p.phase, percent: p.percent ?? 0, error: p.error },
      }));
      if (p.phase === "error") refresh();
    });
    return () => {
      void un.then((f) => f());
    };
  }, [refresh]);

  const doDelete = async (r: RuntimeStatus) => {
    if (
      !window.confirm(
        t("settings.rtConfirmDelete", { label: r.label, plugins: r.pluginsUsing.join("、") || "—" }),
      )
    )
      return;
    setBusy(r.kind);
    try {
      await ipc.runtimeDelete(r.kind);
    } catch (e) {
      window.alert(String(e));
    }
    setBusy(null);
    refresh();
  };

  const doDownload = async (r: RuntimeStatus) => {
    setBusy(r.kind);
    try {
      await ipc.runtimeDownload(r.kind);
      // 进度由 runtime:progress 事件驱动；这里等事件收尾
    } catch (e) {
      window.alert(String(e));
      setBusy(null);
      refresh();
    }
  };

  if (rows === null) return null; // 状态还没到（或非 Tauri 环境），不占版面

  return (
    <div className="settings-plugin-group" style={{ marginTop: 4 }}>
      <div className="settings-row settings-plugins-head">
        <div className="settings-sub">{t("settings.runtimesSub")}</div>
        <div className="settings-row settings-row-tight">
          <button className="settings-add-folder" onClick={refresh}>
            <RefreshCw size={13} strokeWidth={1.5} />
            {t("settings.pluginsRefresh")}
          </button>
        </div>
      </div>
      {rows.map((r) => {
        const st = dl[r.kind];
        // 远端版本：只在「本机已装」且「远端确实更新」时提示一句。
        // **不自动下载** —— 换解释器版本会牵动插件依赖（Pillow / fontTools 的 ABI），
        // 装不装由用户自己卸载后重下（用户 2026-11-15 口径）。
        const remoteVer = remote?.[r.kind];
        const newer =
          !!remoteVer && !!r.bundledVersion && verNewer(remoteVer, r.bundledVersion);
        const using =
          r.pluginsUsing.length > 0
            ? t("settings.rtUsing", { plugins: r.pluginsUsing.join("、") })
            : t("settings.rtUsingNone");
        return (
          <div key={r.kind} className="settings-row settings-plugin-row">
            <div>
              <div className="settings-label">
                <span>{r.kind === "python" ? "Python" : "Node.js"}</span>
                {r.bundledVersion ? (
                  <span className="settings-plugin-version">
                    {r.bundledVersion.replace(/^Python /, "")}
                  </span>
                ) : (
                  <span className="settings-plugin-version">{t("settings.rtMissing")}</span>
                )}
              </div>
              <div className="settings-sub" data-hint-text={r.bundledDir ?? undefined}>
                {st?.phase === "error" ? (
                  <>{t("settings.rtDlFailed", { error: st.error ?? "" })}</>
                ) : st?.phase === "download" ? (
                  <>{t("settings.rtDownloading", { percent: String(st.percent) })}</>
                ) : st?.phase === "extract" ? (
                  <>{t("settings.rtExtracting")}</>
                ) : r.bundledVersion ? (
                  <>
                    {t("settings.rtBundled", { size: String(Math.round(r.bundledSizeMb ?? 0)) })}
                    {r.systemVersion ? ` · ${t("settings.rtSystemFound", { version: r.systemVersion })}` : ""}
                    {" · "}
                    {using}
                    {r.pluginsRunning > 0 ? ` · ${t("settings.rtRunning", { count: String(r.pluginsRunning) })}` : ""}
                  </>
                ) : (
                  <>
                    {t("settings.rtMissingHint")}
                    {r.systemVersion ? ` · ${t("settings.rtSystemFound", { version: r.systemVersion })}` : ""}
                    {" · "}
                    {using}
                  </>
                )}
              </div>
              {newer && (
                <div className="settings-sub settings-rt-update">
                  {t("settings.rtUpdateAvailable", { version: remoteVer ?? "" })}
                  {" · "}
                  {t("settings.rtUpdateHint")}
                </div>
              )}
              {st?.phase === "download" && (
                <div className="load-progress" aria-hidden>
                  <div className="load-track">
                    <div className="load-fill" style={{ width: `${st.percent}%` }} />
                  </div>
                </div>
              )}
            </div>
            <div className="settings-plugin-actions">
              {!r.bundledVersion && st?.phase !== "download" && (
                <button
                  className="settings-library-open"
                  aria-label={t("settings.rtDownload")}
                  data-hint-text={t("settings.rtDownloadHint")}
                  disabled={busy === r.kind}
                  onClick={() => void doDownload(r)}
                >
                  <HardDriveDownload size={13} strokeWidth={1.5} />
                </button>
              )}
              {r.bundledVersion && (
                <button
                  className="settings-library-open"
                  aria-label={t("settings.rtDelete")}
                  data-hint-text={t("settings.rtDeleteHint")}
                  disabled={busy === r.kind || r.pluginsRunning > 0 || st?.phase === "download"}
                  onClick={() => void doDelete(r)}
                >
                  <Trash2 size={13} strokeWidth={1.5} />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
