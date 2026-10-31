import { useCallback, useEffect, useRef } from "react";

/**
 * 弹层层级栈（§5 第 8 条）。
 *
 * 之前每个弹层各自在 window 的 capture 阶段抢 Escape：capture 监听按注册顺序执行，
 * 于是「先打开的下层」会比「后打开的上层」先吃到按键 —— 设置面板压着重复字体提示时，
 * 按 Esc 关掉的是设置面板，提示还杵在那儿。这里用压栈记一下打开顺序，
 * 只有栈顶那一层允许消费 Escape / Tab。
 */
const layers: symbol[] = [];

export function isTopLayer(id: symbol | null): boolean {
  if (!id) return false;
  return layers[layers.length - 1] === id;
}

/**
 * 登记为一个弹层。返回 `isTop()`：在 Escape / Tab 处理里先问它，
 * 不是栈顶就直接让路（不要 preventDefault、不要关自己）。
 */
export function useModalLayer(active: boolean) {
  const idRef = useRef<symbol | null>(null);

  useEffect(() => {
    if (!active) return;
    const id = Symbol("modal-layer");
    idRef.current = id;
    layers.push(id);
    return () => {
      const at = layers.lastIndexOf(id);
      if (at >= 0) layers.splice(at, 1);
    };
  }, [active]);

  return useCallback(() => isTopLayer(idRef.current), []);
}
