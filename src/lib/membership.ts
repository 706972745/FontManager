import { useFontStore } from "../state/fontStore";

/**
 * 计算某个字族当前所属的快照与分组名称列表。
 * 在卡片视图与列表视图中共用，用于显示归属徽标。
 */
export function useFamilyMembership(family: string) {
  const snapshots = useFontStore((s) => s.snapshots);
  const collections = useFontStore((s) => s.collections);

  const inSnapshots = snapshots
    .filter((sn) => sn.entries.some((e) => e.family === family))
    .map((sn) => sn.name);

  const inCollections: string[] = [];
  for (const [name, members] of Object.entries(collections)) {
    if (members.includes(family)) inCollections.push(name);
  }

  return { inSnapshots, inCollections };
}
