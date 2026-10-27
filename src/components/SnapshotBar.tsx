import { motion } from "motion/react";
import { Camera, Download, Eraser, Plus, Repeat, Layers, Trash2 } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { springSoft } from "../design/springs";
import { INTRO_OFF, useIntro } from "../lib/useIntro";
import { useFontStore } from "../state/fontStore";
import { buildFaceIndex, missingEntries, resolveEntry } from "../lib/snapshotKey";
import { useT } from "../lib/i18n";

export function SnapshotBar({ name }: { name: string }) {
  const t = useT();
  const intro = useIntro();
  const snapshots = useFontStore((s) => s.snapshots);
  const fonts = useFontStore((s) => s.fonts);
  const applySnapshot = useFontStore((s) => s.applySnapshot);
  const addActiveToSnapshot = useFontStore((s) => s.addActiveToSnapshot);
  const removeMissingFromSnapshot = useFontStore((s) => s.removeMissingFromSnapshot);
  const deleteSnapshot = useFontStore((s) => s.deleteSnapshot);
  const exportSnapshot = useFontStore((s) => s.exportSnapshot);

  const snap = snapshots.find((sn) => sn.name === name);
  const entries = snap?.entries ?? [];
  // 快照条目不含路径，按可移植标识解析到本机字体后再判断“丢没丢”
  const index = buildFaceIndex(fonts);
  const missing = missingEntries(entries, index);
  const systemCount = entries.filter((e) => e.system && resolveEntry(e, index).length > 0).length;

  const exportFlow = async () => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const safeName = name.replace(/[\\/:*?"<>|]/g, "_").trim() || "snapshot";
    const dest = await save({
      defaultPath: `ZFontManager_${safeName}_${ts}.json`,
      title: t("menu.exportSnapshotTitle", { name }),
      filters: [{ name: "JSON", extensions: ["json"] }],
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
        <span className="snapshot-system-chip" title={t("snap.systemNote", { count: systemCount })}>
          {t("snap.systemChip", { count: systemCount })}
        </span>
      )}
      <button
        className="snapshot-btn"
        title={t("snap.applySwitchTip")}
        onClick={() => void applySnapshot(name, "switch")}
      >
        <Repeat size={13} strokeWidth={1.5} />
        {t("snap.applySwitch")}
      </button>
      <button
        className="snapshot-btn"
        title={t("snap.applyMergeTip")}
        onClick={() => void applySnapshot(name, "merge")}
      >
        <Layers size={13} strokeWidth={1.5} />
        {t("snap.applyMerge")}
      </button>
      <button className="snapshot-btn" onClick={() => void addActiveToSnapshot(name)}>
        <Plus size={13} strokeWidth={1.5} />
        {t("snap.addActive")}
      </button>
      {missing.length > 0 && (
        <button
          className="snapshot-btn snapshot-warn"
          onClick={() => void removeMissingFromSnapshot(name)}
          title={missing.map((e) => e.family).join("\n")}
        >
          <Eraser size={13} strokeWidth={1.5} />
          {t("snap.removeMissing", { count: missing.length })}
        </button>
      )}
      <span className="snapshot-bar-spacer" />
      <button className="snapshot-btn" onClick={() => void exportFlow()}>
        <Download size={13} strokeWidth={1.5} />
        {t("menu.exportSnapshot")}
      </button>
      <button
        className="snapshot-btn snapshot-danger"
        onClick={() => void deleteSnapshot(name)}
      >
        <Trash2 size={13} strokeWidth={1.5} />
        {t("menu.deleteSnapshot")}
      </button>
    </motion.div>
  );
}
