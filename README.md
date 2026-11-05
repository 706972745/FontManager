**English** | [简体中文](README.zh-CN.md)

---

<div align="center">

<img src="src-tauri/icons/128x128.png" alt="FontManager icon" width="110" />

# FontManager

**Your whole font library, one toggle away — and it never leaves your machine.**

Preview, organize, activate and install fonts from one clean, fast app.<br>
Thousands of families stay tidy on a single machine — with plugins, a local API<br>
and MCP when you want your tools to join in.

<br>

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-gray?style=flat-square)](LICENSE)
[![Version](https://img.shields.io/badge/Version-1.3.2-gray?style=flat-square)](../../releases)
[![Platform](https://img.shields.io/badge/Platform-Windows-gray?style=flat-square)](#-platform-notes)
[![Languages](https://img.shields.io/badge/Languages-9-gray?style=flat-square)](#-translations)
[![Built with Tauri](https://img.shields.io/badge/Built%20with-Tauri%20v2-gray?style=flat-square)](https://tauri.app)

<br>

**[⬇ Download latest](../../releases/latest)** ·
**[📝 Changelog](CHANGELOG.md)** ·
**[🐛 Issues](../../issues)** ·
**[🔌 Plugins](docs/PLUGINS.md)** ·
**[🤖 MCP](mcp/README.md)**

<br>

<img src="main.png" alt="FontManager — library view with live font previews, activation toggles and the detail panel" width="920" />

<sub>The library: every family rendered live, one toggle away from any app's font menu.</sub>

</div>

<br>

---

## 📖 Table of contents

- [Why FontManager?](#-why-fontmanager)
- [Feature guide (step by step)](#-feature-guide-step-by-step)
- [Plugins, local API & MCP](#-plugins-local-api--mcp)
- [Keyboard shortcuts](#️-keyboard-shortcuts)
- [Translations](#-translations)
- [Getting FontManager](#-getting-fontmanager)
- [Platform notes](#-platform-notes)
- [Privacy](#-privacy)
- [Building from source](#-building-from-source)
- [Credits](#-credits)
- [License](#-license)

---

## 💡 Why FontManager?

FontManager began life as [ZFontManager](https://github.com/TheHolyOneZ/ZFontManager) —
TheHolyOneZ's answer to the simple frustration that a proper font manager was missing on
Linux, and the good ones elsewhere cost money. **This project is that software, iterated:**
a customized line of builds that started from ZFontManager 0.8.0 and grew into its own
release track, with credit and gratitude to the original author in both directions.

What this fork adds on top of that foundation:

- **Automation, first-class.** An opt-in local HTTP API, an out-of-process plugin system
  with per-plugin permission tokens, and an MCP server — so agents and scripts can query
  fonts, toggle families and manage snapshots without touching the interface.
- **A Windows-first release track** — NSIS and MSI installers, font-library folders with
  their own identity, and interface refinements across all nine languages.

Everything that made the original good is still here: live previews everywhere,
one-click activation, and the iron rule that **your font files stay on your machine**.

> [!WARNING]
> **System fonts are protected.** Fonts your operating system needs to draw its own
> interface can't be deactivated or trashed from FontManager, so you can explore
> fearlessly. Their cards show a small **OS** lock badge instead of a toggle, with
> the reason on hover.

---

## 🎯 Feature guide (step by step)

> Every feature below is written as "follow the clicks". After this section you
> know what every button in the app does.

### 1. First launch: get fonts into the library

1. Drag a **font folder** or a **ZIP** straight onto the app window
   (or: Settings → library locations → "Add" and pick a folder)
2. The scan runs, and every card is then previewed in the font's **own letterforms**
3. Want a second library? Settings → library locations → "Add"; click a row to
   change its directory, and the "switch" button at the end of a row makes it the active one

> A ZIP mixing several families? It is **rejected as a whole** with a reason —
> by design, so your library never fills with junk in one drop.

### 2. Know the main window

![Main window: the library, live previews and the detail panel](main.png)

**Sidebar** (top to bottom):

| Item | What it shows |
|---|---|
| Browse → Library | all families (the number = family count) |
| Browse → Favorites | families you starred |
| Browse → Recent imports | what arrived last |
| Activated | toggles currently on |
| Activate-until-quit | temporary ones (restore themselves on exit) |
| Deactivated | toggles currently off |
| System fonts | Windows' own fonts (locked) |
| Collections | groups you build (+ to create) |
| Snapshots | saved activation sets (see §8) |
| Online / Trash / About / Shortcuts | downloads · removed fonts · about · key list |

**Toolbar**: search · preview-text box (type anything, the whole library previews
it) · size slider (8–96px, eight steps) · filter · sort · compare · refresh ·
**three view buttons (cards / list / specimen)**.

**A font card**: format badge (TTF / OTF / VAR = variable) · family name · live
preview line · **license badge** (free-commercial / personal / unknown…) ·
**★ favorite** · **toggle (activate/deactivate)**.

### 3. Activate / deactivate in three steps

1. Find the family (search or scroll)
2. Click the **toggle** on the card — it writes to the system immediately
3. Open any app's font menu — **it's already there**; switching off hides it
   from every app (the file stays safe in the library)

- Just need it temporarily? Right-click → **activate until quit**: everything
  restores itself when you exit
- Bulk: Ctrl/Shift-select cards → right-click → "Activate N" / "Deactivate N";
  an interrupted bulk run offers to **resume** on next start
- System fonts wear an OS lock badge — they render Windows itself, so nobody can
  disable or delete them

### 4. Three views: cards / list / specimen

The three icons at the toolbar's right edge:

- **Cards** (default): one card per family, live previews
- **List**: a compact table — family / styles / format / size / toggle — best for
  sweeping a big library
- **Specimen**: a waterfall of large samples for the whole library with its own
  size control — best for judging a typeface's character

### 5. The detail panel: everything about one family

![Detail panel: multi-size specimen and metadata](detail.png)

Click any card and the right panel opens:

- **Live multi-size specimen** (large "Aa" down to small text, all real glyph
  rendering); variable fonts get **axis sliders** (weight and friends)
- Metadata: style count · format · class · script · the **true charset numbers**
  (N characters · M hanzi — "does it have Chinese?" becomes a fact, not a guess)
- The **full copyright text** with its automatic verdict; name conflicts
  (several files claiming one identity) warn in red here
- Header: toggle · ★ · **export all**; drag the panel's left edge to resize,
  double-click to reset

### 6. Favorites & ratings

1. Click the **★** on a card: favorite the family and record **one star**
   (click again to clear)
2. For 2–5 stars, open the detail panel and pick a value on the rating control
3. The QuickBar's ★ works the same; the sidebar "Favorites" view filters instantly
4. Ratings are purely your own "daily / backup" markers — the app adds no limits

### 7. Organize: collections, tags, notes

- **Create a collection**: "+" next to Collections in the sidebar → name it →
  **drag cards in** (or right-click → Collections → add)
- **Tag**: multi-select cards → right-click → add tag; tags show on cards and in details
- **Notes**: write directly in the detail panel (e.g. "Client A brand fonts,
  licensed through 2027"); plugins can write notes for you too

### 8. Snapshots: photograph "which fonts are on"

1. "+" next to Snapshots in the sidebar → name it → the current activation set is saved
2. Toggle fonts freely afterwards; click a snapshot to **apply** (restore exactly) /
   **merge into current** / **switch**
3. **Export a snapshot**: right-click it → export → a `.S-FontManager` file —
   send it to a colleague and they **double-click to import**
4. Right-click also offers: clear all fonts inside / delete the snapshot

### 9. Installing new fonts: four ways

| How | What to do |
|---|---|
| Drag a ZIP | drop it on the window; it unpacks and imports |
| Double-click | double-click a `.S-FontManager / .P-FontManager / .L-FontManager` file — the app opens and imports it (file associations registered at install) |
| Online panel | sidebar "Online" → browse Google Fonts by category (serif / sans / handwriting / mono / icons…) and Nerd Fonts → preview → **add to library**; the license text sits next to the download button and license files come along |
| Local API / MCP | automated imports (next section) |

### 10. Export: every way out

| What you want | Where |
|---|---|
| A single face (.ttf/.otf file) | right-click the face → export font file |
| A family / many families | right-click → export family… / export N families… (pick a folder) |
| A font list (metadata only) | right-click → export font list… |
| A specimen image (PNG) | right-click → export specimen…; or the specimen view |
| **A snapshot** | right-click the snapshot → export (`.S-FontManager`, re-importable by double-click) |
| Curation data (tags/collections/favorites/notes/manual verdicts/expiry dates) | Settings → **export library data** (merge on another machine) |
| **Everything** (curation + all fonts) | Settings → tick "include font files" → export pack → a `.P-FontManager` pack (auto-split above 2 GiB; import any one volume) |

**Importing** is always: double-click the file, or drop it on the window.
Files are recognized by **content**, not extension.

### 11. Trash: regret is allowed

1. Right-click a family → move to trash (bulk works too) — uninstalled from the
   system but the files are kept
2. Sidebar "Trash" → **restore** (back exactly as it was) or **delete forever**
   (double confirmation)

### 12. Licenses & duplicates: no browser needed

- Every family gets an automatic **license verdict**: personal / paid /
  free-commercial / unknown, with an **evidence sentence** (which documents were read)
- Badges show on cards and in the QuickBar; the full text lives in the detail panel
- On import: folders that **already have** a license file are left alone; missing
  ones get an auto-generated license note; two contradictory licenses in one
  folder → verdict "unknown", for you to check
- Wrong verdict? **Override it manually** in the detail panel; it's remembered
- **Duplicates**: files claiming the same font identity are flagged and resolved
  from the detail panel

### 13. Apply fonts in Photoshop / Illustrator / CorelDRAW / Affinity

Right-click a family → "Apply in {app}…":

- **Photoshop / Illustrator** — driven over COM scripting, no menu hunting
- **CorelDRAW** — FontManager drives CorelDRAW's **COM object model directly**
  (Chinese fonts matched by localized names)
- **Affinity** — with auto-activation on, fonts missing from your open documents
  are activated from the library automatically

### 14. ⚡ The QuickBar: switch fonts in 1 second, anywhere

![QuickBar: the docked panel of activated fonts](quickbar.png)

1. Press <kbd>Alt</kbd>+<kbd>`</kbd> anywhere (hotkey configurable in settings) —
   the main window collapses into the **docked QuickBar**
2. It lists only **activated** fonts: click a name to copy, ★ to favorite,
   the toggle to switch off, "> 3" to expand a family's faces, right-click for
   the full menu
3. Top bar: activated count · search · preview text & size · a **pin** ·
   "full window" to morph back
4. Done? Drag it back to the top edge and it collapses to a hairline that
   expands as your mouse approaches — or press <kbd>Alt</kbd>+<kbd>`</kbd> again

### 15. Compare

1. Click "**Compare**" in the toolbar (or multi-select → right-click → compare N)
2. Pick 2–4 families
3. See the same text set side by side; remove and re-pick any time

### 16. Keyboard first: command palette & shortcuts

- <kbd>Ctrl</kbd>+<kbd>K</kbd>: the command palette — type to jump (views, toggles,
  compare, apply-in-app, snapshots…)
- <kbd>?</kbd>: the full shortcut list (search, toggles, snapshots, panels)

### 17. Look & language

In settings: light / dark theme · interface sounds on/off · **reduced motion**
(calmer animation, less transparency) · nine interface languages
(简体中文 · 繁體中文 · English · 日本語 · Deutsch · Español · Français ·
Português (Brasil) · Русский).

### 18. Go further: plugins / API / MCP

Want the app to **work by itself**? Next section.

---

## 🔌 Plugins, local API & MCP

FontManager opens its core to automation — **opt-in, local-only, permission-scoped:**

| Layer | What it does | Docs |
|---|---|---|
| **Local HTTP API** | `127.0.0.1`-only REST API: list/search fonts, activate/deactivate, snapshots, curation. Custom port, resettable token, every route permission-checked | — |
| **Plugins** | Separate processes that talk JSON over stdin/stdout plus a **restricted token** — a plugin crash can never take the app down. Plugins may ship their own interpreter (`interpreterPath`) or a self-contained `.exe` | [docs/PLUGINS.md](docs/PLUGINS.md) |
| **MCP server** | Wraps the local API as MCP tools so agents (WorkBuddy, Claude, Cursor…) can drive your library in conversation | [mcp/README.md](mcp/README.md) |

### 📥 Installing ready-made plugins

The official plugin collection lives in the **[FontManager-Plugin](https://github.com/706972745/FontManager-Plugin)**
repository — every plugin is a standalone folder that **ships its own runtime**,
so nothing needs to be installed on your machine:

1. Grab a plugin ZIP from the [plugin releases](https://github.com/706972745/FontManager-Plugin/releases/latest)
2. Unzip it (e.g. the `specimen-export` folder)
3. FontManager → **Settings → Plugins → "Open plugins folder"**, drop the folder in
4. Toggle the plugin on in **Settings → Plugins** (or hit "Rescan")
5. Right-click any family → **Plugins ›** to use it

### 🖥️ Using the local API

1. Turn on **Settings → Local API** — the address chip shows the actual base
   (e.g. `127.0.0.1:58202`); set a custom port in the field below it
2. The **token** is masked by default; click the eye to reveal, or reset it (old token dies instantly)
3. Send `Authorization: Bearer <token>` on every request
4. Try it (PowerShell):

```powershell
$cfg = Get-Content "$env:APPDATA\FontManager\api.json" | ConvertFrom-Json
curl.exe -H "Authorization: Bearer $($cfg.token)" $cfg.base/health
curl.exe -H "Authorization: Bearer $($cfg.token)" "$($cfg.base)/fonts?q=noto&limit=10"
curl.exe -X POST -H "Authorization: Bearer $($cfg.token)" -H "Content-Type: application/json" `
  -d '{"family":"Noto Sans SC"}' $cfg.base/fonts/activate
```

Handy endpoints: `GET /health` · `GET /fonts` & `GET /fonts/families` ·
`POST /fonts/activate` & `POST /fonts/deactivate` · `POST /fonts/scan` ·
`GET/POST /snapshots` & `POST /snapshots/{name}/apply` · `GET/PUT /curation*`
(notes, ratings, favorites, tags). Every route is permission-checked — a plugin's
restricted token gets a 403 the moment it steps outside its declared scope.

### 🤖 Hooking up MCP

1. Enable the local API (MCP runs on top of it)
2. Add an entry in your MCP client's config (use your own absolute path):

```json
{
  "mcpServers": {
    "fontmanager": {
      "command": "node",
      "args": ["C:\\path\\to\\mcp\\index.mjs"]
    }
  }
}
```

3. Done — the MCP server **reads `%APPDATA%\FontManager\api.json` automatically**
   for port and token, so resetting the token never breaks your config.
   WorkBuddy: connector manager → custom MCP → paste → "Trust"; Claude Desktop and
   Cursor work the same way.

Then just ask in conversation — "list my Noto fonts", "apply the work snapshot".
All 10 tools are documented in **[mcp/README.md](mcp/README.md)**.

Nothing here is enabled by default, and every layer dies the moment you switch
the local API off.

---

## ⌨️ Keyboard shortcuts

Press <kbd>?</kbd> in the app for the full, always-current list — search,
activation, snapshots, the command palette and the QuickBar are all covered.

---

## 🌍 Translations

Nine languages ship in the box: 简体中文 · 繁體中文 · English · 日本語 · Deutsch ·
Español · Français · Português (Brasil) · Русский.
Want to add one? **[docs/TRANSLATING.md](docs/TRANSLATING.md)** — no code required.

---

## 📥 Getting FontManager

Grab the latest installer from
**[Releases](../../releases/latest)**:

- `FontManager_x.y.z_x64-setup.exe` — NSIS, per-user, no admin rights needed
- `FontManager_x.y.z_x64_en-US.msi` — MSI, per-machine, into Program Files

Both are **unsigned** builds; SmartScreen may ask for confirmation. Verify the
SHA-256 in the release notes before running.

---

## 🪟 Platform notes

FontManager is built on Tauri v2 and inherits a cross-platform codebase, but
this fork **ships Windows binaries** (NSIS + MSI) and is tested on Windows.
System-font protection, activation and the trash all use Windows' own
mechanisms (registry + GDI) — never by modifying font files.

---

## 🔒 Privacy

Short version: **out of the box, nothing is sent anywhere.**

- ❌ No account, no sign-up, no telemetry, no crash reporting
- ❌ Nothing about your fonts, tags, collections or notes is ever uploaded —
  there is no feature that does this, switched on or off
- ✅ Everything lives in local files on your machine
- ✅ The only optional network feature is the **online font browser** (off by
  default), which contacts the Google Fonts catalogue and GitHub release
  assets — your IP and the fonts you download, to those hosts only, and
  nothing about your existing library

The local API listens on `127.0.0.1` only and stays disabled until you turn it on.

---

## 🛠 Building from source

```bash
pnpm install
npx vite build
npx tauri build --bundles nsis,msi
```

Rust (MSVC) 1.85+ and Node 20+ are required. Rust unit tests run with
`cargo test --lib`, interface tests with `npm test`.

---

## 🙏 Credits

FontManager is built by **IIEOzo**, iterated from
**[ZFontManager](https://github.com/TheHolyOneZ/ZFontManager) 0.8.0** by
**[TheHolyOneZ](https://github.com/TheHolyOneZ)** — none of this exists
without that foundation. Thank you.

<div align="center">

| | |
|---:|:---|
| 🧬 **Upstream project** | github.com/TheHolyOneZ/ZFontManager |
| 👤 **Original developer** | github.com/TheHolyOneZ |
| 🌐 **Original website** | zsync.eu |
| 🍴 **This fork's source** | github.com/706972745/FontManager |

</div>

Found either project useful? A ⭐ genuinely helps others discover it.

---

## 📄 License

FontManager is free software, released under the
**GNU General Public License v3.0** — same as upstream.

In human terms: you may use it, share it, and change it — and if you
distribute a changed version, it must stay just as free for the next person.

---

<div align="center">
<br>

<img src="src-tauri/icons/32x32.png" alt="" width="20" />

**FontManager** · your fonts, your machine, your rules

<sub>Iterated from ZFontManager by
<a href="https://github.com/TheHolyOneZ">TheHolyOneZ</a> · fork maintained by
<a href="https://github.com/706972745">IIEOzo</a></sub>

</div>
