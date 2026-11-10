import { ArrowUpRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "../design/primitives/Toast";
import { PillToggle } from "../design/primitives/PillToggle";
import { useT } from "../lib/i18n";
import { ipc, type UpdateCheck } from "../lib/ipc";
import { APP_VERSION } from "../lib/version";

/**
 * 设置 → 更新（1.9.0）。
 *
 * 用户要求「加入检查更新，检查是否有新版本可用」。三条硬约定：
 *
 * 1. **只读，不自动安装**：后端只取版本号与发布说明，安装包由用户在浏览器里下载。
 *    自动替换可执行文件是一件「仓库被投毒就等于被投毒」的事，不值得为省一次点击去做。
 * 2. **可以彻底关掉**：`updateCheck` 关掉之后那一次匿名 GET 都不会发（同一台机器可能装在
 *    内网机器上，任何出网请求都该是用户自己点头的）。
 * 3. **可以跳过某个版本**：`updateSkipped` 记住用户点过「跳过」的版本号，
 *    下次自动检查就不再提示它（手点「检查更新」仍然会如实显示）。
 */
export function UpdateSection() {
  const t = useT();
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<UpdateCheck | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const check = useCallback(
    async (force: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const next = await ipc.checkUpdate(force);
        setInfo(next);
      } catch (e) {
        setError(String(e));
        // 手点时把失败原因也弹出来（面板里那行小字容易被忽略）
        if (force) toast.error(t("settings.updateFailed"), String(e));
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
          disabled={busy}
          onClick={() => void check(true)}
          data-hint-text={t("settings.updateCheckHint")}
        >
          <RefreshCw size={13} strokeWidth={1.5} className={busy ? "spin" : undefined} />
          {busy ? t("settings.updateChecking") : t("settings.updateCheck")}
        </button>
        {info?.hasUpdate && (
          <button
            className="settings-data-btn"
            onClick={() => void ipc.openUrl(info.url).catch((e) => toast.error(String(e)))}
          >
            <ArrowUpRight size={12} strokeWidth={1.5} className="settings-btn-arrow" />
            {t("settings.updateDownload")}
          </button>
        )}
        {info?.hasUpdate && !info.skipped && (
          <button className="settings-data-btn" onClick={skip}>
            {t("settings.updateSkip")}
          </button>
        )}
      </div>

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
      {!error && info?.hasUpdate && info.notes.trim() && (
        <pre className="settings-update-notes">{info.notes}</pre>
      )}
    </section>
  );
}
