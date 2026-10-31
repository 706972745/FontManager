import { useEffect, useRef, useState } from "react";

/**
 * 元素当前是否在可见区域（含上下 `rootMargin` 的预取范围）。
 *
 * 字体库动辄上千个族，一进速览就给每个族都发起 `FontFace.load()` 会把主线程
 * 占住近一秒，窗口形变动画被拖出可见的停顿。这里让字体只在条目真正要露出来时才加载。
 *
 * 0.9.9-23 改了两处（内存实测后）：
 *
 * 1. **改成「进出都报」**。旧实现第一次相交后就 `io.disconnect()`、`inView` 永远停在 true ——
 *    速览列表没有虚拟化，滚过去的每张卡片都会把字体一直留着，滚一趟就是几百个字体、
 *    近 1 GB 常驻。现在离开就置 false，字体可以真正被淘汰。
 * 2. **所有卡片共用一个 IntersectionObserver**（按 rootMargin 分组）。一卡一个观察者
 *    在 4000+ 条目时本身就是负担；共享后观察 4000 个元素只有一个实例。
 */

type Watch = (visible: boolean) => void;

const pools = new Map<string, { io: IntersectionObserver; map: Map<Element, Watch> }>();

function poolFor(rootMargin: string) {
  let p = pools.get(rootMargin);
  if (!p) {
    const map = new Map<Element, Watch>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) map.get(entry.target)?.(entry.isIntersecting);
      },
      { rootMargin },
    );
    p = { io, map };
    pools.set(rootMargin, p);
  }
  return p;
}

export function useInView<T extends Element>(rootMargin = "240px") {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const p = poolFor(rootMargin);
    const watch: Watch = (visible) => setInView(visible);
    p.map.set(el, watch);
    p.io.observe(el);
    return () => {
      p.map.delete(el);
      p.io.unobserve(el);
    };
  }, [rootMargin]);

  return [ref, inView] as const;
}
