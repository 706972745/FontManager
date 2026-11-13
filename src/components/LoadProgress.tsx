import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { useFontStore } from "../state/fontStore";

/**
 * 字库读取进度条。
 *
 * 字体库动辄几千个文件，冷启动（尤其是第一次 / 换了大目录之后）要挨个解析，
 * 这段时间界面里是空的，用户只看到「在转」却不知道还要等多久。这里把
 * `scan:progress` 的 done/total 直接换成百分比摆在底部，心里有数。
 *
 * 2.1.4 起它要区分三种「还没读完」的态（原来只有一种，一律先当成「正在查找字体」）：
 *   ① 骨架屏态：种子还没到，列表里一个字体都没有 → 「正在恢复上次启用的字体…」
 *   ② 种子态：列表已经能用了，后台还在读 → 「后台读取字体库 {done}/{total}」
 *   ③ 读完那一瞬：挂 1.5s 的「字体库已就绪」再退场（PRD §4 C4）
 * 三者共用这条贴底细线，都不遮挡列表与侧栏的点击区域。
 *
 * 完整界面和速览界面都用它（compact 用于速览），读完自动消失。
 */
export function LoadProgress({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const phase = useFontStore((s) => s.phase);
  const scan = useFontStore((s) => s.scanProgress);
  /** 种子到了没有：决定这一条到底在说「恢复上次启用的」还是「正在读你的字体」 */
  const seedReady = useFontStore((s) => s.seedReady);
  /** 列表里已经有字体了 = 列表已经可用（种子或上一次的库） */
  const seeded = useFontStore((s) => s.fonts.length > 0);
  /**
   * 「刚读完」的一次性收尾。只认「scanning → ready」这一条真实迁移：
   * 组件重挂（切速览、切视图）时 phase 已经是 ready，不该再弹一次「已就绪」。
   */
  const [justReady, setJustReady] = useState(false);
  const wasReading = useRef(false);
  useEffect(() => {
    if (phase === "scanning") {
      wasReading.current = true;
      return;
    }
    if (phase !== "ready" || !wasReading.current) return;
    wasReading.current = false;
    setJustReady(true);
    const timer = window.setTimeout(() => setJustReady(false), 1500);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const reading = phase === "scanning";
  /**
   * 读失败但手里还有种子列表：列表照常可用（ADR-07 不清空），只补一句「部分数据」。
   * 不给错误弹窗 —— 用户此刻最需要的是「还能接着用」和一次重试（R-15）。
   */
  const degraded = phase === "error" && seeded;
  if (!reading && !justReady && !degraded) return null;

  const { done, total } = scan;
  // 还没数出总数（正在遍历目录）时给个「不确定」态：只有文案、没有百分比
  const percent =
    reading && total > 0
      ? Math.max(0, Math.min(100, Math.round((done / total) * 100)))
      : null;

  const text = degraded
    ? t("load.partialData")
    : !reading
      ? t("load.seedReady")
      : percent == null
        ? // 种子还没到 = 骨架屏态（A1~A3）：说的是「在恢复上次启用的」而不是「在读你的字体」，
          // 因为此刻列表里一个字体都还没有，说「读取」会让人以为马上就能看到东西了
          seedReady
          ? t("load.finding")
          : t("load.restoringSeed")
        : seeded
          ? t("load.backgroundReading", { done, total })
          : t("load.reading", { done, total, percent });

  return (
    <div
      className={`load-progress ${compact ? "load-progress-compact" : ""}`}
      role="status"
      aria-live="polite"
      /* 用户 2026-10-31 问「这里为什么是 5000 多」：分母是**字体文件数**（含系统目录与链接字体），
         和侧栏按字族统计的数字不是一回事，悬停解释一句 */
      data-hint="hint.loadProgress"
    >
      <div className="load-track" aria-hidden="true">
        {percent == null ? (
          reading ? (
            <div className="load-fill load-fill-indeterminate" />
          ) : (
            // 读完 / 降级：细线停在满格，不再滑动，让人知道「这一趟结束了」
            <div className="load-fill" style={{ width: "100%" }} />
          )
        ) : (
          <div className="load-fill" style={{ width: `${percent}%` }} />
        )}
      </div>
      <span className="load-text tabular">{text}</span>
      {degraded && (
        <button
          className="load-retry"
          onClick={() => void useFontStore.getState().rescan()}
        >
          {t("load.retry")}
        </button>
      )}
    </div>
  );
}
