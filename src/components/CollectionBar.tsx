import { motion } from "motion/react";
import { useMemo } from "react";
import { Download, FolderOpen, Layers, Plus, Repeat, Trash2 } from "lucide-react";
import { ArtIcon } from "./ArtIcon";
import { springSoft } from "../design/springs";
import { INTRO_OFF, useIntro } from "../lib/useIntro";
import { exportFontList } from "../lib/menus";
import { faceKey } from "../lib/snapshotKey";
import { familiesFor, useFontStore } from "../state/fontStore";
import { useT } from "../lib/i18n";

/**
 * 分组（Collection）视图顶部操作条 —— 与 `SnapshotBar` 同一套骨架、同一批 CSS 类，
 * 只是把「切换 / 合并」的语义换成分组自己的（用户 2026-11-10 要求）。
 *
 * 与快照的差别，决定了这里放哪些按钮：
 *   · 快照是「某一刻字体启用状态的存档」，所以核心是切换 / 合并 / 清除；
 *   · 分组是「用户自己攒的一堆字体」，核心是**把它们用起来**（启用 / 存成快照）
 *     与**维护成员**（加入当前启用的、导出清单、删除）。
 *   · 分组没有「缺失文件」的概念（成员是字族名，不依赖路径），所以没有快照条那个警告按钮。
 */
export function CollectionBar({ name }: { name: string }) {
  const t = useT();
  const intro = useIntro();
  const fonts = useFontStore((s) => s.fonts);
  const tags = useFontStore((s) => s.tags);
  const collections = useFontStore((s) => s.collections);
  const collectionFaces = useFontStore((s) => s.collectionFaces);
  /** 应用批次互斥：与快照共用 applyBusy，跑批期间两边按钮都锁死 */
  const applying = useFontStore((s) => s.applyBusy);
  const applyCollection = useFontStore((s) => s.applyCollection);
  const addActiveToCollection = useFontStore((s) => s.addActiveToCollection);
  const createSnapshotFromCollection = useFontStore((s) => s.createSnapshotFromCollection);
  const requestDeleteCollection = useFontStore((s) => s.requestDeleteCollection);

  /** 组内字族：与分组视图的过滤口径一致（整族成员 + 字重级成员） */
  const members = useMemo(() => {
    const whole = new Set(collections[name] ?? []);
    const keys = new Set(collectionFaces[name] ?? []);
    if (whole.size === 0 && keys.size === 0) return [];
    return [...familiesFor(fonts, tags).values()].filter(
      (f) => whole.has(f.name) || f.faces.some((fc) => keys.has(faceKey(fc))),
    );
  }, [fonts, tags, collections, collectionFaces, name]);

  return (
    <motion.div
      className="snapshot-bar"
      initial={intro ? { opacity: 0, y: -8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={intro ? springSoft : INTRO_OFF}
    >
      <span className="snapshot-bar-title">
        <FolderOpen size={15} strokeWidth={1.5} />
        {name}
      </span>
      <span className="snapshot-system-chip" data-hint="hint.collCount">
        {t("coll.count", { count: members.length })}
      </span>
      <button
        className="snapshot-btn"
        data-hint="hint.collSwitch"
        disabled={applying}
        onClick={() => void applyCollection(name, "switch")}
      >
        <Repeat size={13} strokeWidth={1.5} />
        {t("coll.applySwitch")}
      </button>
      <button
        className="snapshot-btn"
        data-hint="hint.collMerge"
        disabled={applying}
        onClick={() => void applyCollection(name, "merge")}
      >
        <Layers size={13} strokeWidth={1.5} />
        {t("snap.applyMerge")}
      </button>
      <button
        className="snapshot-btn"
        data-hint="hint.collAddActive"
        onClick={() => void addActiveToCollection(name)}
      >
        <Plus size={13} strokeWidth={1.5} />
        {t("snap.addActive")}
      </button>
      <span className="snapshot-bar-spacer" />
      <button
        className="snapshot-btn"
        data-hint="hint.collSnapshot"
        onClick={() => void createSnapshotFromCollection(name)}
      >
        <ArtIcon name="snapshot" size={14} />
        {t("menu.snapshotFromCollection")}
      </button>
      <button
        className="snapshot-btn"
        data-hint="hint.collExport"
        onClick={() => void exportFontList(members, name)}
      >
        <Download size={13} strokeWidth={1.5} />
        {t("menu.exportFontList")}
      </button>
      <button
        className="snapshot-btn snapshot-danger"
        data-hint="hint.collDelete"
        onClick={() => requestDeleteCollection(name)}
      >
        <Trash2 size={13} strokeWidth={1.5} />
        {t("menu.deleteCollection")}
      </button>
    </motion.div>
  );
}
