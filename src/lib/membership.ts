import { useMemo } from "react";
import { useFontStore } from "../state/fontStore";
import type { FontFace } from "./ipc";
import { collectionBadgesFor, snapshotBadgesFor, type MemberBadge } from "./memberBadges";
import { faceKey } from "./snapshotKey";

export type { MemberBadge };

/**
 * 计算某个字族当前所属的快照与分组。
 *
 * 返回的是**胶囊数据**而不只是名字（用户 2026-10-31）：
 * 胶囊要写出「这个容器里放了这个字族的几个字重」，悬浮时还要列出是哪几个。
 * 所以除了名字，还要带上 `count` 与 `styles` —— 计算逻辑在 `lib/memberBadges.ts`（纯函数，有单测）。
 */
export function useFamilyMembership(
  family: string,
  faces: readonly FontFace[],
): { snapshotBadges: MemberBadge[]; collectionBadges: MemberBadge[] } {
  const snapshots = useFontStore((s) => s.snapshots);
  const collections = useFontStore((s) => s.collections);
  const collectionFaces = useFontStore((s) => s.collectionFaces);

  const snapshotBadges = useMemo(
    () => snapshotBadgesFor(family, snapshots),
    [family, snapshots],
  );
  const collectionBadges = useMemo(
    () => collectionBadgesFor(family, faces, collections, collectionFaces, faceKey),
    [family, faces, collections, collectionFaces],
  );

  return { snapshotBadges, collectionBadges };
}
