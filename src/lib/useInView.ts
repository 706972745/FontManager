import { useEffect, useRef, useState } from "react";

/**
 * 元素是否滚动到了可见区域（含上下 `rootMargin` 的预取范围）。
 *
 * 字体库动辄上千个族，一进速览就给每个族都发起 `FontFace.load()` 会把主线程
 * 占住近一秒，窗口形变动画被拖出可见的停顿。这里让字体只在条目真正要露出来
 * 时才加载，首屏的几十个由调用方直接放行。
 */
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
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry?.isIntersecting) {
          setInView(true);
          // 已经加载过就不再观察，滚动到底部时观察者数量不会一直堆着
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin]);

  return [ref, inView] as const;
}
