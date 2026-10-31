import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Columns2,
  Copy,
  Minus,
  Plus,
  Download,
  FileText,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Power,
  Star,
  Timer,
  Trash2,
} from "lucide-react";
import type { MenuItem } from "../design/primitives/ContextMenu";
import { toast } from "../design/primitives/Toast";
import { AppBadge } from "../components/AppBadge";
import { allTags, familiesFor, useFontStore, type Family } from "../state/fontStore";
import { entryFromFace, faceKey } from "./snapshotKey";
import { AVAILABLE_ADOBE_APPS, ipc, type FontFace } from "./ipc";
import { exportSpecimen } from "./specimen";
import { activeLocale, t } from "./i18n";
import { extraFamilyNames, languageLabel, shortName } from "./fontNames";

export async function exportFamily(family: Family) {
  const dir = await open({
    directory: true,
    title: t("menu.exportFamilyTitle", { name: family.name }),
  });
  if (!dir) return;
  const paths = [...new Set(family.faces.map((f) => f.path))];
  try {
    const n = await ipc.exportFonts(paths, dir);
    toast.success(
      t("toast.exported", { name: family.name }),
      t("toast.filesCopied", { count: n, dir }),
    );
  } catch (e) {
    toast.error(t("toast.exportFailed"), String(e));
  }
}

export async function exportFace(path: string, suggestedName: string) {
  const dest = await save({
    defaultPath: suggestedName,
    title: t("menu.exportFontFile"),
  });
  if (!dest) return;
  try {
    await ipc.exportFont(path, dest);
    toast.success(t("toast.fontExported"), dest);
  } catch (e) {
    toast.error(t("toast.exportFailed"), String(e));
  }
}

export function copyText(text: string, what: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success(t("toast.copied", { what }), undefined, "tick"))
    .catch((e) => toast.error(t("toast.couldntCopy"), String(e)));
}

async function exportFamilies(families: Family[]) {
  const dir = await open({
    directory: true,
    title: t("menu.exportFamiliesTitle", { count: families.length }),
  });
  if (!dir) return;
  const paths = [...new Set(families.flatMap((f) => f.faces.map((x) => x.path)))];
  try {
    const n = await ipc.exportFonts(paths, dir);
    toast.success(
      t("toast.exportedFamilies", { count: families.length }),
      t("toast.filesCopied", { count: n, dir }),
    );
  } catch (e) {
    toast.error(t("toast.exportFailed"), String(e));
  }
}

export async function exportFontList(families: Family[], title: string) {
  const dest = await save({
    defaultPath: `${title.replace(/[^\w-]+/g, "-").toLowerCase()}-fonts.md`,
    title: t("menu.exportListTitle"),
  });
  if (!dest) return;
  const lines = [
    `# ${t("fontlist.title", { title })}`,
    "",
    t("fontlist.sub", { count: families.length }),
    "",
    ...families.flatMap((f) => [
      `## ${f.name}`,
      `- ${t("fontlist.styles")}: ${f.faces.map((x) => x.style).join(", ")}`,
      `- ${t("fontlist.format")}: ${f.formats.join(", ").toUpperCase()}${
        f.isVariable ? ` (${t("fontlist.variable")})` : ""
      }`,
      ...(f.foundry ? [`- ${t("fontlist.foundry")}: ${f.foundry}`] : []),
      "",
    ]),
  ];
  try {
    await ipc.writeTextFile(dest, lines.join("\n"));
    toast.success(t("toast.fontListExported"), dest);
  } catch (e) {
    toast.error(t("toast.exportFailed"), String(e));
  }
}

export function snapshotToggleAction(snapshot: string, families: string[]) {
  return () => {
    const s = useFontStore.getState();
    const snap = s.snapshots.find((sn) => sn.name === snapshot);
    if (!snap) return;
    const seen = new Set<string>();
    const faces = s.fonts
      .filter((f) => families.includes(f.family))
      .map(entryFromFace)
      .filter((e) => {
        if (seen.has(e.key)) return false;
        seen.add(e.key);
        return true;
      });
    if (faces.length === 0) return;
    const keys = faces.map((e) => e.key);
    const inKeys = new Set(snap.entries.map((e) => e.key));
    const allIn = keys.every((k) => inKeys.has(k));
    const entries = allIn
      ? snap.entries.filter((e) => !keys.includes(e.key))
      : [...snap.entries, ...faces.filter((e) => !inKeys.has(e.key))];
    useFontStore.setState({
      snapshots: useFontStore
        .getState()
        .snapshots.map((sn) => (sn.name === snapshot ? { ...sn, entries } : sn)),
    });
    void ipc.saveSnapshot({ ...snap, entries }).catch(() => {
      useFontStore.setState({ snapshots: s.snapshots });
    });
  };
}

function buildBulkMenu(names: string[]): MenuItem[] {
  const s = useFontStore.getState();
  const familyMap = familiesFor(s.fonts, s.tags);
  const families = names
    .map((n) => familyMap.get(n))
    .filter((f): f is Family => Boolean(f));
  const collectionNames = Object.keys(s.collections).sort((a, b) => a.localeCompare(b));
  const snapshotNames = s.snapshots.map((sn) => sn.name).sort((a, b) => a.localeCompare(b));
  const snapshotByName = new Map(s.snapshots.map((sn) => [sn.name, sn] as const));
  const n = names.length;
  const inCollection = s.nav.kind === "collection" ? s.nav.name : null;
  const inSnapshot = s.nav.kind === "snapshot" ? s.nav.name : null;

  return [
    { kind: "heading", label: t("menu.selectedCount", { count: n }) },
    {
      label: t("menu.compareCount", { count: Math.min(n, 4) }),
      icon: <Columns2 size={14} strokeWidth={1.5} />,
      disabled: n < 2,
      action: () => s.openCompare(names),
    },
    { kind: "separator" },
    {
      label: t("menu.activateCount", { count: n }),
      icon: <Power size={14} strokeWidth={1.5} />,
      action: () => void s.setFamiliesActiveBulk(names, true),
    },
    {
      label: t("menu.deactivateCount", { count: n }),
      icon: <Power size={14} strokeWidth={1.5} />,
      action: () => void s.setFamiliesActiveBulk(names, false),
    },
    { kind: "separator" },
    { kind: "heading", label: t("menu.addAllToCollection") },
    ...collectionNames.map(
      (name): MenuItem => ({
        kind: "check",
        label: name,
        checked: names.every((f) => (s.collections[name] ?? []).includes(f)),
        action: () => {
          const current = s.collections[name] ?? [];
          const all = names.every((f) => current.includes(f));
          const next = all
            ? current.filter((f) => !names.includes(f))
            : [...new Set([...current, ...names])];
          void ipc.setCollection(name, next).then(() =>
            useFontStore.setState({
              collections: { ...useFontStore.getState().collections, [name]: next },
            }),
          );
        },
      }),
    ),
    { kind: "separator" },
    { kind: "heading", label: t("menu.snapshots") },
    ...snapshotNames.map(
      (name): MenuItem => ({
        kind: "check",
        label: name,
        checked: (() => {
          const keys = s.fonts.filter((f) => names.includes(f.family)).map(faceKey);
          if (keys.length === 0) return false;
          const entryKeys = new Set(snapshotByName.get(name)?.entries.map((e) => e.key) ?? []);
          return keys.every((k) => entryKeys.has(k));
        })(),
        action: snapshotToggleAction(name, names),
      }),
    ),
    {
      label: t("menu.newSnapshot"),
      icon: <Plus size={14} strokeWidth={1.5} />,
      action: () => useFontStore.setState({ pendingSnapshotFor: names[0] }),
    },
    { kind: "separator" },
    { kind: "heading", label: t("menu.tagAll") },
    ...[...allTags(s.tags).keys()].map(
      (tag): MenuItem => ({
        kind: "check",
        label: tag,
        checked: names.every((f) => (s.tags[f] ?? []).includes(tag)),
        action: () => void s.applyTagToFamilies(tag, names),
      }),
    ),
    {
      label: t("menu.newTag"),
      icon: <Plus size={14} strokeWidth={1.5} />,
      action: () => s.setBulkTagFor(names),
    },
    { kind: "separator" },
    {
      label: t("menu.exportFamiliesCount", { count: n }),
      icon: <Download size={14} strokeWidth={1.5} />,
      action: () => void exportFamilies(families),
    },
    {
      label: t("menu.exportFontList"),
      icon: <FileText size={14} strokeWidth={1.5} />,
      action: () => void exportFontList(families, t("menu.selection")),
    },
    // 正在看分组/快照时，多选也要有「移出」这条（对应 Delete 的批量语义）
    ...(inCollection || inSnapshot
      ? ([
          { kind: "separator" },
          {
            label: t("menu.removeCountFromContainer", { count: n }),
            icon: <Minus size={14} strokeWidth={1.5} />,
            action: () => {
              if (inCollection) void s.removeFamiliesFromCollection(inCollection, names);
              else if (inSnapshot) void s.removeFamiliesFromSnapshot(inSnapshot, names);
            },
          },
        ] satisfies MenuItem[])
      : []),
    {
      label: t("menu.moveCountToTrash", { count: n }),
      icon: <Trash2 size={14} strokeWidth={1.5} />,
      danger: true,
      action: () => {
        for (const f of names) void s.uninstallFamily(f);
      },
    },
  ];
}

/**
 * 单个「字重」的操作菜单。
 *
 * 字族级菜单只能整族套用（用的还是 Regular 那一个 PostScript 名），
 * 想给选中的文字单独换 Bold / Light 就做不到。这里给每个字重一份自己的菜单：
 * 应用走 applyFaceInApp（带该字重的 PostScript 名），复制也分成「字体全名」和「PostScript 名」。
 */
/**
 * 这个字面能不能单独启停。
 *
 * 系统目录里的那份动不了（`deactivatable` 只对非 System 来源的字体为 true），
 * 但同 PostScript 名 / 同族同样式的库内副本可以动 —— 详情面板展示的常常是系统那份，
 * 用户点的却是「这个字重」，所以要往下找一层。字重行尾巴那颗眼睛按钮和右键菜单共用它，
 * 免得两处判断跑偏（一处能点、一处是灰的）。
 */
export function canToggleFace(face: FontFace): boolean {
  if (face.deactivatable) return true;
  const ps = (face.postscriptName ?? "").toLowerCase();
  return useFontStore
    .getState()
    .fonts.some(
      (f) =>
        f.deactivatable &&
        ((ps && (f.postscriptName ?? "").toLowerCase() === ps) ||
          (f.family === face.family && f.style === face.style)),
    );
}

export function buildFaceMenu(family: Family, face: FontFace): MenuItem[] {
  const s = useFontStore.getState();
  // 少数字体本身没写 family/style（或写成了空格），拼出来会是空串：
  // 这时退回 PostScript 名、再退回文件名，菜单至少有个能认的标题。
  const fullName =
    `${family.name} ${face.style}`.trim() ||
    face.postscriptName ||
    face.path.split(/[\\/]/).pop() ||
    "—";
  const items: MenuItem[] = [{ kind: "heading", label: fullName }];

  // 0.9.9-13：字重级操作。以前字重菜单只能「应用到 PS/AI/CDR」和复制名字，
  // 想单独停用一个字重、或只把这个字重存进快照，只能整族操作再手动收拾。
  const snapshots = s.snapshots;
  const key = faceKey(face);
  const toggleable = canToggleFace(face);

  items.push(
    {
      label: t(face.active ? "menu.deactivate" : "menu.activate"),
      icon: <Power size={14} strokeWidth={1.5} />,
      disabled: !toggleable,
      action: () => void s.setFaceActive(face.id, !face.active),
    },
    { kind: "separator" },
  );

  const collectionNames = Object.keys(s.collections).sort((a, b) => a.localeCompare(b));
  // 和字族菜单同一套：没有分组时也给「新建分组…」入口（速览里不给新建）
  if (collectionNames.length > 0 || !s.quickbar) {
    items.push({ kind: "heading", label: t("menu.collections") });
    for (const name of collectionNames) {
      const inFamily = (s.collections[name] ?? []).includes(face.family);
      const inFace = (s.collectionFaces[name] ?? []).includes(key);
      items.push({
        kind: "check",
        label: name,
        checked: inFamily || inFace,
        /**
         * 勾选状态有两个来源（整族在组里 / 这个字重单独在组里），点一下要撤掉**当前生效的那个**。
         * 0.9.9-13 一律走 toggleFaceInCollection，于是「整族在组里、字重没单独进」时点一下
         * 只是新增一条字重成员，勾选看上去点不掉（用户 2026-10-31 反馈）。
         */
        action: () => {
          if (inFamily && !inFace) void s.removeFamiliesFromCollection(name, [face.family]);
          else void s.toggleFaceInCollection(name, face.id);
        },
      });
    }
    if (!s.quickbar) {
      items.push({
        label: t("menu.newCollection"),
        icon: <FolderPlus size={14} strokeWidth={1.5} />,
        // 从字重进来的「新建分组」只放这个字重，不把整族拖进去
        action: () =>
          useFontStore.setState({ pendingCollectionFor: face.family, pendingCollectionFace: key }),
      });
    }
    items.push({ kind: "separator" });
  }

  // 和分组同一套：即使一个快照都没有，也给「新建快照…」入口（速览里不给新建）
  if (snapshots.length > 0 || !s.quickbar) {
    items.push({ kind: "heading", label: t("menu.snapshots") });
    for (const sn of [...snapshots].sort((a, b) => a.name.localeCompare(b.name))) {
      items.push({
        kind: "check",
        label: sn.name,
        checked: sn.entries.some((e) => e.key === key),
        action: () => void s.toggleFaceInSnapshot(sn.name, face.id),
      });
    }
    if (!s.quickbar) {
      items.push({
        label: t("menu.newSnapshot"),
        icon: <Plus size={14} strokeWidth={1.5} />,
        // 从字重进来的「新建快照」只放这个字重，不把整族拖进去
        action: () =>
          useFontStore.setState({ pendingSnapshotFor: face.family, pendingSnapshotFace: key }),
      });
    }
    items.push({ kind: "separator" });
  }

  if (s.adobeAvailable) {
    items.push(
      ...AVAILABLE_ADOBE_APPS.map(
        (app): MenuItem => ({
          label: t("menu.applyInApp", { app: t(`adobe.${app}`) }),
          icon: <AppBadge app={app} />,
          disabled: !face.postscriptName,
          action: () => void s.applyFaceInApp(family.name, face.id, app),
        }),
      ),
      { kind: "separator" },
    );
  }

  items.push(
    {
      label: t("menu.copyFaceName", { name: fullName }),
      icon: <Copy size={14} strokeWidth={1.5} />,
      action: () => copyText(fullName, t("copy.faceName")),
    },
    ...(face.postscriptName
      ? [
          {
            label: t("menu.copyPostScriptName", { name: face.postscriptName }),
            icon: <Copy size={14} strokeWidth={1.5} />,
            action: () => copyText(face.postscriptName!, t("copy.postScriptName")),
          } satisfies MenuItem,
        ]
      : []),
    {
      label: t("menu.copyFilePath"),
      icon: <Copy size={14} strokeWidth={1.5} />,
      action: () => copyText(face.path, t("copy.filePath")),
    },
    {
      label: t("menu.showInFileManager"),
      icon: <FolderOpen size={14} strokeWidth={1.5} />,
      action: () =>
        revealItemInDir(face.path).catch((e) =>
          toast.error(t("toast.couldntOpenFileManager"), String(e)),
        ),
    },
  );
  return items;
}

export function buildFamilyMenu(family: Family): MenuItem[] {
  const s = useFontStore.getState();
  if (s.selection.length > 1 && s.selection.includes(family.name)) {
    return buildBulkMenu(s.selection);
  }
  const lead = family.faces[0];
  const collectionNames = Object.keys(s.collections).sort((a, b) =>
    a.localeCompare(b),
  );
  const canUninstall = family.faces.some((f) => f.source !== "system");
  // 正看着某个分组/快照时，菜单里要有和 Delete 对应的「移出成员」入口，
  // 否则用户按 Delete 发现字体从列表消失，会以为操作失败了（0.9.9-1）。
  const inCollection = s.nav.kind === "collection" ? s.nav.name : null;
  const inSnapshot = s.nav.kind === "snapshot" ? s.nav.name : null;

  const favorite = s.favorites.includes(family.name);
  const items: MenuItem[] = [
    {
      label: t(family.active ? "menu.deactivate" : "menu.activate"),
      icon: <Power size={14} strokeWidth={1.5} />,
      disabled: !family.deactivatable,
      action: () => void s.setFamilyActive(family.name, !family.active),
    },
    ...(!family.active && family.deactivatable
      ? [
          {
            label: t("menu.activateUntilClose"),
            icon: <Timer size={14} strokeWidth={1.5} />,
            action: () => void useFontStore.getState().activateFamilySession(family.name),
          } satisfies MenuItem,
        ]
      : []),
    {
      label: t(favorite ? "menu.removeFromFavorites" : "menu.addToFavorites"),
      icon: <Star size={14} strokeWidth={1.5} />,
      action: () => void s.toggleFavorite(family.name),
    },
    ...(s.adobeAvailable
      ? [
          { kind: "separator" } satisfies MenuItem,
          ...AVAILABLE_ADOBE_APPS.map(
            (app): MenuItem => ({
              label: t("menu.applyInApp", { app: t(`adobe.${app}`) }),
              icon: <AppBadge app={app} />,
              action: () => void useFontStore.getState().applyFamilyInApp(family.name, app),
            }),
          ),
        ]
      : []),
    // 速览界面只做“加入/移出”，不提供新建分组、新建快照（新建走完整界面）
    ...(collectionNames.length > 0 || !s.quickbar
      ? ([
          { kind: "separator" },
          { kind: "heading", label: t("menu.collections") },
          ...collectionNames.map(
            (name): MenuItem => ({
              kind: "check",
              label: name,
              checked: (s.collections[name] ?? []).includes(family.name),
              action: () => void s.toggleFamilyInCollection(name, family.name),
            }),
          ),
          ...(s.quickbar
            ? []
            : [
                {
                  label: t("menu.newCollection"),
                  icon: <FolderPlus size={14} strokeWidth={1.5} />,
                  action: () => useFontStore.setState({ pendingCollectionFor: family.name }),
                } satisfies MenuItem,
              ]),
        ] satisfies MenuItem[])
      : []),
    ...(s.snapshots.length > 0 || !s.quickbar
      ? ([
          { kind: "separator" },
          { kind: "heading", label: t("menu.snapshots") },
          ...s.snapshots
            .map((sn) => sn.name)
            .sort((a, b) => a.localeCompare(b))
            .map(
              (name): MenuItem => ({
                kind: "check",
                label: name,
                checked: (() => {
                  const familyKeys = family.faces.map(faceKey);
                  if (familyKeys.length === 0) return false;
                  const entryKeys = new Set(
                    s.snapshots.find((sn) => sn.name === name)?.entries.map((e) => e.key) ?? [],
                  );
                  return familyKeys.every((k) => entryKeys.has(k));
                })(),
                action: snapshotToggleAction(name, [family.name]),
              }),
            ),
          ...(s.quickbar
            ? []
            : [
                {
                  label: t("menu.newSnapshot"),
                  icon: <Plus size={14} strokeWidth={1.5} />,
                  action: () => useFontStore.setState({ pendingSnapshotFor: family.name }),
                } satisfies MenuItem,
              ]),
        ] satisfies MenuItem[])
      : []),
    { kind: "separator" },
    {
      label: t("menu.exportFamily"),
      icon: <Download size={14} strokeWidth={1.5} />,
      action: () => void exportFamily(family),
    },
    {
      label: t("menu.exportSpecimen"),
      icon: <ImageIcon size={14} strokeWidth={1.5} />,
      action: () => void exportSpecimen(family, useFontStore.getState().sampleText),
    },
    {
      label: t("menu.copyFamilyName"),
      icon: <Copy size={14} strokeWidth={1.5} />,
      action: () => copyText(family.name, t("copy.familyName")),
    },
    // 其他语言的字体名：有才显示（英文名优先，其余按语言标签排）
    ...extraFamilyNames(family).map((entry): MenuItem => {
      const lang = languageLabel(entry.lang, activeLocale());
      return {
        label: entry.english
          ? t("menu.copyEnglishName", { name: shortName(entry.name) })
          : t("menu.copyOtherName", { lang, name: shortName(entry.name) }),
        icon: <Copy size={14} strokeWidth={1.5} />,
        action: () =>
          copyText(
            entry.name,
            entry.english ? t("copy.englishName") : t("copy.otherName", { lang }),
          ),
      };
    }),
    {
      label: t("menu.copyFilePath"),
      icon: <Copy size={14} strokeWidth={1.5} />,
      action: () => copyText(lead.path, t("copy.filePath")),
    },
    {
      label: t("menu.showInFileManager"),
      icon: <FolderOpen size={14} strokeWidth={1.5} />,
      action: () =>
        revealItemInDir(lead.path).catch((e) =>
          toast.error(t("toast.couldntOpenFileManager"), String(e)),
        ),
    },
  ];

  if (inCollection) {
    items.push(
      { kind: "separator" },
      {
        label: t("menu.removeFromCollection", { name: inCollection }),
        icon: <Minus size={14} strokeWidth={1.5} />,
        action: () => void s.removeFamiliesFromCollection(inCollection, [family.name]),
      },
    );
  }
  if (inSnapshot) {
    items.push(
      { kind: "separator" },
      {
        label: t("menu.removeFromSnapshot", { name: inSnapshot }),
        icon: <Minus size={14} strokeWidth={1.5} />,
        action: () => void s.removeFamiliesFromSnapshot(inSnapshot, [family.name]),
      },
    );
  }

  if (canUninstall) {
    items.push(
      { kind: "separator" },
      {
        // 在分组/快照里已经有一条「移出」了，这里说清楚这条是真删
        label:
          inCollection || inSnapshot ? t("menu.moveToTrashAnyway") : t("menu.moveToTrash"),
        icon: <Trash2 size={14} strokeWidth={1.5} />,
        danger: true,
        action: () => void s.uninstallFamily(family.name),
      },
    );
  }
  return items;
}
