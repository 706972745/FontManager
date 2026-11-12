import { useEffect, useState } from "react";
import { useFontStore } from "../state/fontStore";

/**
 * 跳转高亮亮多久（毫秒）。1.5~1.8s 之间取值：够用户看清「跳到了哪一行」，
 * 又不会让高亮赖在那儿跟「选中」抢注意力。
 */
export const REVEAL_MS = 1700;

/** 一次跳转：目标字族 + 它的序号（同名重复点击时 name 不变、tick 会变） */
export interface RevealJump {
  name: string;
  tick: number;
}

/**
 * 「哪一次跳转已经被当前视图消费过了」。
 *
 * 放模块级（而不是 store 里）是有原因的：三个视图是**互斥挂载**的，用户跳转完再切
 * 到另一个视图时，那个视图是新挂载的 —— 如果只看 store 里的 `revealFamily`，
 * 它会把几分钟前那次跳转当成刚发生，重新滚一次、再亮 1.7s。
 * 用这个游标把 tick 记账，切视图不会重播。
 */
let consumedTick = 0;

/**
 * 搜索建议跳转的落点：`revealed` 是当前该高亮的字族（到点自动变 null），
 * `jump` 是这次跳转本身（视图据此做一次居中滚动）。
 *
 * 为什么视图要订阅 `revealTick` 而不是比较 `selectedFamily`：重复点同一条建议时
 * `selectedFamily` 根本不变，用选中的副作用做触发，第二次点就永远不亮。
 *
 * 为什么高亮态放在组件里而不是 store 里：它是纯视觉的瞬时态，各视图各自持有、
 * 各自到点清掉即可；塞回 store 会多出「谁负责清」的同步问题。
 */
export function useRevealFamily(): { revealed: string | null; jump: RevealJump | null } {
  const target = useFontStore((s) => s.revealFamily);
  const tick = useFontStore((s) => s.revealTick);
  const [jump, setJump] = useState<RevealJump | null>(null);

  /**
   * ① 只在**真的发生新跳转**时把 jump 立起来。这个 effect 故意**不建定时器、不写 cleanup**。
   *
   * 为什么拆成两条 effect（2026-11-12 加固）：原来「认领 tick + 建定时器 + cleanup 清定时器」
   * 挤在同一条里，靠开头一句 `return` 提前退出。那个形状有个洞：`React.StrictMode` 在开发
   * 模式下会把 effect 跑两遍，第一遍建好定时器、cleanup 把它清掉，第二遍因为
   * `tick <= consumedTick` 提前 return —— 结果 jump 立着、再没有任何东西负责清它，
   * 高亮会**永久不消失**。今天不可达（认领 tick 的视图总是已经挂载着），但这类洞一旦将来
   * 「带未消费 tick 挂载」的路径出现就会咬人，且极难复现。
   * 拆开之后：认领这条没有 cleanup，StrictMode 第二遍即便提前 return，也只剩「jump 已立」，
   * 而清理由下面 ② 那条独立负责。
   */
  useEffect(() => {
    if (!target || tick <= consumedTick) return;
    consumedTick = tick;
    setJump({ name: target, tick });
  }, [target, tick]);

  /**
   * ② 到点收尾：1.7s 后清掉 jump（高亮消失、滚动不再重做）。
   * 依赖整个 `jump` 对象：新一次跳转换了对象 → 旧定时器被 cleanup 清掉、重新计时，
   * 所以「连点同一条建议」每次都能重新亮 1.7s。
   */
  useEffect(() => {
    if (!jump) return;
    const id = window.setTimeout(() => setJump(null), REVEAL_MS);
    return () => window.clearTimeout(id);
  }, [jump]);

  return { revealed: jump?.name ?? null, jump };
}
