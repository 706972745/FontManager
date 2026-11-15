/**
 * 「插件中心面板自动更新」开关（2.2.1）。
 *
 * 为什么单独一个组件：`prefs` 在设置页里是整包读写的（`get_settings` / `set_settings`），
 * 而这条偏好只被两处用（这里与 App 启动时的自动检查），塞进那个大对象里
 * 要连带改类型、改默认值、改保存路径 —— 不值得。这里只认 `prefs` 里的一个布尔。
 *
 * 默认值 = **开**：面板是独立产物，不自查就永远停在旧版；但开关必须给，
 * 因为「联网就自动下载东西」这类行为不能让用户没法关。
 */
import { useEffect, useState } from "react";
import { ipc } from "../lib/ipc";
import { useT } from "../lib/i18n";
import { PillToggle } from "../design/primitives/PillToggle";

export function PluginCenterAutoUpdate() {
  const t = useT();
  const [on, setOn] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    void ipc
      .getPrefs()
      .then((p) => {
        // 没写过这条 → 默认开（与后端 `!matches!(…, Some(Bool(false)))` 同口径）
        if (alive) setOn(p?.pluginCenterAutoUpdate !== false);
      })
      .catch(() => {
        if (alive) setOn(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (on === null) return null;

  return (
    <div className="settings-row" data-relation="enable-below">
      <div>
        <div className="settings-label">
          {t("settings.pluginCenterAutoUpdate")}
          <span className="settings-sub">{t("settings.pluginCenterAutoUpdateSub")}</span>
        </div>
      </div>
      <PillToggle
        on={on}
        onChange={(next) => {
          setOn(next);
          void ipc.setPrefs({ pluginCenterAutoUpdate: next }).catch(() => setOn(!next));
        }}
        label={t("settings.pluginCenterAutoUpdate")}
      />
    </div>
  );
}
