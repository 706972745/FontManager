/**
 * 收藏星标 + 评分（1.2.4）。
 *
 * 用户口径（2026-11-05 更新）：**直接点星标＝收下并给一星**；再点一次（已经有一星时）
 * 就取消收藏、顺手清掉评分。想给 2~5 星仍然是把鼠标停在星上、在浮层里点。
 * 这样「收藏」和「打分」不用分两步，一秒就能标完一批。
 *
 * 评分时若该族还没收藏，顺手收进来（评分本来就是「收藏的评级」，不该出现
 * 「有 5 星却不在收藏里」这种自相矛盾的状态）。
 *
 * 浮层用 portal 挂到 body：卡片、样张格、详情面板都有 overflow:hidden，
 * 就地绝对定位会被裁掉半截；fixed 定位又会被父级 transform 变成相对定位。
 *
 * 卡片 / 详情 / 样张三处共用这一个组件，行为不会慢慢跑偏。
 */
import { AnimatePresence, motion } from "motion/react";
import { Star, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFontStore } from "../state/fontStore";
import { playStar } from "../lib/sound";
import { useT } from "../lib/i18n";
import { springSnappy } from "../design/springs";

const OPEN_DELAY = 110;
const CLOSE_DELAY = 220;
const POP_WIDTH = 168;

export function StarRating({
  family,
  iconSize = 14,
  labels,
}: {
  family: string;
  iconSize?: number;
  /** 收藏 / 取消收藏的无障碍文案（卡片和详情面板用的是不同的 i18n 键） */
  labels: { add: string; remove: string };
}) {
  const t = useT();
  const favorite = useFontStore((s) => s.favorites.includes(family));
  const rating = useFontStore((s) => s.ratings[family] ?? 0);
  const setRating = useFontStore((s) => s.setRating);
  const toggleFavorite = useFontStore((s) => s.toggleFavorite);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(0);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(
    () => () => {
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
    },
    [],
  );

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    // 贴着星标左下沿展开；靠近窗口右缘时往回收，别让最后一颗星跑到窗口外
    const left = Math.max(8, Math.min(r.left - 6, window.innerWidth - POP_WIDTH - 8));
    const top = Math.min(r.bottom + 7, window.innerHeight - 80);
    setPos({ left, top });
  };

  const show = (delay: number) => {
    clearTimeout(closeTimer.current);
    clearTimeout(openTimer.current);
    const reveal = () => {
      place();
      setOpen(true);
    };
    if (delay === 0) reveal();
    else openTimer.current = setTimeout(reveal, delay);
  };

  const hide = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setOpen(false);
      setHover(0);
    }, CLOSE_DELAY);
  };

  const closeNow = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
    setOpen(false);
    setHover(0);
  };

  const rate = (stars: number) => {
    if (!favorite) {
      playStar(true);
      void toggleFavorite(family);
    }
    setRating(family, stars);
    closeNow();
  };

  return (
    <>
      <div
        ref={wrapRef}
        className="star-wrap"
        onMouseEnter={() => show(OPEN_DELAY)}
        onMouseLeave={hide}
        onFocusCapture={() => show(0)}
        onBlurCapture={(e) => {
          const next = e.relatedTarget as Node | null;
          if (!wrapRef.current?.contains(next) && !popRef.current?.contains(next)) closeNow();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.stopPropagation();
            closeNow();
          }
        }}
      >
        <motion.button
          ref={btnRef}
          className={`star-btn ${favorite ? "star-on" : ""}`}
          aria-label={favorite && rating > 0 ? labels.remove : labels.add}
          aria-pressed={favorite}
          aria-haspopup="true"
          aria-expanded={open}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            // 已收藏且已有评分 → 这一次点击是「取消」；否则就是「收下并给一星」
            const undo = favorite && rating > 0;
            playStar(!undo);
            void toggleFavorite(family);
            setRating(family, undo ? 0 : 1);
          }}
          whileTap={{ scale: 0.85 }}
        >
          <Star size={iconSize} strokeWidth={1.5} />
          {rating > 0 && (
            <span className="star-rating-badge" aria-label={t("card.rated", { count: rating })}>
              {rating}
            </span>
          )}
        </motion.button>
      </div>

      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={popRef}
              className="rating-pop"
              style={{ left: pos.left, top: pos.top }}
              role="group"
              aria-label={t("card.rating")}
              initial={{ opacity: 0, y: -5, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -3, scale: 0.97, transition: { duration: 0.12 } }}
              transition={springSnappy}
              onMouseEnter={() => show(0)}
              onMouseLeave={hide}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="rating-pop-stars" onMouseLeave={() => setHover(0)}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    className={`rating-star ${n <= (hover || rating) ? "rating-star-on" : ""}`}
                    aria-label={t("card.ratingStar", { count: n, name: family })}
                    onMouseEnter={() => setHover(n)}
                    onFocus={() => setHover(n)}
                    onClick={(e) => {
                      e.stopPropagation();
                      rate(n);
                    }}
                  >
                    <Star size={16} strokeWidth={1.5} />
                  </button>
                ))}
              </div>
              <div className="rating-pop-foot">
                <span className="rating-pop-value">
                  {hover > 0
                    ? t("card.rated", { count: hover })
                    : rating > 0
                      ? t("card.rated", { count: rating })
                      : t("card.ratingHint")}
                </span>
                {rating > 0 && (
                  <button
                    className="rating-pop-clear"
                    aria-label={t("card.ratingClear")}
                    onClick={(e) => {
                      e.stopPropagation();
                      setRating(family, 0);
                      closeNow();
                    }}
                  >
                    <X size={10} strokeWidth={1.75} />
                    {t("card.ratingClear")}
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
