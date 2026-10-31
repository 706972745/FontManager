/**
 * FontFace 常驻表的 LRU。
 *
 * 为什么需要它：`document.fonts` 本身没有容量概念 —— 一 `add` 就常驻，
 * 而一个字体文件动辄 1~3 MB。长时间滚动浏览不同字体（或反复展开字重、看速览、在线预览）
 * 会把渲染进程的内存慢慢吃满，WebView2 撑不住就会静默崩溃（表现为「用一会儿就闪退」）。
 *
 * 这里把「登记 / 挪到最近使用 / 按上限淘汰最旧的」抽成不依赖 DOM 的纯逻辑：
 * `collection` 只要求有 add / delete 两个方法 —— 生产环境传 `document.fonts`，
 * 单测传假对象。抽出来的直接原因是 0.9.9-13 的 P0：
 * 原来的实现只在 `tryLoad()` 里 `document.fonts.add(ff)`，从没把 ff 记进 `loadedFaces`，
 * 于是 `loadedFaces` 永远是空的，`while (size > MAX)` 那段是死代码，LRU 从未生效过。
 */

export type FaceCollection<T> = {
  add(face: T): unknown;
  delete(face: T): unknown;
};

export type FaceLru<T> = {
  /** 当前常驻条数 */
  readonly size: number;
  get(name: string): T | undefined;
  has(name: string): boolean;
  /**
   * 登记一个**加载成功**的字面：同名旧引用先从集合里摘掉，再把新的 add 进去并挪到 LRU 末尾，
   * 最后按上限淘汰最旧的。加载失败的字体不要调这个（它不该占用常驻名额）。
   */
  register(name: string, face: T): void;
  /** 记一次「用到这个字体」：存在就挪到末尾；不存在什么也不做（由调用方重新加载） */
  touch(name: string): void;
  /** 当前表中的名字，按「最久没用 → 最近用过」排序（调试与单测用） */
  names(): string[];
};

export type FaceLruOptions<T> = {
  /** 常驻上限 */
  max: number;
  /** 某个字体被淘汰时通知调用方（清理状态缓存、唤醒等待者重新加载） */
  onEvict?: (name: string, face: T) => void;
};

export function createFaceLru<T>(
  collection: FaceCollection<T>,
  opts: FaceLruOptions<T>,
): FaceLru<T> {
  const live = new Map<string, T>();
  const { max, onEvict } = opts;

  const remove = (face: T) => {
    try {
      collection.delete(face);
    } catch {
      /* 已经不在集合里（重复删除 / 集合已失效） */
    }
  };

  const evict = () => {
    while (live.size > max) {
      const it = live.entries().next();
      if (it.done) return;
      const [name, face] = it.value;
      live.delete(name);
      remove(face);
      onEvict?.(name, face);
    }
  };

  return {
    get size() {
      return live.size;
    },
    get: (name) => live.get(name),
    has: (name) => live.has(name),
    register(name, face) {
      const prev = live.get(name);
      if (prev && prev !== face) {
        // 同名重新加载（首次失败后走后端修复、或淘汰后重载）：
        // 旧 FontFace 必须先摘掉，否则同一个 family 名会同时挂两份，内存翻倍
        live.delete(name);
        remove(prev);
      }
      live.delete(name);
      collection.add(face);
      live.set(name, face);
      evict();
    },
    touch(name) {
      const face = live.get(name);
      if (!face) return;
      live.delete(name);
      live.set(name, face);
      evict();
    },
    names: () => [...live.keys()],
  };
}
