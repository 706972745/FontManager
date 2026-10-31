/**
 * 有上限的 Map：超过上限就丢最早写入的那条。
 *
 * 这类缓存的作用只是「省一次 IPC / 省一次解析」，本身没有任何业务价值，
 * 无界就会随浏览历史一直长（BUG-7 的 `charsetCache`、BUG-9 的汉字档位缓存都是这个形状）。
 * 上限不要求精确的 LRU：写入顺序近似使用顺序就够了，被误丢的代价只是再查一次。
 */
export function createBoundedMap<K, V>(max: number) {
  const map = new Map<K, V>();
  return {
    get size() {
      return map.size;
    },
    get: (key: K): V | undefined => map.get(key),
    has: (key: K): boolean => map.has(key),
    set(key: K, value: V): void {
      // 已存在的键先删再插，让它排到最新（否则热点键会一直被旧顺序顶掉）
      map.delete(key);
      map.set(key, value);
      while (map.size > max) {
        const oldest = map.keys().next();
        if (oldest.done) return;
        map.delete(oldest.value);
      }
    },
    delete: (key: K): boolean => map.delete(key),
    keys: (): K[] => [...map.keys()],
  };
}
