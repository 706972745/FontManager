import { AnimatePresence, motion } from "motion/react";
import { Tag, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { scrimFade, spring, springSnappy, springSoft } from "../design/springs";
import { useFontStore } from "../state/fontStore";
import { useFocusTrap } from "../lib/useFocusTrap";
import { playTag } from "../lib/sound";
import { useT } from "../lib/i18n";
import { BlinkCaretInput } from "../design/primitives/BlinkCaretInput";
import { tagColorClass } from "./TagDock";
import { tagLabel } from "../lib/tagLabels";

export function BulkTagPrompt() {
  const t = useT();
  const bulkTagFor = useFontStore((s) => s.bulkTagFor);
  const setBulkTagFor = useFontStore((s) => s.setBulkTagFor);
  const applyTagToFamilies = useFontStore((s) => s.applyTagToFamilies);
  const storeTags = useFontStore((s) => s.tags);
  const tagMeta = useFontStore((s) => s.tagMeta);
  const trapRef = useFocusTrap<HTMLDivElement>(Boolean(bulkTagFor));
  const [tag, setTag] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (bulkTagFor) {
      setTag("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [bulkTagFor]);

  /**
   * 已有标签候选（按输入过滤）。
   *
   * 与 AssetManager 的批量打标签同一个交互：**点一下直接套用**，不用把名字完整打一遍。
   * 数据源只用 `tags`（用户手工那份）—— 自动标签不能手工挂到一批字体上，
   * 列出来只会误导（它们是推导结果，挂上去也不落库）。
   * 颜色点照标签自己的元数据上色，跟侧栏面板是同一套语义。
   */
  const candidates = useMemo(() => {
    const names = new Set<string>();
    for (const list of Object.values(storeTags)) for (const name of list) names.add(name);
    const needle = tag.trim().toLowerCase();
    return [...names]
      .filter((name) => !needle || name.toLowerCase().includes(needle) || tagLabel(name, t).toLowerCase().includes(needle))
      .sort((a, b) => tagLabel(a, t).localeCompare(tagLabel(b, t)))
      .slice(0, 24);
  }, [storeTags, tag, t]);

  const applyWith = (value: string) => {
    if (!bulkTagFor) return;
    const clean = value.trim();
    if (!clean) return;
    playTag(true);
    void applyTagToFamilies(clean, bulkTagFor);
    setBulkTagFor(null);
  };

  const apply = () => applyWith(tag);

  return (
    <AnimatePresence>
      {bulkTagFor && (
        <motion.div
          className="compare-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={scrimFade}
          onClick={() => setBulkTagFor(null)}
        >
          <motion.div
            ref={trapRef}
            className="bulktag-panel glass-e3"
            initial={{ y: 24, scale: 0.97, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 16, scale: 0.98, opacity: 0 }}
            transition={springSoft}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={t("bulk.aria")}
          >
            <header className="compare-head">
              <h2 className="bulktag-title">
                <Tag size={15} strokeWidth={1.5} />
                {t("bulk.title", { count: bulkTagFor.length })}
              </h2>
              <button
                className="detail-close"
                aria-label={t("bulk.cancel")}
                onClick={() => setBulkTagFor(null)}
              >
                <X size={15} strokeWidth={1.5} />
              </button>
            </header>
            <div className="topbar-field">
              <BlinkCaretInput
                ref={inputRef}
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") apply();
                  if (e.key === "Escape") setBulkTagFor(null);
                }}
                placeholder={t("bulk.placeholder")}
                aria-label={t("bulk.tagNameAria")}
                spellCheck={false}
              />
            </div>
            {candidates.length > 0 && (
              <div className="bulktag-candidates" role="listbox" aria-label={t("bulk.candidatesAria")}>
                {candidates.map((name) => (
                  <button
                    key={name}
                    className={`bulktag-candidate ${tagColorClass(tagMeta[name]?.color)}`}
                    onClick={() => applyWith(name)}
                    title={name}
                  >
                    <span className="tag-dot" aria-hidden />
                    <span className="bulktag-candidate-name">{tagLabel(name, t)}</span>
                  </button>
                ))}
              </div>
            )}
            <motion.button
              className="bulktag-apply"
              disabled={!tag.trim()}
              onClick={apply}
              whileHover={{ y: -1, transition: spring }}
              whileTap={{ scale: 0.97, transition: springSnappy }}
            >
              {t("bulk.apply", { count: bulkTagFor.length })}
            </motion.button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
