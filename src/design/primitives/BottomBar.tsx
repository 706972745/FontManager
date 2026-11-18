import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";

/**
 * 贴底状态条（读取进度 / 应用进度 / 撤销条）的**统一**进出动画。
 *
 * 以前这两条（LoadProgress / ApplyProgress）都是「条件渲染 + return null」——
 * 出现和消失都是瞬间的：一条 1.88MB 的账本读完前它一直挂着，读完"啪"地没了；
 * 点撤销时整条底栏"啪"地弹出来。同一个位置、同一类信息，进出却毫无铺垫，
 * 和 Toast（有 spring）、HoverHint（有 0.14s 淡入）摆在一起就显得糙。
 *
 * 这里收成一条 0.18s 的「从下 8px 浮起 + 淡入」，退出原路返回：
 * - 0.18s 与 CSS 的 --t-quick 同档（对齐 audit P1-5「遮罩统一 0.18s」的口径）；
 * - 只动 transform / opacity，不触发布局；
 * - MotionConfig reducedMotion="always" 时 motion 会自动收掉位移，只留淡入淡出，
 *   不需要这里再写一遍减弱动效分支。
 *
 * ⚠️ 使用约束：调用方**不要**再 `if (!show) return null` —— 那会把整个
 * AnimatePresence 连同退出动画一起卸载，退出就成了瞬移。show=false 时
 * 让这个组件自己决定要不要渲染。
 */
export function BottomBar({
  show,
  className,
  hint,
  children,
}: {
  show: boolean;
  className?: string;
  /** 透传给 HoverHint 的 data-hint（LoadProgress 在用） */
  hint?: string;
  children: ReactNode;
}) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className={className}
          role="status"
          aria-live="polite"
          data-hint={hint}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
