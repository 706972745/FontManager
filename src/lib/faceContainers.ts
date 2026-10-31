import type { SnapshotEntry } from "./ipc";

/**
 * 单个字重行上「这个字重进了哪些快照 / 分组」的胶囊数据。
 *
 * 用户 2026-10-31：「在右边眼睛图标的左边加入快照和分组的图标和名字
 * （前提是对应的字重加入了快照或者分组）」，随后改成：
 * 「这里用快照图标1，快照图标2，快照图标3，分组图标1，分组图标2等等来显示就行，
 * 顺序从左到右」。
 *
 * 也就是字重行上**不写容器名，只写序号**——行太窄，`.苹方-繁` 那种长名字塞不下，
 * 而且一眼只需要知道「进了第几个容器」。真名留在悬浮气泡里。
 */
export interface FaceContainer {
  name: string;
  kind: "snap" | "coll";
  /** 这个容器在全局列表里的序号（从 1 开始），与侧栏顺序一致 */
  index: number;
}

/**
 * 预建索引：把快照条目 / 字重级分组成员 / 整族分组成员三份关系摊平成 Map，
 * 之后每个字重行只做 O(1) 查表。
 *
 * 为什么不给每个 FaceLine 各遍历一遍快照：展开一张卡就有十几个字重行，
 * 而快照里有几千条条目时，逐行遍历会明显掉帧（虚拟列表本来就在跟渲染赛跑）。
 */
export interface ContainerIndex {
  /** 字面 key → 快照名 */
  byKeySnap: Map<string, string[]>;
  /** 字面 key → 分组名（该字面被单独放进分组） */
  byKeyColl: Map<string, string[]>;
  /** 字族名 → 分组名（整族进组，组里所有字重都算） */
  byFamilyColl: Map<string, string[]>;
  /**
   * 容器名 → 序号。
   * **必须全局编号、且与侧栏同序**，否则同一个快照在 A 字重行是「1」、在 B 字重行是「2」，
   * 用户没法拿序号把两处对上。侧栏用的是 `name.localeCompare`，这里照抄。
   */
  snapNo: Map<string, number>;
  collNo: Map<string, number>;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  if (!key) return;
  const arr = map.get(key);
  if (!arr) map.set(key, [value]);
  else if (!arr.includes(value)) arr.push(value);
}

/**
 * 容器（快照 / 分组）的**唯一排序**。
 *
 * 侧栏按这个顺序列出来、序号也按这个顺序发，所以字重行上的「快照 2」
 * 一定就是侧栏里第 2 行那个。两处必须共用同一个函数 —— 各写一份 `localeCompare`
 * 迟早会因为细节（是否 trim、是否折叠大小写）走样，那时序号就对不上了。
 */
export function sortContainers(names: readonly string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function buildContainerIndex(
  snapshots: readonly { name: string; entries: readonly SnapshotEntry[] }[],
  collections: Readonly<Record<string, readonly string[]>>,
  collectionFaces: Readonly<Record<string, readonly string[]>>,
): ContainerIndex {
  const index: ContainerIndex = {
    byKeySnap: new Map(),
    byKeyColl: new Map(),
    byFamilyColl: new Map(),
    snapNo: new Map(),
    collNo: new Map(),
  };

  // 序号：先给所有容器编号（不只是命中的那些），保证「快照 3」在任何地方都是同一个。
  // 分组取 `collections` 与 `collectionFaces` 的并集 —— 正常情况下前者一定包含后者
  // （分组名就是 collections 的键），但两者万一不同步也不至于让序号掉成 0。
  sortContainers(snapshots.map((s) => s.name)).forEach((name, i) =>
    index.snapNo.set(name, i + 1),
  );
  const collNames = new Set<string>([
    ...Object.keys(collections),
    ...Object.keys(collectionFaces),
  ]);
  sortContainers([...collNames]).forEach((name, i) => index.collNo.set(name, i + 1));

  for (const sn of snapshots) {
    for (const e of sn.entries) push(index.byKeySnap, e.key ?? "", sn.name);
  }
  for (const [name, faces] of Object.entries(collectionFaces)) {
    for (const key of faces ?? []) push(index.byKeyColl, key, name);
  }
  for (const [name, whole] of Object.entries(collections)) {
    for (const family of whole ?? []) push(index.byFamilyColl, family, name);
  }
  return index;
}

/**
 * single-slot 缓存：所有 FaceLine 共用一份索引。
 *
 * 三个输入都是 store 里的引用稳定值（没改动就不会换新数组/新对象），
 * 所以引用没变时直接复用。这样即使屏幕上有几十个字重行同时挂载，也只建一次索引。
 */
let cacheKey: readonly unknown[] = [];
let cacheIndex: ContainerIndex | null = null;

export function buildContainerIndexCached(
  snapshots: readonly { name: string; entries: readonly SnapshotEntry[] }[],
  collections: Readonly<Record<string, readonly string[]>>,
  collectionFaces: Readonly<Record<string, readonly string[]>>,
): ContainerIndex {
  if (
    cacheIndex &&
    cacheKey[0] === snapshots &&
    cacheKey[1] === collections &&
    cacheKey[2] === collectionFaces
  ) {
    return cacheIndex;
  }
  cacheIndex = buildContainerIndex(snapshots, collections, collectionFaces);
  cacheKey = [snapshots, collections, collectionFaces];
  return cacheIndex;
}

/** 测试用：清掉 single-slot 缓存 */
export function resetContainerIndexCache(): void {
  cacheIndex = null;
  cacheKey = [];
}

/**
 * 某个字面所在的全部容器：**快照在前、分组在后**，各自按序号升序（用户要求「从左到右」）。
 *
 * 注意「整族进组」也算命中 —— 那个字重确实被包含在这个分组里，
 * 这与 `collectionScope` / `memberBadges` 里对整族成员的口径保持一致。
 */
export function containersFor(
  index: ContainerIndex,
  family: string,
  key: string,
): FaceContainer[] {
  const snaps = new Set(index.byKeySnap.get(key) ?? []);
  const colls = new Set<string>(index.byKeyColl.get(key) ?? []);
  for (const name of index.byFamilyColl.get(family) ?? []) colls.add(name);

  const out: FaceContainer[] = [];
  for (const name of snaps) {
    out.push({ name, kind: "snap", index: index.snapNo.get(name) ?? 0 });
  }
  for (const name of colls) {
    out.push({ name, kind: "coll", index: index.collNo.get(name) ?? 0 });
  }
  // 快照整段在前、分组整段在后；段内按序号升序。用 kind 做第一排序键而不是只看 index，
  // 否则「快照 3」会排到「分组 1」后面，和用户要的「先快照后分组」相反。
  return out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "snap" ? -1 : 1;
    return a.index - b.index;
  });
}
