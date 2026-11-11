import { Download, ArrowUpRight, RefreshCw } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "../design/primitives/Toast";
import { PillToggle } from "../design/primitives/PillToggle";
import { useT } from "../lib/i18n";
import { ipc, type UpdateCheck, type UpdateProgress } from "../lib/ipc";
import { APP_VERSION } from "../lib/version";

/**
 * 设置 → 更新。
 *
 * 1.8.1 的约定是「只读，不下载、不执行任何远端内容」，安装包让用户去浏览器下。
 * 1.8.4 起多了一条**用户点了才会走**的一键路径（用户要求「静默下载 + 静默安装」）；
 * 1.8.7 按用户要求把「下载并安装」做成常驻按钮 —— 不用先点「检查更新」，
 * 点它 = 检查 + 下载（进度条）+ 静默安装，「打开发布页」只在装不了时兜底。
 * 边界没有放松，反而收得更紧：
 *
 * 1. **只在这三种条件同时满足时出现按钮**：发布里带了 NSIS 安装包直链、带了 SHA-256
 *    （GitHub Asset 的 digest）、当前是「按用户安装」的版本。缺一条就退回「打开下载页」，
 *    绝不做「先下下来再说」。
 * 2. **下载完必须过校验**：哈希对不上直接删掉并报错，不执行。执行前还会再算一次，
 *    防的是「下载完到点安装之间文件被换掉」。
 * 3. **只认白名单站点**：https + github.com / objects.githubusercontent.com /
 *    release-assets.githubusercontent.com，重定向后的落点也要在里面。
 * 4. **不碰 MSI**：perMachine 安装需要 UAC，静默跑必然失败或卡住等一个没人能点的框。
 * 5. **还是可以彻底关掉**：`updateCheck` 关掉后连版本号都不查，自然也谈不上更新。
 * 6. **仍然可以跳过某个版本**：`updateSkipped` 记住用户点过「跳过」的版本号。
 *
 * 安装动作会重启软件 —— 这是用户点「下载并安装」时就已经接受的代价（Windows 不允许
 * 覆盖正在运行的 exe，必须先退出）。
 */
export function UpdateSection() {
  const t = useT();
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<UpdateCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 下载 / 校验 / 安装的实时状态；null = 没在走这条路径 */
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  /**
   * 一键安装的一次性闸门。
   * `progress` 是 state，从点下到重渲染之间有一帧空档：手快连点两下
   * （或触控板双击）会进两次 `downloadAndInstall`，下两份安装包、起两个安装进程。
   * ref 是同步写入的，第二下直接被挡掉。失败时才打开，允许重试。
   */
  const installLock = useRef(false);

  useEffect(() => {
    void ipc
      .getPrefs()
      .then((p) => {
        // 老用户的 state.json 里没有这个键：默认开启
        const v = p?.updateCheck;
        setAuto(typeof v === "boolean" ? v : true);
      })
      .catch(() => {});
  }, []);

  // 后端每下 200ms 推一次进度；监听器随组件卸载一起摘掉
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    void listen<UpdateProgress>("update:progress", (e) => {
      if (!alive) return;
      setProgress(e.payload);
    }).then((f) => {
      off = f;
      if (!alive) f();
    });
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  /**
   * 检查更新。返回结果给调用方（「下载并安装」内部要先查一次再下载）；
   * `silent` = 不弹错误 toast（那条路自己会把错误写进 catch 分支）。
   */
  const check = useCallback(
    async (force: boolean, silent = false): Promise<UpdateCheck | null> => {
      setBusy(true);
      setError(null);
      try {
        const next = await ipc.checkUpdate(force);
        setInfo(next);
        return next;
      } catch (e) {
        setError(String(e));
        // 手点时把失败原因也弹出来（面板里那行小字容易被忽略）
        if (force && !silent) toast.error(t("settings.updateFailed"), String(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const setAutoCheck = (on: boolean) => {
    setAuto(on);
    void ipc.setPrefs({ updateCheck: on }).catch((e) => toast.error(String(e)));
  };

  const skip = () => {
    if (!info) return;
    void ipc
      .setPrefs({ updateSkipped: info.latest })
      .then(() => toast.success(t("settings.updateSkipped", { version: info.latest })))
      .catch((e) => toast.error(String(e)));
  };

  /**
   * 「下载并安装」完整链路（1.8.7 起按钮常驻，不再要求先点「检查更新」）：
   * 检查（顺带刷新缓存）→ 有新版 → 下载（进度条）→ 校验（后端做）→ 静默安装重启。
   * 已是最新就安静地收尾；这一版装不了（MSI / 缺直链）退回「打开发布页」。
   */
  const downloadAndInstall = async () => {
    if (progress || installLock.current) return;
    installLock.current = true;
    setError(null);
    try {
      const cur = info?.hasUpdate ? info : await check(true, true);
      if (!cur) return;
      if (!cur.hasUpdate) {
        toast.success(t("settings.updateLatest"));
        return;
      }
      if (!cur.canAutoInstall) {
        // MSI / 缺直链：静默装不了，才退回浏览器
        await ipc.openUrl(cur.url).catch((e) => toast.error(String(e)));
        return;
      }
      setProgress({ phase: "download", received: 0, total: 0, percent: 0 });
      const path = await ipc.updateDownload(cur.setupUrl, cur.setupName, cur.sha256);
      setProgress({ phase: "ready", received: 1, total: 1, percent: 100 });
      await ipc.updateInstall(path, cur.sha256);
      // 走到这里安装脚本已经起来了，后端会在 1.2 秒后退出本进程
    } catch (e) {
      setProgress(null);
      setError(String(e));
      toast.error(t("settings.updateInstallFailed"), String(e));
    } finally {
      installLock.current = false;
    }
  };

  const downloading = progress !== null && progress.phase !== "error";
  const manualOnly = !!info?.hasUpdate && !info.canAutoInstall;

  return (
    <section className="settings-section">
      <div className="detail-heading">{t("settings.update")}</div>

      <div className="settings-row">
        <div>
          <div className="settings-label">{t("settings.updateAuto")}</div>
          <div className="settings-sub tabular">
            {t("settings.updateCurrent")} · {APP_VERSION}
          </div>
        </div>
        <PillToggle on={auto} onChange={setAutoCheck} label={t("settings.updateAuto")} />
      </div>
      <div className="settings-sub settings-update-line">{t("settings.updateAutoSub")}</div>

      <div className="settings-data-actions settings-update-actions">
        <button
          className="settings-data-btn"
          disabled={busy || downloading}
          onClick={() => void check(true)}
          data-hint-text={t("settings.updateCheckHint")}
        >
          <RefreshCw size={13} strokeWidth={1.5} className={busy ? "spin" : undefined} />
          {busy ? t("settings.updateChecking") : t("settings.updateCheck")}
        </button>

        {/* 「下载并安装」常驻（1.8.7，用户要求：不跳发布页，点了就直接下载 +
            进度条 + 静默安装）。只有查到新版但这一版装不了（MSI / 缺直链）时，
            同一个位置才退化成「打开发布页」—— 那种情况下跳浏览器是唯一出路。 */}
        {!downloading && (
          <button
            className="settings-data-btn"
            disabled={busy}
            onClick={() => void downloadAndInstall()}
            data-hint-text={t("settings.updateCheckHint")}
          >
            {manualOnly ? (
              <ArrowUpRight size={12} strokeWidth={1.5} className="settings-btn-arrow" />
            ) : (
              <Download size={13} strokeWidth={1.5} />
            )}
            {manualOnly ? t("settings.updateDownload") : t("settings.updateInstallNow")}
          </button>
        )}
        {info?.hasUpdate && !info.skipped && !downloading && (
          <button className="settings-data-btn" onClick={skip}>
            {t("settings.updateSkip")}
          </button>
        )}
      </div>

      {downloading && (
        <div className="settings-update-progress">
          <div className="settings-update-bar" role="progressbar" aria-valuenow={progress.percent}>
            <i style={{ width: `${Math.max(progress.percent, 2)}%` }} />
          </div>
          <div className="settings-sub tabular">
            {progress.phase === "download"
              ? t("settings.updateDownloading", { percent: String(progress.percent) })
              : progress.phase === "verify"
                ? t("settings.updateVerifying")
                : t("settings.updateInstalling")}
          </div>
        </div>
      )}

      {error && <div className="settings-sub settings-update-line">{error}</div>}
      {!error && info && (
        <div className="settings-sub settings-update-line">
          {info.hasUpdate
            ? t("settings.updateAvailable", { latest: info.latest })
            : t("settings.updateLatest")}
          {/* 只有 raw / cdn 兜底时才说明「没有发布说明」：正常路径不用画蛇添足 */}
          {info.hasUpdate && info.source !== "github" ? ` · ${t("settings.updateNoNotes")}` : ""}
        </div>
      )}
      {/* 有新版但这一版装不了：说清楚是为什么，别让用户以为按钮坏了 */}
      {manualOnly && !error && (
        <div className="settings-sub settings-update-line">{t("settings.updateManualHint")}</div>
      )}
      {!error && info?.hasUpdate && info.notes.trim() && (
        <pre className="settings-update-notes">{info.notes}</pre>
      )}
    </section>
  );
}
