import { motion } from "motion/react";
import { useMemo } from "react";
import { Camera, Eraser, Plus, Repeat, Layers, Trash2 } from "lucide-react";
import { ArtIcon } from "./ArtIcon";
import { save } from "@tauri-apps/plugin-dialog";
import { springSoft } from "../design/springs";
import { INTRO_OFF, useIntro } from "../lib/useIntro";
import { useFontStore } from "../state/fontStore";
import { buildFaceIndexCached, missingEntries, systemBackedEntries } from "../lib/snapshotKey";
import { useT } from "../lib/i18n";

export function SnapshotBar({ name }: { name: string }) {
  const t = useT();
  const intro = useIntro();
  const snapshots = useFontStore((s) => s.snapshots);
  const fonts = useFontStore((s) => s.fonts);
  const applySnapshot = useFontStore((s) => s.applySnapshot);
  /** 有一次应用正在跑时，两条应用按钮都锁住：两套批次会抢同一个进度条和取消标志 */
  const applying = useFontStore((s) => s.applyBusy);
  const addActiveToSnapshot = useFontStore((s) => s.addActiveToSnapshot);
  const removeMissingFromSnapshot = useFontStore((s) => s.removeMissingFromSnapshot);
  const deleteSnapshot = useFontStore((s) => s.deleteSnapshot);
  const exportSnapshot = useFontStore((s) => s.exportSnapshot);

  const snap = snapshots.find((sn) => sn.name === name);
  const entries = snap?.entries ?? [];
  // 快照条目不含路径，按可移植标识解析到本机字体后再判断“丢没丢”。
  // 索引与两次遍历都缓存起来：快照 2000 条时，每次渲染重算这两遍会明显拖慢打开速度。
  const index = useMemo(() => buildFaceIndexCached(fonts), [fonts]);
  const { missing, systemCount } = useMemo(() => {
    // 「系统字体」只算「本机只能靠系统安装提供」的条目：同名字体在字体库里也有一份时不算，
    // 否则会出现「326 条条目里 320 个系统字体」这种吓人的数字（见 snapshotKey.ts 注释）
    return {
      missing: missingEntries(entries, index),
      systemCount: systemBackedEntries(entries, index).length,
    };
  }, [entries, index]);

  const exportFlow = async () => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const safeName = name.replace(/[\\/:*?"<>|]/g, "_").trim() || "snapshot";
    const dest = await save({
      defaultPath: `FontManager_${safeName}_${ts}.S-FontManager`,
      title: t("menu.exportSnapshotTitle", { name }),
      filters: [{ name: "FontManager", extensions: ["S-FontManager"] }],
    });
    if (dest) void exportSnapshot(name, dest);
  };

  return (
    <motion.div
      className="snapshot-bar"
      initial={intro ? { opacity: 0, y: -8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={intro ? springSoft : INTRO_OFF}
    >
      <span className="snapshot-bar-title">
        <Camera size={15} strokeWidth={1.5} />
        {name}
      </span>
      {systemCount > 0 && (
        <span className="snapshot-system-chip" data-hint="hint.snapSystem">
          {t("snap.systemChip", { count: systemCount })}
        </span>
      )}
      <button
        className="snapshot-btn"
        data-hint="hint.snapSwitch"
        disabled={applying}
        onClick={() => void applySnapshot(name, "switch")}
      >
        <Repeat size={13} strokeWidth={1.5} />
        {t("snap.applySwitch")}
      </button>
      <button
        className="snapshot-btn"
        data-hint="hint.snapMerge"
        disabled={applying}
        onClick={() => void applySnapshot(name, "merge")}
      >
        <Layers size={13} strokeWidth={1.5} />
        {t("snap.applyMerge")}
      </button>
      <button className="snapshot-btn" data-hint="hint.snapAddActive" onClick={() => void addActiveToSnapshot(name)}>
        <Plus size={13} strokeWidth={1.5} />
        {t("snap.addActive")}
      </button>
      {missing.length > 0 && (
        <button
          className="snapshot-btn snapshot-warn"
          data-hint="hint.removeMissing"
          onClick={() => void removeMissingFromSnapshot(name)}
        >
          <Eraser size={13} strokeWidth={1.5} />
          {t("snap.removeMissing", { count: missing.length })}
        </button>
      )}
      <span className="snapshot-bar-spacer" />
      <button className="snapshot-btn" onClick={() => void exportFlow()} data-hint="hint.exportSnapshot">
        <ArtIcon name="snapshot" size={14} />
        {t("menu.exportSnapshot")}
      </button>
      <button
        data-hint="hint.clearSnapshot"
        className="snapshot-btn snapshot-danger"
        onClick={() => void deleteSnapshot(name)}
      >
        <Trash2 size={13} strokeWidth={1.5} />
        {t("menu.deleteSnapshot")}
      </button>
    </motion.div>
  );
}
