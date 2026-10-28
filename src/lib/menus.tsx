import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Columns2,
  Copy,
  Plus,
  Download,
  FileText,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  PenTool,
  Power,
  Star,
  Timer,
  Trash2,
} from "lucide-react";
import type { MenuItem } from "../design/primitives/ContextMenu";
import { toast } from "../design/primitives/Toast";
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

function snapshotToggleAction(snapshot: string, families: string[]) {
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

  if (s.adobeAvailable) {
    items.push(
      ...AVAILABLE_ADOBE_APPS.map(
        (app): MenuItem => ({
          label: t("menu.applyInApp", { app: t(`adobe.${app}`) }),
          icon: <PenTool size={14} strokeWidth={1.5} />,
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
              icon: <PenTool size={14} strokeWidth={1.5} />,
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

  if (canUninstall) {
    items.push(
      { kind: "separator" },
      {
        label: t("menu.moveToTrash"),
        icon: <Trash2 size={14} strokeWidth={1.5} />,
        danger: true,
        action: () => void s.uninstallFamily(family.name),
      },
    );
  }
  return items;
}
