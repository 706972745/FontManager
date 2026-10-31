/**
 * FontFace 常驻表的 LRU。
 *
 * 为什么需要它：`document.fonts` 本身没有容量概念 —— 一 `add` 就常驻，
 * 而一个字体文件动辄 1~20 MB。长时间滚动浏览不同字体（或反复展开字重、看速览、在线预览）
 * 会把渲染进程的内存慢慢吃满，WebView2 撑不住就会静默崩溃（表现为「用一会儿就闪退」）。
 *
 * 这里把「登记 / 挪到最近使用 / 按上限淘汰最旧的」抽成不依赖 DOM 的纯逻辑：
 * `collection` 只要求有 add / delete 两个方法 —— 生产环境传 `document.fonts`，
 * 单测传假对象。抽出来的直接原因是 0.9.9-13 的 P0：
 * 原来的实现只在 `tryLoad()` 里 `document.fonts.add(ff)`，从没把 ff 记进 `loadedFaces`，
 * 于是 `loadedFaces` 永远是空的，`while (size > MAX)` 那段是死代码，LRU 从未生效过。
 *
 * 0.9.9-23 起是**双上限**：条数 + 累计字节。
 * 只按条数的教训（0.9.9-22 实测）：库内 p90 = 4 MB、88 个字体超过 15 MB，
 * 200 个字面上限在中文区域能吃出 855 MB，理论最坏 1.5 GB。
 * 字节预算让「小字体多看、大字体少留」自动成立，不需要为字体库的构成调参数。
 */

export type FaceCollection<T> = {
  add(face: T): unknown;
  delete(face: T): unknown;
};

export type FaceLru<T> = {
  /** 当前常驻条数 */
  readonly size: number;
  /** 当前常驻条目声明的累计字节数（没给 bytes 的条目按 0 计） */
  readonly bytes: number;
  get(name: string): T | undefined;
  has(name: string): boolean;
  /**
   * 登记一个**加载成功**的字面：同名旧引用先从集合里摘掉，再把新的 add 进去并挪到 LRU 末尾，
   * 最后按上限淘汰最旧的。加载失败的字体不要调这个（它不该占用常驻名额）。
   *
   * `bytes` 是这个字面占用的字体文件体积，用于字节预算；不知道就传 0（只受条数上限约束）。
   */
  register(name: string, face: T, bytes?: number): void;
  /** 记一次「用到这个字体」：存在就挪到末尾；不存在什么也不做（由调用方重新加载） */
  touch(name: string): void;
  /** 当前表中的名字，按「最久没用 → 最近用过」排序（调试与单测用） */
  names(): string[];
};

export type FaceLruOptions<T> = {
  /** 常驻条数上限 */
  max: number;
  /**
   * 常驻累计字节上限。0 / 不传 = 只看条数。
   * 至少保留 1 条（否则单个字体大于预算时会登不进来，卡片永远拿不到字体）。
   */
  maxBytes?: number;
  /**
   * 这一条现在能不能淘汰。返回 false 表示「正在屏上渲染，别动它」。
   *
   * 为什么必须有：0.9.9-23 实测的**淘汰风暴** —— 字节预算一超，就淘汰最久没用的那条；
   * 但它可能正是屏幕最上面那张卡片。淘汰会清掉它的状态缓存 → 卡片立刻重新加载 →
   * 又超预算 → 再淘汰一条……单次滚动里加载次数从 77 涨到 235、淘汰 189 次，
   * 而每次重新加载 Chromium 都会再留一份字体数据（`document.fonts.delete()` 并不还内存），
   * 内存反而涨得更快。
   */
  canEvict?: (name: string, face: T) => boolean;
  /** 某个字体被淘汰时通知调用方（清理状态缓存、唤醒等待者重新加载） */
  onEvict?: (name: string, face: T) => void;
};

type Entry<T> = { face: T; bytes: number };

export function createFaceLru<T>(
  collection: FaceCollection<T>,
  opts: FaceLruOptions<T>,
): FaceLru<T> {
  const live = new Map<string, Entry<T>>();
  const { max, onEvict, canEvict } = opts;
  const limitBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : 0;
  let totalBytes = 0;

  const remove = (face: T) => {
    try {
      collection.delete(face);
    } catch {
      /* 已经不在集合里（重复删除 / 集合已失效） */
    }
  };

  const drop = (name: string) => {
    const entry = live.get(name);
    if (!entry) return;
    live.delete(name);
    totalBytes -= entry.bytes;
    remove(entry.face);
    onEvict?.(name, entry.face);
  };

  const overBudget = () =>
    live.size > max || (limitBytes > 0 && live.size > 1 && totalBytes > limitBytes);

  const evict = (protect?: string) => {
    while (overBudget()) {
      // 从最久没用的往后找第一条「没在屏上」的；全都在屏上就先不淘汰（宁可暂时超预算，
      // 也不能形成「淘汰 → 重新加载 → 再淘汰」的风暴）。
      // `protect` 是刚登记进来的那条：只淘汰它等于白加载一趟，所以它也不当候选。
      let victim: string | null = null;
      for (const name of live.keys()) {
        if (name === protect) continue;
        if (!canEvict || canEvict(name, live.get(name)!.face)) {
          victim = name;
          break;
        }
      }
      if (victim === null) return;
      drop(victim);
    }
  };

  return {
    get size() {
      return live.size;
    },
    get bytes() {
      return totalBytes;
    },
    get: (name) => live.get(name)?.face,
    has: (name) => live.has(name),
    register(name, face, bytes = 0) {
      const prev = live.get(name);
      if (prev) {
        if (prev.face === face) {
          // 同一个对象重复登记：只更新体积，不重复 add（否则同一个 FontFace 会挂两份）。
          // 没传 bytes 就沿用上次的值，别把已知体积抹成 0。
          if (bytes > 0 && bytes !== prev.bytes) {
            totalBytes += bytes - prev.bytes;
            prev.bytes = bytes;
          }
          live.delete(name);
          live.set(name, prev);
          evict(name);
          return;
        }
        // 同名重新加载（首次失败后走后端修复、或淘汰后重载）：
        // 旧 FontFace 必须先摘掉，否则同一个 family 名会同时挂两份，内存翻倍
        drop(name);
      }
      collection.add(face);
      const size = bytes > 0 ? bytes : 0;
      live.set(name, { face, bytes: size });
      totalBytes += size;
      evict(name);
    },
    touch(name) {
      const entry = live.get(name);
      if (!entry) return;
      live.delete(name);
      live.set(name, entry);
      evict();
    },
    names: () => [...live.keys()],
  };
}
