<a name="english"></a>

**English** | [简体中文](#简体中文)

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
[![Version](https://img.shields.io/badge/Version-2.2.4-gray?style=flat-square)](../../releases)
[![Platform](https://img.shields.io/badge/Platform-Windows-gray?style=flat-square)](#-platform-notes)
[![Languages](https://img.shields.io/badge/Languages-9-gray?style=flat-square)](#-translations)
[![Built with Tauri](https://img.shields.io/badge/Built%20with-Tauri%20v2-gray?style=flat-square)](https://tauri.app)

<br>

**[⬇ Download latest](../../releases/latest)** ·
**[📝 Changelog](CHANGELOG.md)** ·
**[🐛 Issues](../../issues)** ·
**[🔌 Plugins](docs/PLUGINS.md)** ·
**[🎨 UI Spec](docs/UI设计交付规格书.md)** ([HTML](docs/UI设计交付规格书.html)) ·
**[🧩 Icons](docs/图标规范.md)** ·
**[🤖 MCP](mcp/README.md)**

<br>

<img src="main.png?v=2.2.2" alt="FontManager — sidebar, toolbar, font cards with live previews" width="920" />

<sub>The library: every family rendered live, one toggle away from any app's font menu.</sub>

</div>

<br>

---

## 🆕 What's new

**2.2.2 — One caret everywhere; the panel now explains what upload / GitHub sign-in is for**

- **The main window and the Plugin Center panel share one blinking blue block caret.** Its height
  is no longer the whole input box: it is now **font size + 2 px, vertically centred** (13 px text →
  15 px block). Width is still the character advance plus 4 px on each side, with a 3 px radius.
  Both entry points use the same component and stylesheet, so a change lands in both at once.
  IME composition still falls back to the native caret so pinyin tracks correctly. Password fields,
  textareas and checkboxes stay native — the measurement mirror would put plain text into the DOM.
- **The panel spells out what uploading and signing in are for:** uploading a plugin only stores it
  in a shared repository for sharing and safekeeping; signing in to GitHub is only so you can manage
  the plugins you uploaded (iterate or take them down) — **there is no other use for it**. The line is
  always visible at the bottom of the panel and shown again where you paste the token.
- **README rewritten against measured behaviour**: the local API table now covers all 20 routes, the
  permission table all 10 scopes, plus a "run these five gates" section. All UI screenshots and the
  Plugin Center screenshot were retaken for 2.2.2.

**2.2.1 — The panel updates itself; interpreter updates are only announced**

- **The Plugin Center panel auto-updates**: one check after launch, at most once every 24 hours; a newer panel is installed in the background and you get a one-line notice. **Nothing is checked or downloaded while the panel isn't installed** (that's your call), and you can switch it off in Settings → Plugins.
- **Interpreter updates are announced, not applied**: the Settings → Runtimes row shows the newest version when one exists — uninstall and download again to move up. **Nothing is replaced automatically**, because swapping Python / Node pulls plugin dependencies (Pillow / fontTools ABI) with it.
- The panel is now fully decoupled from the app: it ships and updates on its own schedule.

**2.2.0 — Plugin Center: browse, install, and upload from inside the app**

- **The panel is downloaded on demand**: the installer no longer ships the workshop UI. **Settings → Plugins → "Download Plugin Center panel"** pulls the panel bundle from GitHub (verified by `sha256`); once installed, a puzzle icon appears in the title bar and opens a separate window that follows the app's theme and language, and closes when you click away.
- **You can upload plugins from the panel**: a four-step dialog (connect GitHub → pick folders → review manifests → submit). You can pick **several plugin folders at once** and they share one commit and one pull request; the validation rules match the repository's CI line by line.
- **Plugins that touch your font library warn you first**: anything requesting write / import permissions gets a red badge on its card and a full warning at the top of its detail view — it can delete fonts, add files to the library, modify font files or restructure library folders.
- **The review policy is stated in the UI**: community plugins are listed after an automated AI rule check that **never modifies plugin contents** — the banner says so, permanently.
- **Faster to open**: fetching the index now has a 12 s timeout plus one retry, backed by a three-level cache (memory → local data folder → network).
- **Title bar actions reordered and evenly spaced**: settings → QuickBar → import folder → rescan → plugin center, right to left, with a constant 36 px between icon centres.

**2.1.7 — Automatic tags, so imported fonts are filterable from day one**

- **Filter by style without tagging by hand**: CJK families get Song / Hei / Kai / Li / Wei-Bei / running script / rounded / FangSong / decorative; Latin families get Vox subclasses. On top: decorative treatments (outline, shadow, pixel, inline…), form (heavy, high-contrast, condensed) and technical traits (weight axis, small caps, tabular figures).
- **Evidence, not vibes**: every automatic tag shows why it fired (family name? PANOSE? OS/2 class?).
- **Never written into your tags**: your own tags always win, and any automatic tag you delete or reject is remembered per family — across restarts, library switches and re-installs of the same font.
- **Deleting a font no longer deletes its tags**: tags are keyed by family name, so re-importing the same font from a colleague brings your tags back.
- **A single switch in Settings**, on by default; turning it off leaves only your own tags, no rescan needed.

**2.1.6 — A splash twice the size, and an installer that draws its own UI**

- **Splash redrawn at 2×**: 1120 × 760, with the icon, title, progress bar and status lines all scaled to match. It stays up for at least 1.5 s on every launch, even on a hot start where fonts are ready in milliseconds; the splash closes first, then the main window appears. In dark mode the glow behind the icon is now pale blue instead of deep royal.
- **Installer and uninstaller draw their own UI**: same fonts, same light/dark theme and same wording as the app — no more system-grey NSIS controls. A silent install (`/S`) stays genuinely silent, and the art panel on the right is toned down so it no longer pulls your eyes off the text.
- **It asks before it bites**: if FontManager is still running when you start an install or uninstall, a dialog lets you pick "close it and continue" or "cancel". No more "file in use" or "uninstalled but still there".
- **The progress screen no longer plays dead**: the elapsed counter actually counts, the bar breathes, and a reinstall no longer pretends to jump to 88% and then sit there for forty seconds.
- **Settings typography fixed**: the "Settings" title is now the largest thing on screen, section headings clearly outrank row labels, and size + weight carry the hierarchy.
- **Cleaner uninstall**: leftover icon files and empty `plugins` / font-library shells are removed; "delete my data too" stays a separate, explicit choice.
- **Fully decoupled from ZFontManager**: its old folders and wording are no longer cleaned up or mentioned.

**2.1.5 — Your data follows the install folder**

- **Everything lives under the install folder**: install to `D:\…` and tags / collections / favorites / the activation ledger / snapshots / caches / logs / online downloads all go to `D:\…\data` — C: stops growing new app data. Upgrading an older version migrates it for you and keeps the old folder as a fallback.
- **Redesigned installer**: the NSIS blue sidebar is gone, the welcome page is hand-drawn (big title, thin rule, generous whitespace), bilingual and follows the system language. The upgrade page now defaults to "overwrite install (recommended)" instead of uninstalling first.
- **Usable on first frame** (2.1.4): on launch the app first loads the fonts you had enabled, plus system fonts, group members and snapshot members — usable immediately — then reads the rest in the background and refreshes only once.

See the full [changelog](CHANGELOG.md).

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

FontManager started from **ZFontManager 0.8.0** and has since grown into a project
of its own: its own code, its own release track, its own plugin platform. Beyond that
starting point it has no shared roadmap, maintenance, or upstream.

What FontManager adds:

- **Automation, first-class.** An opt-in local HTTP API, an out-of-process plugin system
  with per-plugin permission tokens, and an MCP server — so agents and scripts can query
  fonts, toggle families and manage snapshots without touching the interface.
- **A Windows-first release track** — NSIS and MSI installers, up to 3 library
  folders with one-click switching (each badged with its own folder icon), and
  interface refinements across all nine languages.

Everything that made the original good is still here: live previews everywhere,
one-click activation, and the iron rule that **your font files stay on your machine**.

> [!NOTE]
> **Where this project spends its effort.** The app itself aims for *enough, comfortable,
> fast* — no feature bloat: startup, scrolling, search and activation get polished first.
> The **plugin ecosystem, local API and MCP** are where new features, new experiences and
> deeper extensibility live, so the core can stay small and stable while the edges grow.

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
   (or click **import a folder** in the title bar — the fonts are copied into the
   library and the original folder is left exactly as it was; or: Settings →
   Library folders → "Add folder…" and pick a folder)
2. The scan runs, and every card is then previewed in the font's **own letterforms**
3. Want a second library? Settings → Library folders → "Add folder…"; click a row to
   change its directory, and the "switch" button at the end of a row makes it the
   active one (see [section 17](#17-multiple-libraries-up-to-3-folders-one-click-switching))

> A ZIP mixing several families? It is **rejected as a whole** with a reason —
> by design, so your library never fills with junk in one drop.

### 2. Know the main window

![Main window: sidebar, toolbar, font cards with live previews](main.png?v=2.2.2)

**Find your way first: the window has five regions**

| Region | Where | What you can do there |
|---|---|---|
| **Title bar** | the thin strip on top | drag the window · minimize / maximize / close · **Settings** · **send it to the QuickBar** (<kbd>Alt</kbd>+<kbd>`</kbd>) · **import a folder** · **rescan the library** |
| **Sidebar** | the left column | switch views: Library / Favorites / Recent imports / Activated / Activate-until-quit / Deactivated / System fonts / Collections / Snapshots; at the bottom: Online · Trash · About · Shortcuts |
| **Toolbar** | above the content | search · preview text · size slider · filter · sort · compare · **three view switches** |
| **Content** | the middle | cards / list / specimen views; click a card to select, right-click for the full menu, drag into a collection |
| **Detail panel** | slides in from the right when a card is clicked | multi-size specimen · metadata · license · notes & tags · export · drag its left edge to resize |

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
it) · size slider (8–96px, eight steps) · filter · sort · compare ·
**three view buttons (cards / list / specimen)**.

> Two actions moved up to the **title bar** in 2.0: **import a folder** and
> **rescan**. They act on the whole library rather than on what you are looking
> at, so they now sit next to Settings instead of among the view controls.

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

![List view: the whole library in one table](view-list.png?v=2.2.2)

- **Specimen**: a **multi-column specimen wall** — every cell keeps the full card
  header (format / name / license / ★ / toggle) and spreads the sample text **large**
  underneath; pick a face per cell (remembered); its own size control — best for
  judging a typeface's character

![Specimen view: multi-column specimen wall with large sample text](view-specimen.png?v=2.2.2)

### 5. The detail panel: everything about one family

![Detail panel: multi-size specimen and metadata](detail.png?v=2.2.2)

Click any card and the right panel opens:

- **Live multi-size specimen** (large "Aa" down to small text, all real glyph
  rendering); variable fonts get **axis sliders** (weight and friends)
- Metadata: style count · format · class · script · the **true charset numbers**
  (N characters · M hanzi — "does it have Chinese?" becomes a fact, not a guess)
- The **full copyright text** with its automatic verdict; name conflicts
  (several files claiming one identity) warn in red here
- Header: toggle · ★ · **export all** — zips the family's **whole folder**, license
  files and readme included, so a colleague receives the terms along with the
  fonts (a font sitting at the library root exports just its own files); drag the
  panel's left edge to resize, double-click to reset

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
| Online panel | see below: filter by category / license, one-click add |
| Local API / MCP | automated imports (see [Plugins, local API & MCP](#-plugins-local-api--mcp)) |

![Online panel: category and license filters on the left, font cards with one-click add](online.png?v=2.2.2)

How to use it: sidebar "Online" → filter by **category** (sans / serif / display /
handwriting / mono / icons) and **license** (OFL / Apache / UFL), or just search;
cards show style · styles count · license (VAR badge = variable font); click a card
for details and **add to library** downloads it — the license text sits right next
to the download button and license files come along. Data: the Google Fonts
catalogue, 1,984 families.

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

Every FontManager-specific file carries a **sticker-paper icon** (torn edges +
a handwritten caption), easy to spot in Explorer: the app icon (a **TYPE
FontManager** wordmark) · snapshot export **.S** · pack-with-fonts **.P** ·
data-only export **.L** · library folder **.F**:

![FontManager icon set: sticker-paper final (white sheet + ink letter + handwritten caption)](icons-overview.png?v=2.2.2)

### 11. Trash: regret is allowed

1. Right-click a family → move to trash (bulk works too) — uninstalled from the
   system but the files are kept
2. Sidebar "Trash" → **restore** (back exactly as it was) or **delete forever**
   (double confirmation)

![Trash: removed fonts land here first — nothing disappears silently](trash.png?v=2.2.2)

### 12. Licenses & duplicates: no browser needed

- Every family gets an automatic **license verdict**: personal / paid /
  free-commercial / unknown, with an **evidence sentence** (which documents were read)
- Badges show on cards and in the QuickBar; the full text lives in the detail panel
- **No license file is ever generated.** Folders that already have a license file
  are simply read; when there is none, your folder is left untouched and
  FontManager falls back to the **copyright embedded in the font file itself**
  (shown as such in the detail panel); two contradictory licenses in one folder →
  verdict "unknown", for you to check
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

With the official **“Font Apply (PS / AI / CDR)”** plugin installed there are two
faster routes:

- **Double-click any copyable spot in the QuickBar** (a whole row or an expanded
  face row) — the font is applied to the design app you used last;
- Right-click the plugin row → “Double-click: pick a window” → after the
  double-click, click the target window (within 15s; the taskbar counts too).
  Switch between the two modes right from the plugin's context menu.

### 14. ⚡ The QuickBar: switch fonts in 1 second, anywhere

![QuickBar: the docked panel of activated fonts](quickbar.png?v=2.2.2)

1. Press <kbd>Alt</kbd>+<kbd>`</kbd> anywhere — the main window collapses into the
   **docked QuickBar** (change the hotkey under Settings → System → "QuickBar
   hotkey", see below)
2. It lists only **activated** fonts: click a name to copy, **double-click to apply
   it to your design app** (needs the “Font Apply” plugin), ★ to favorite,
   the toggle to switch off, "> 3" to expand a family's faces, right-click for
   the full menu (type right in that menu to search fonts — enabled by
   default, <kbd>Tab</kbd> for all; see section 16)
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

![Command palette](palette.png?v=2.2.2)

- **Type-to-search in any context menu**: with any right-click menu open
  (cards / list / specimens / QuickBar / detail panel), just **start typing** —
  a search box appears on top and filters the whole library live.
  <kbd>↑</kbd><kbd>↓</kbd> to pick, <kbd>Enter</kbd> or click to jump: the app
  switches to the right view and scrolls the family into view.
  <kbd>Esc</kbd> clears the query first, then closes the menu

![Type-to-search inside a context menu: a search box appears on top, results filter live, and the footer tells you more matches are available](contextmenu.png?v=2.2.2)

- **Tab toggles the search scope**: while searching, <kbd>Tab</kbd> (or the
  badge next to the box) switches between "enabled ↔ all fonts" — the QuickBar
  searches enabled fonts by default (picking one scrolls the QuickBar list;
  picking a disabled one returns to the full window and locates it), the full
  window searches all
- <kbd>?</kbd> (or the sidebar "Shortcuts" entry): the full shortcut list —
  navigation / selection / actions on selection / snapshots

![Shortcut list: open with ? or the sidebar "Shortcuts" entry — grouped into navigation / selection / actions](shortcuts.png?v=2.2.2)

### 17. Multiple libraries: up to 3 folders, one-click switching

![Settings → Library folders: the default library plus your own folders, switch inline](libraries.png?v=2.2.2)

Fonts scattered across folders? **Settings → Library folders**:

1. The default library is the "字体库" folder next to the install directory; flip on
   "**Use custom folders**" to add your own
2. "**Add folder…**" takes up to 3 library folders, each badged with FontManager's
   **dedicated folder icon** — easy to spot in Explorer
3. The "**Switch**" button at the end of a row makes that library current; the scan
  follows instantly. The folder button opens it in Explorer, the ✕ removes it
4. The library list travels with the app — export your data on one machine and it
  comes along

### 18. Look & language

![Settings: language / system / library — every toggle in one column](settings.png?v=2.2.2)

In settings: light / dark theme · interface sounds on/off · **reduced motion**
(calmer animation, less transparency) · nine interface languages
(简体中文 · 繁體中文 · English · 日本語 · Deutsch · Español · Français ·
Português (Brasil) · Русский).

### 19. Go further: plugins / API / MCP

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
repository. Two ways to install (1.4.4+):

- **Drag & drop**: drag a plugin ZIP anywhere onto the window — FontManager
  detects it by its `plugin.json` and installs it (regular font ZIPs keep
  importing as fonts; the two never get mixed up);
- **Button**: **Settings → Plugins → "Install from ZIP"**.

Or the manual way: unzip and drop the folder into the plugins folder
(**Settings → Plugins → "Open plugins folder"**), then toggle it on.

**Interpreters**: the installer ships **no interpreters** (since 1.4.11) —
what to download is entirely the user's call. In **Settings → Plugins** each
runtime shows what's on the machine (version, disk usage, which plugins use
it), a one-click **download** (Python 3.13 + Pillow + fontTools, ~19 MB; or
Node.js 22 LTS, ~32 MB — pulled from the official GitHub release with a live
progress bar), and a **delete** button to reclaim space when no plugin needs
it. Deleted runtimes can be re-downloaded anytime. Resolution order:
plugin-bundled interpreter (`interpreterPath`) → app-folder runtime → user
override → system interpreter. Plugins with heavy dependencies may still ship
their own `runtime/` — see [docs/PLUGINS.md](docs/PLUGINS.md) for the full
story, the plugin template
([template-hello](https://github.com/706972745/FontManager-Plugin/tree/main/template-hello))
for a 5-minute start, and troubleshooting.

Manual steps (any version):

1. Grab a plugin ZIP from the [plugin releases](https://github.com/706972745/FontManager-Plugin/releases/latest)
2. Unzip it (e.g. the `specimen-export` folder)
3. FontManager → **Settings → Plugins → "Open plugins folder"**, drop the folder in
4. Toggle the plugin on in **Settings → Plugins** (or hit "Rescan")
5. Right-click any family → **Plugins ›** to use it. The plugin's own row in
   **Settings → Plugins** is an entry point too: the **gear** at the end of the row
   opens the plugin's settings panel (when the plugin declares one), and
   **right-clicking the row** lists its no-family-needed actions (open export
   folder, change save location…)

### 🧩 Plugin Center: browse, install, upload

![Plugin Center panel: cards, search and filters; the footer explains what upload and GitHub sign-in are for](workshop.png?v=2.2.2)


Community plugins live in the **[FontManager-Workshop](https://github.com/706972745/FontManager-Workshop)**
repository and are browsed through the **Plugin Center** — a separate panel that is
**downloaded on demand** into **your data folder** (`<data root>\workshop-panel`) and opened by the app
over a loopback service. **The installer ships no entry point for it, and nothing is ever loaded from
the install folder:**

1. **Settings → Plugins → "Download Plugin Center panel"**: fetches the bundle from GitHub, verifies
   its `sha256`, installs it into your data folder (progress + retry, same as the runtime downloads above)
2. Once installed, a **puzzle icon appears at the far left of the title bar** (hover shows "Plugin Center");
   clicking it opens a separate window
3. Search, filter by official / community and by runtime, open a card for the full description,
   requested permissions and file list, then install or uninstall in one click — installed ones are marked

Behaviour worth knowing:

- **Browsing, downloading and installing need no GitHub account** — only uploading your own plugin does
- **What upload and sign-in are actually for**: uploading a plugin only puts it into a shared repository
  for storing and sharing. Signing in to GitHub is only so you can manage the plugins *you* uploaded —
  iterate on them later or take them down. **There is no other use for it.** The line stays at the
  bottom of the panel and appears again where you paste the token
- **The panel updates itself**: once installed, the app checks after launch (never more than once every 24 h)
  and installs a newer panel in the background with a one-line notice; **nothing at all happens while the panel
  isn't installed**, and you can turn the check off in Settings → Plugins. New panels no longer wait for an app release
- **Click anywhere else and it hides**: the panel dismisses itself on focus loss, and you reopen it from the
  title bar icon (dragging the window does *not* dismiss it)
- **Plugins that touch your font library are flagged**: anything requesting `write:fonts`
  (activate / deactivate / delete / move fonts) or `import` (add font files to the library) gets an
  "edits library" badge on its card and a full warning at the top of its detail view.
  **Uploading is unaffected** — the warning only appears downstream, before you install
- **Review policy**: community plugins are listed after an automated AI rule check that
  **never modifies plugin contents**; only install plugins you trust
- **Three-level index cache** (memory → local data folder → network), with a 12 s timeout and one retry,
  so a stalled connection can no longer spin forever

#### Uploading your own plugin (all inside the panel, no web detour)

**Upload plugin** in the panel's top-right corner opens a four-step dialog:

| Step | What happens |
|---|---|
| **① Connect GitHub** | Paste a fine-grained token once (only `Contents` + `Pull requests`, read & write). It is stored locally with **DPAPI** encryption — never uploaded — and remembered afterwards |
| **② Pick folders** | The app opens a native folder picker; you can select **several plugin folders at once** |
| **③ Review the manifest** | If the folder has a `plugin.json` it is pre-filled, otherwise fill it in. Rules match the repository CI exactly: id pattern, file-extension allowlist, 10 MB per file / 20 MB per plugin, permission allowlist, entry script must be inside the bundle |
| **④ Submit** | Automatically forks → syncs main → uploads each file → creates the commit → opens a pull request. **All selected plugins share one commit and one PR**, with a four-stage progress display |

The plugin only shows up in the center after the PR is merged and CI has regenerated `index.json`.

**Managing what you uploaded follows your GitHub account, not this computer**: once you're connected, the
dialog lists every plugin signed with your name (anonymous ones included) with a **Take down** button that
opens a "delete this folder" pull request. The anonymous signature is derived from your login
(`anonymous-<hash(login)>` — never stored locally, never random), so signing in on another machine or after
a reinstall still lets you update or take down your own plugins.

"Upload anonymously" is available to the **repository maintainer only**: CI requires the folder name to end
with `__<PR author>`, so anonymous submissions from anyone else would be rejected — that checkbox stays
disabled for them.

### 🖥️ Using the local API

1. Turn on **Settings → Local API** — the address chip shows the actual base
   (e.g. `127.0.0.1:58202`); set a custom port in the field below it
2. The **token** is masked by default; click the eye to reveal, or reset it (old token dies instantly)
3. Send `Authorization: Bearer <token>` on every request
4. Try it (PowerShell):

```powershell
# api.json 现在跟着「数据根」走。默认安装（NSIS，装在 %LOCALAPPDATA%\FontManager）
# 就是下面这个路径；装到别的目录时换成 <安装目录>\data\api.json。
$cfg = Get-Content "$env:LOCALAPPDATA\FontManager\data\api.json" | ConvertFrom-Json
curl.exe -H "Authorization: Bearer $($cfg.token)" $cfg.base/health
curl.exe -H "Authorization: Bearer $($cfg.token)" "$($cfg.base)/fonts?q=noto&limit=10"
curl.exe -X POST -H "Authorization: Bearer $($cfg.token)" -H "Content-Type: application/json" `
  -d '{"family":"Noto Sans SC"}' $cfg.base/fonts/activate
```

**20 routes / 21 handlers**, all permission-gated (full table in
[docs/PLUGINS.md](docs/PLUGINS.md)):

| Endpoint | Purpose |
|---|---|
| `GET /health` | Totals, this token's scopes, full scope catalogue |
| `GET /fonts` `GET /fonts/families` | List / search fonts (`q`, `limit`, `offset`, `family`, `license`) |
| `POST /fonts/activate` `POST /fonts/deactivate` | Enable / disable families (**library paths only**) |
| `POST /fonts/scan` `POST /fonts/apply` | Rescan (30 s throttle) / apply a font in PS·AI·CDR |
| `GET /apps/active` | Most recently used design app (for "auto" apply) |
| `GET/POST /snapshots` `DELETE /snapshots/{name}` `POST /snapshots/{name}/apply` | List / create / delete / apply snapshots |
| `GET /curation` `PUT /curation/{rating,favorite,tags,collection,note}` | Read / edit ratings, favorites, tags, collections, notes |
| `POST /export/pack` `GET /jobs/{id}` | Async pack export + progress |
| `POST /import` | Import a font pack (needs the dangerous-ops master switch **and** `import`) |

> Body limit is 16 MiB. `permissions` in `/health` is **this token's** scope list;
> `allPermissions` is the catalogue. The port rotates on every launch — read `api.json`
> at runtime instead of hard-coding it.

#### Permissions — where 403 comes from

Every route sits behind a **permission gate**. A plugin's token only carries the scopes
listed in its own `plugin.json` → `permissions`; step outside them and you get **403**
with the missing scope named in the body.

| Scope | What it allows |
|---|---|
| `read:fonts` | Read font / family lists and enabled state |
| `write:fonts` | **Enable / disable / rescan** — changes system-wide state; the one to scrutinise |
| `read:snapshot` / `write:snapshot` | Read / create / delete / apply setting snapshots |
| `read:curation` / `write:curation` | Read / modify your notes, ratings, favorites, tags |
| `export` / `import` | Start a pack export + poll progress / import a font pack |
| `write:apply` | **Apply a font in Photoshop / Illustrator / CorelDRAW** (drives another app) |
| `read:apps` | Ask "which design app was used most recently" |

These **10 scopes** are the entire whitelist (`api.rs::PERMS`). A plugin that declares
`*` or misspells a scope gets it **silently dropped and logged** — it never receives full
access. `GET /health` → `permissions` shows what was actually minted.

The order is **401 (no token) → 403 (scope missing) → 422 (malformed body)**: the gate runs
before the body is parsed, so a missing scope never shows up as 422.

Missing a scope? Add it to **the plugin's own** `plugin.json` and hit *Rescan* — tokens are
minted at enable time. **No FontManager change needed.** To see what you actually hold, read
`permissions` from `GET /health` (`allPermissions` is the full catalogue).

> Full scope table, plus the rule for adding a new route (`routes()` **and** `perm_for()`,
> or the route is silently **open**), is in
> [docs/PLUGINS.md § 权限](docs/PLUGINS.md#权限403-到底是谁拦的) (Chinese).

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

3. Done — the MCP server **finds `api.json` on its own** (it looks in
   `%LOCALAPPDATA%\FontManager\data\`, then `%APPDATA%\FontManager\`) for port
   and token, so resetting the token never breaks your config. If you installed
   FontManager outside `%LOCALAPPDATA%`, point `ZFM_API_JSON` at the actual file —
   the "Settings → Local API" error message prints the full path.
   WorkBuddy: connector manager → custom MCP → paste → "Trust"; Claude Desktop and
   Cursor work the same way.

Then just ask in conversation — "list my Noto fonts", "apply the work snapshot".
All 10 tools are documented in **[mcp/README.md](mcp/README.md)**.

#### What can an agent actually do with it?

MCP hands the agent a small set of verbs — list, activate, deactivate, annotate —
the imagination is the agent's own. A few things that genuinely work:

- **Identify a font from an image**: drop a poster, logo or chat screenshot into the
  chat and ask the agent to study the letterforms (serifs, weight, stroke endings…),
  then compare them against the fonts in your library — "do I already have the font
  in this image, and what is it called?" The agent can pull each candidate's file
  path via `font_detail`, render real specimens from those files to verify, and
  answer with evidence instead of a guess
- **Heal missing fonts**: hand the agent the font list a document or design file
  needs — it tells you which ones your library lacks and activates the ones it has,
  no more digging through font menus one by one
- **Curation at scale**: "tag everything imported last week as *pending review*",
  "deactivate every family rated below 3 stars" — dozens of clicks become one sentence
- **Scheduled checkups**: give the agent a recurring task to scan for new fonts,
  apply a named snapshot, and report the state of your library

> Image-based tricks need an MCP client that accepts pictures in chat
> (WorkBuddy and Claude Desktop both do).

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

**Where your data lives (2.1.5+)** — the app, your font library and everything the
app produces stay inside the install folder, so moving or backing up FontManager is
just moving one folder:

```
<install folder>\            NSIS default: %LOCALAPPDATA%\FontManager
├─ fontmanager.exe
├─ 字体库\                    your fonts (user assets — never auto-deleted)
├─ plugins\                   plugins (user assets)
└─ data\                      everything the app generates:
   ├─ state.json              tags, collections, favorites, activation ledger, snapshots
   ├─ prefs.json              settings
   ├─ font-cache.json         parse cache (rebuilds itself)
   ├─ api.json                local API port + token
   ├─ activation.log          diagnostics
   ├─ preview-cache\ thumb-cache\   regenerated on demand
   ├─ online\ Trash\          downloads, licenses, recycle bin
```

Install it to `D:\Apps\FontManager` and all of the above lives on `D:`.
Upgrading from 2.1.4 moves your data into `data\` and then **drops the old
`preview-cache` / `thumb-cache` on purpose** — they are regenerable and keeping
them would leave ~400 MB of cache on `C:`. First previews/thumbnails after the
upgrade are a bit slower while they rebuild; your tags, collections, favorites,
ledger, snapshots and plugins are never touched.
If the folder is not writable (typically the MSI build under `Program Files`),
data falls back to `%LOCALAPPDATA%\FontManager\data`, and the first line of
`activation.log` always tells you where: `data_root=… source=install|localappdata|roaming(fallback)`.
Upgrading from 2.1.4 copies the old `%APPDATA%\FontManager` data into `data\`
automatically and keeps the old folder as a backup.

**One exception, on purpose** — the WebView2 runtime keeps its own browser-profile
cache under `%LOCALAPPDATA%\com.iieozo.fontmanager` (roughly 100 MB: the Chromium
cache of the embedded browser engine). Windows owns and manages that folder; it is
not FontManager data and it does not move with the install folder. Uninstalling with
"delete app data" checked does remove it.

### Uninstalling

The NSIS uninstaller's confirmation page has a **"Delete app data"** checkbox:

- **Unchecked (default)** — only the program itself is removed. Font library,
  plugins, runtimes, `state.json`, caches, notes and snapshots are kept, so a
  reinstall picks up right where you left off.
- **Checked** — everything this app created is removed as well: `字体库`,
  `plugins`, `data` (state / prefs / caches / logs / online downloads / trash),
  `python-runtime` and `node-runtime` inside the install folder,
  `%APPDATA%\FontManager` (the `ZFontManager` folder from 0.8.x is no longer touched since 2.1.6),
  `%LOCALAPPDATA%\FontManager\data` and `%LOCALAPPDATA%\FontManager\字体库`,
  the three file-association registry keys, and HKCU font-registry values whose
  data points into those font libraries. `data` is only removed when it actually
  contains our own files (`state.json` / `font-cache.json` / `api.json` / the
  `.zfm-data-root` marker).

Cleanup is a strict allowlist: system fonts, system font-registry entries, fonts
in user-selected library folders, unrelated files in the install folder, and
snapshots/samples you exported elsewhere are never touched. Upgrades never
trigger cleanup. MSI uninstalls have no such checkbox and always keep the data.

---

## 🪟 Platform notes

FontManager is built on Tauri v2 and **ships Windows binaries** (NSIS + MSI),
tested on Windows.
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

Rust (MSVC) 1.85+ and Node 24+ are required (see `engines` in `package.json`).

### Run these five gates before opening a PR

| Command | 2.2.2 baseline |
|---|---|
| `npm test` | 428 tests: 427 pass / 1 skipped / 0 fail |
| `cargo test --lib` | 299 pass / 0 fail / 16 ignored (`--lib` is **required**: without it `generate_context!` fails for missing `custom-protocol`) |
| `npx tsc --noEmit` | 0 errors |
| `node check-locales.mjs` | 9 locales: zh-CN / zh-TW at 100%, others fall back to English by design; script prints `OK` |
| `node tools/check-panel-i18n.mjs` | Workshop panel: 149 keys × 9 locales complete |

`node tools/check-silent-paths.mjs` also audits the installer's silent path (currently
FAIL 0 / WARN 2), and `node tools/route-c.mjs status` reports the installer-UI switch.
The release pipeline runs the same gates.

---

## 🙏 Credits

FontManager is built by **IIEOzo**, and started from **ZFontManager 0.8.0**.
That starting point is the only thing the two projects share today.

<div align="center">

| | |
|---:|:---|
| 📦 **Source** | github.com/706972745/FontManager |
| 🔌 **Plugins** | github.com/706972745/FontManager-Plugin |

</div>

If FontManager is useful to you, a ⭐ genuinely helps others discover it.

---

## 📄 License

FontManager is free software, released under the
**GNU General Public License v3.0**.

In human terms: you may use it, share it, and change it — and if you
distribute a changed version, it must stay just as free for the next person.

The copyright notice of the 0.8.0 code FontManager started from is kept in
[LICENSE](LICENSE), as the GPL requires.

---

<div align="center">
<br>

<img src="src-tauri/icons/32x32.png" alt="" width="20" />

**FontManager** · your fonts, your machine, your rules

<sub>Built and maintained by <a href="https://github.com/706972745">IIEOzo</a>
· started from ZFontManager 0.8.0</sub>

</div>

---

<a name="简体中文"></a>

[English](#english) | **简体中文**

<!-- 中文正文与英文在同一份 README 里：顶部点「简体中文」是页内跳转（#简体中文），
     不再跳到 README.zh-CN.md 的文件页。改文档时两边一起改，别只改一半。 -->

<div align="center">

<img src="src-tauri/icons/128x128.png" alt="FontManager icon" width="110" />

# FontManager

**你的全部字体，一键启停，永不离开你的电脑。**

在一个干净、快速的应用里预览、整理、启用和安装字体。<br>
几千款字族也能在一台机器上整理清楚——还带插件、本地 API<br>
和 MCP，让你的其他工具一起参与。

<br>

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-gray?style=flat-square)](LICENSE)
[![Version](https://img.shields.io/badge/Version-2.2.4-gray?style=flat-square)](../../releases)
[![Platform](https://img.shields.io/badge/平台-Windows-gray?style=flat-square)](#-平台说明)
[![Languages](https://img.shields.io/badge/界面语言-9种-gray?style=flat-square)](#-翻译)
[![Built with Tauri](https://img.shields.io/badge/构建于-Tauri%20v2-gray?style=flat-square)](https://tauri.app)

<br>

**[⬇ 下载最新版](../../releases/latest)** ·
**[📝 更新日志](CHANGELOG.md)** ·
**[🐛 问题反馈](../../issues)** ·
**[🔌 插件开发](docs/PLUGINS.md)** ·
**[🎨 界面规范](docs/UI设计交付规格书.md)** ([HTML](docs/UI设计交付规格书.html)) ·
**[🧩 图标规范](docs/图标规范.md)** ·
**[🤖 MCP 接入](mcp/README.md)**

<br>

<img src="main.png?v=2.2.2" alt="FontManager —— 左侧栏、顶栏工具、字体卡片与实时预览" width="920" />

<sub>字体库：每个字族都以自己的字形实时渲染，离任何应用的字体菜单都只差一个开关。</sub>

</div>

<br>

---

## 🆕 最近更新

**2.2.2 —— 输入光标统一；面板说清「上传 / 登录 GitHub」是干什么的**

- **主程序和插件中心面板用同一块会闪的蓝块光标**：块高从「撑满输入框」改成
  **字号 + 2px、垂直居中**（13px 字 → 15px），宽度仍是字符 advance + 左右各 4px、圆角 3px。
  两个入口共用同一份组件与样式，改一处两边同时生效；中文输入法打字时仍退回原生细光标跟拼音。
  面板的密码框 / 多行框 / 复选框保持原生（镜像测宽会把输入明文写进 DOM）。
- **面板把上传和登录的用途讲明白了**：「上传插件」只是把插件存进可分享、可留存的共用仓库；
  登录 GitHub 只为了让你管理自己上传的插件（迭代更新、下架删除），**并无其他用途**。这句常驻在面板底部，
  粘令牌那一步也会再看到一次。
- **README 按实测口径重写**：本地 API 端点表补齐到 20 条路由、权限表补齐 10 项白名单，
  新增「改完代码先跑这五条」自检门禁；13 张 UI 截图与插件中心截图全部重拍到 2.2.2。

**2.2.1 —— 面板会自己更新；解释器更新只提示**

- **插件中心面板自动更新**：启动后查一次、24 小时内不重复查；有新版本在后台装好并提示一句。
  **面板没装就什么都不查、不下载**（装不装是你的事），也可以在 设置 → 插件 里关掉。
- **解释器有新版本只在设置页提示**：设置 → 运行时 那一行会写出最新版本号，卸载后重新下载即可换新 ——
  **不会自动替换**（换 Python / Node 版本会牵动插件依赖的 ABI，这活儿该你点头）。
- 面板与软件彻底解耦：面板单独发版、单独更新，不用等软件新版本。

**2.2.0 —— 插件中心：浏览、安装，还能直接上传**

- **面板按需下载**：安装包里不带工坊界面。**设置 → 插件 → 「下载插件中心面板」** 从 GitHub 拉面板包（`sha256` 校验），装好后**标题栏出现拼图图标**，点开是独立窗口，主题与语言跟随主程序，点别处自动收起。
- **面板里能上传插件**：弹窗四步（连 GitHub → 选目录 → 核对清单 → 提交），**一次可选多个插件目录**，共用一次提交与一个 PR；校验规则与仓库 CI 逐条对齐。
- **会动字体库的插件先给警示**：申请写字体 / 导入权限的插件，卡片带红标、详情顶部有整条警告——它能删字体、往库里加文件、改字体文件或调整库目录。
- **审核口径写进界面**：社区插件由 AI 自动核对规则上架、**审核不改动插件内容**，面板顶部横幅常驻说明。
- **面板打开更快**：清单拉取加 12 秒超时与一次重试，并做内存 / 数据目录 / 网络三级缓存。
- **标题栏动作重排并等距**：从右往左是设置 → 速览 → 导入文件夹 → 刷新 → 插件中心，图标中心间距统一 36px。

**2.1.7 —— 自动标签：导入就能按风格筛**

- **不用手打标签也能筛**：中文字体自动分出宋/黑/楷/隶/魏碑/行草/圆体/仿宋/美术字，西文补 Vox 子类；再加装饰工艺（描边、阴影、像素、内嵌…）、形态（粗重、高对比、紧凑）、技术能力（可变字重轴、小型大写、等宽数字）。
- **有证据、可解释**：每条自动标签都能看到理由（族名？PANOSE？OS/2 分类？），不是黑箱打分。
- **绝不写进你的标签**：你打的标签永远优先；你删掉或否决过的自动标签会按字族记住，重启、换字体库、删除后重装都不再冒出来。
- **删字体重装不丢标签**：标签跟着字族名走，从同事那里拿同一款再导入，还是你原来那份。
- **开关在设置里**，默认开；关掉立刻只剩手工标签，不需要重扫。

**2.1.6 —— 启动页放大一倍，安装器换成自己的界面**

- **启动页整体放大一倍**：1120 × 760，图标、标题、进度条、状态行全部按比例放大；**每次启动至少停留 1.5 秒**，热启动字体毫秒级就绪也不会一闪而过；先关启动页再显示主界面，不再两张脸叠着闪。深色主题图标背后的光晕也改成了淡蓝（原来是深宝蓝，整块卡面像海军蓝）。
- **安装器 / 卸载器改由主程序自己画**：和主程序同一套字体、同一套明暗主题、同一套措辞，不再用 NSIS 那套系统灰控件；静默安装（`/S`）依然是真静默。右栏那块品牌图整体调淡，不再抢左栏文字的注意力。
- **装之前先问一句**：如果装/卸的时候软件还开着，会弹一个对话框让你选「关闭软件并继续」还是「取消」，不再出现「文件被占用」或者「卸完了程序还在」。
- **进度屏不再装死**：`已用 N 秒` 自己走字、进度条会呼吸，覆盖安装也不会再假装瞬间跳到 88% 然后干等四十秒。
- **设置面板字阶重排**：最顶部的「设置」比所有文字都大，分区标题（语言 / 系统 / 字体库）明显大于行标签，靠字号 + 字重两级对比，不再一整屏一样大。
- **卸载更干净**：残留的图标文件和空的 `plugins` / 字体库目录会清掉；「连数据一起删」仍是需要你主动勾选的独立选项。
- **与 ZFontManager 彻底脱钩**：不再清理、也不再兼容它留下的旧目录与文案。

**2.1.5 —— 数据跟着安装目录走**

- **数据全在安装目录下**：装到 D 盘，标签 / 分组 / 收藏 / 台账 / 快照 / 缓存 / 日志 / 在线下载全在 `D:\…\data` 下，C 盘不再新增长出来的软件数据。升级老版本时自动搬迁，旧目录留一份当退路。
- **安装器界面重做**：去掉 NSIS 自带的蓝色侧栏，欢迎页改成自绘（大标题 + 细线 + 留白），中英双语、跟随系统；升级维护页默认停在「直接覆盖安装（推荐）」，不再默认先卸载。
- **首屏可用**（2.1.4）：打开软件先装载「上次已启用 + 系统字体 + 分组 + 快照」这批字体并立即可用，其余后台读取、只刷新一次。

完整清单见 [更新日志](CHANGELOG.md)。

## 📖 目录

- [为什么是 FontManager？](#-为什么是-fontmanager)
- [功能手册（手把手版）](#-功能手册手把手版)
- [插件、本地 API 与 MCP](#-插件本地-api-与-mcp)
- [键盘快捷键](#️-键盘快捷键)
- [翻译](#-翻译)
- [获取 FontManager](#-获取-fontmanager)
- [平台说明](#-平台说明)
- [隐私](#-隐私)
- [从源码构建](#-从源码构建)
- [致谢](#-致谢)
- [许可证](#-许可证)

---

## 💡 为什么是 FontManager？

FontManager 从 **ZFontManager 0.8.0** 迭代而来，此后已经长成自己的项目：
自己的代码、自己的发版路线、自己的插件平台。除了这个起点，两者不再共享任何
路线图、维护关系或上游依赖。

FontManager 在这个起点上加了什么：

- **自动化是一等公民。** 可选开启的本地 HTTP API、带独立权限令牌的进程外插件系统、
  以及一个 MCP 服务器——Agent 和脚本无需碰界面，就能查字体、启停字族、管理快照。
- **Windows 优先的发版路线**——NSIS 与 MSI 安装包、最多 3 个字体库地址一键切换
  （每个库都带专属文件夹图标），以及覆盖全部九种语言的界面打磨。

原版所有好的部分都还在：处处实时预览、一键启停，以及那条铁律——
**字体文件永远留在你的电脑里**。

> [!NOTE]
> **产品取向：本体够用，扩展放开。**
> **软件本体追求「够用、舒服的体验、更快的性能」** —— 不堆功能，优先把启动、滚动、搜索、
> 启停这些每天要做几十次的动作磨顺手。**插件生态、本地 API 与 MCP 追求「新功能、新体验、
> 更强的扩展性」** —— 新玩法、新集成、更深的自动化都长在这三处（含插件面板），
> 而不是往主界面继续塞东西，主程序因此可以保持小而稳。

> [!WARNING]
> **系统字体受保护。** 操作系统画自己界面要用的字体，不能从 FontManager
> 停用或删除，你可以放心探索。这些字体的卡片上是一个小小的 **OS** 锁形徽标
> （而不是开关），悬停可见原因。

---

## 🎯 功能手册（手把手版）

> 每个功能都写成「跟着点就行」的步骤。看完这节，软件里每个按钮你都知道是干嘛的。

### 1. 第一次打开：把字体装进库

1. 把**字体文件夹**或 **ZIP 包**直接拖进软件窗口（也可以点标题栏的**导入文件夹** —— 字体复制进字库，原文件夹原样保留；或：设置 → 字体库文件夹 → 「添加文件夹…」选文件夹）
2. 软件开始扫描，进度条走完，每张卡片就都用**字体本来的样子**显示出来了
3. 想加第二个库？设置 → 字体库文件夹 → 「添加文件夹…」再选一个；点某一行可改它的目录，行尾「切换」按钮换当前库（详见 [第 17 节](#17-多字体库最多-3-个库地址一键切换)）

> ZIP 里混了多个字族？会被**整包拒绝**并告诉你原因——这是故意的，防止一次灌进一堆乱七八糟的字体。

### 2. 认识主界面

![主界面：左侧栏、顶栏工具、字体卡片与实时预览](main.png?v=2.2.2)

**先认路：主界面分五个区**

| 区域 | 位置 | 你能做什么 |
|---|---|---|
| **标题栏** | 最上面一条 | 拖窗口 · 最小化 / 最大化 / 关闭 · **设置** · **收进速览**（<kbd>Alt</kbd>+<kbd>`</kbd>）· **导入文件夹** · **重新扫描** |
| **侧栏** | 左侧竖列 | 切视图：字体库 / 收藏 / 最近导入 / 已启用 / 启用至关闭 / 已停用 / 系统字体 / 分组 / 快照；底部是 在线 · 回收站 · 关于 · 快捷键 |
| **顶栏** | 内容区上方 | 搜索 · 改预览文字 · 字号滑杆 · 筛选 · 排序 · 对比 · **三种视图切换** |
| **内容区** | 中间 | 卡片 / 列表 / 样张三种视图；点卡片选中、右键出全套菜单、拖拽进分组 |
| **详情面板** | 点卡片后从右侧滑出 | 多字号样张 · 元数据 · 版权 · 备注与标签 · 导出 · 拖左边缘调宽 |

**左侧栏**（从上到下）：

| 项 | 点它看什么 |
|---|---|
| 浏览 → 字体库 | 全部字体（数字 = 字族总数） |
| 浏览 → 收藏 | 你点过 ★ 的字族 |
| 浏览 → 最近导入 | 刚装进来的 |
| 已启用 | 当前开着开关的 |
| 启用至关闭 | 临时启用的（退出软件自动还原） |
| 已停用 | 关着开关的 |
| 系统字体 | Windows 自带字体（带锁，动不了） |
| 分组 | 你自己建的组（点 + 新建） |
| 快照 | 启用状态的存档（见第 8 节） |
| 在线 / 回收站 / 关于 / 快捷键 | 在线下载 · 删除暂存 · 关于页 · 快捷键表 |

**顶栏**：搜索框 · 预览文字框（改成任何字，全库预览跟着变）· 字号滑杆（8–96px 八档）· 筛选 · 排序 · 对比 · **三个视图按钮（卡片 / 列表 / 样张）**。

> 2.0 起，**导入文件夹**与**重新扫描**搬到了**标题栏**（设置按钮右边）。
> 这两个动作作用于整个字体库，而不是「当前这一屏」，所以和视图控件分开放。

**一张字体卡片上有什么**：左上格式徽标（TTF / OTF / VAR=变量字体）· 字族名 ·
实时预览行 · 右侧**版权徽标**（商用免费 / 个人免费 / 未知…）· **★ 收藏** · **开关（启停）**。

### 3. 启用 / 停用：三步搞定

1. 找到字族（搜索或翻列表）
2. 点卡片右侧的**开关**——立刻写入系统
3. 打开任何软件的字体菜单，**它已经在那里了**；关掉开关就从所有应用消失（库里的文件不动）

- 想「临时用一下」？右键 → **启用至关闭**：退出软件时自动还原到之前的状态
- 想**批量**？按住 Ctrl/Shift 多选卡片 → 右键 → 「启用 N 个 / 停用 N 个」；批量没跑完就关了软件？下次启动会问你要不要**接着跑**
- 系统字体带 OS 锁徽标，不能停用不能删——Windows 画自己界面要用的，谁都不能动

### 4. 三种视图：卡片 / 列表 / 样张

顶栏右边三个小图标切换：

- **卡片**（默认）：每族一张卡，实时预览

- **列表**：紧凑表格，一列看全库——字族 / 样式数 / 格式 / 大小 / 开关，适合大批量浏览

![列表视图：一列看全库](view-list.png?v=2.2.2)

- **样张**：整库**多列样张墙**——每格保留卡片头部全部信息（格式 / 族名 / 版权 / 收藏 / 开关），
  下面用当前字号把示例文字**大字铺开**；每格可单独选字重（记住选择）；字号独立可调——挑字体气质时最好用

![样张视图：多列样张墙，大字铺开](view-specimen.png?v=2.2.2)

### 5. 详情面板：点开一个字族看全部

![详情面板：多字号样张与元数据](detail.png?v=2.2.2)

点任意卡片，右侧展开：

- **多字号实时样张**（大字 Aa → 小字，全部用真字体渲染）；变量字体有**轴滑杆**（字重等）
- 元数据：样式数 · 格式 · 分类 · 文字系统 · **字符集真实数字**（共 N 字符 · 汉字 M——「有没有中文」不再是猜）
- **版权信息全文** + 自动判定状态；有名称冲突（多个文件声明同一字体）会在这里红字警告
- 右上角：启停开关 · ★ · **全部导出**（把这个字族**整个文件夹**打成 zip，连同作者的
  授权书 / 说明文档一起发走；字体直接放在库根目录时只打包本字族）；面板左边缘可拖宽，双击恢复

### 6. 收藏与评分

1. 点卡片上的 **★**：收藏这个字族，同时记 **一星**（再点取消）
2. 想打 2–5 星：打开详情面板，点星级控件选几星
3. 速览条里的 ★ 同款；侧栏「收藏」一键过滤所有点过星的
4. 评分只是帮你标记「常用的 / 备用的」，软件不做任何限制

### 7. 整理：分组、标签、备注

- **建分组**：侧栏「分组」旁点 + → 起名 → 把卡片**拖进去**（或右键 → 分组 → 加入）
- **打标签**：多选卡片 → 右键 → 添加标签；标签会显示在卡片和详情上
- **写备注**：详情面板里直接写（比如「客户 A 品牌字体，授权到 2027」）；插件也能帮你写（见字体统计插件）

### 8. 快照：给「启用了哪些字体」拍张照

1. 侧栏「快照」旁点 **+** → 起名 → 当前启用集合被存档
2. 之后随便折腾字体，想回去：点快照 → **应用**（恢复原样）/ **合并到当前**（叠加）/ **切换**
3. **导出快照**：右键快照 → 导出 → 存成 `.S-FontManager` 文件——发给同事，他**双击就导入**
4. 右键 → 清除快照内所有字体 / 删除快照

### 9. 安装新字体：四种方式

| 方式 | 怎么做 |
|---|---|
| 拖 ZIP | 把 ZIP 拖进窗口，自动解包导入 |
| 双击安装 | 双击 `.S-FontManager / .P-FontManager / .L-FontManager` 文件，自动打开软件并导入（安装时已注册文件关联） |
| 在线面板 | 见下图：按分类 / 许可筛选，一键入库 |
| 本地 API / MCP | 自动化导入（见 [插件、本地 API 与 MCP](#-插件本地-api-与-mcp)） |

![在线面板：左侧分类与许可筛选，右侧字体卡片与一键入库](online.png?v=2.2.2)

在线面板怎么用：侧栏「在线」→ 顶部按**分类**（无衬线 / 衬线 / 展示 / 手写 / 等宽 / 图标）
和**许可**（OFL / Apache / UFL）筛选，或直接搜；卡片上写明风格 · 样式数 · 许可证
（VAR 徽标 = 变量字体）；点卡片进详情，**添加到字体库**一键下载——授权文本就在
下载按钮旁边，版权文件一起带下来。数据来自 Google Fonts 目录，1984 个家族。

### 10. 导出：所有出口都在这

| 你想导出什么 | 入口 |
|---|---|
| 单个字重（.ttf/.otf 文件） | 右键字面 → 导出字体文件 |
| 整个字族 / 多个字族 | 右键 → 导出字体家族… / 导出 N 个字体家族…（选个文件夹） |
| 字体清单（纯元数据） | 右键 → 导出字体清单… |
| 样张图（PNG） | 右键 → 导出字体样张…；或样张视图 |
| **快照** | 右键快照 → 导出（`.S-FontManager`，可再双击导入） |
| 整理数据（标签/分组/收藏/备注/手动版权/到期日） | 设置 → **导出库数据**（换电脑可合并进来） |
| **整包**（整理数据 + 全部字体） | 设置 → 勾「同时导出字体文件」→ 导出整包 → `.P-FontManager`（超 2GB 自动分卷，导入时任选一卷） |

**导入**一律是：双击文件，或拖进窗口。导入按**文件内容**识别，不看后缀。

FontManager 的专属文件都有**贴纸纸片风格图标**（撕纸毛边 + 手写体小字），资源管理器里一眼认出：
软件图标（**TYPE FontManager** 字标）· 快照导出 **.S** · 导出-含字体 **.P** ·
导出-仅数据 **.L** · 字体库文件夹 **.F**：

![FontManager 图标方案：贴纸纸片终稿（白纸 + 墨色字母 + 手写体小字）](icons-overview.png?v=2.2.2)

### 11. 回收站：删错了能后悔

1. 右键字族 → 移到回收站（批量同理）——从系统卸载但文件先收着
2. 侧栏「回收站」→ 可**还原**（原样回库）或**永久删除**（二次确认）

![回收站：移除的字体先来这里，绝不悄悄消失](trash.png?v=2.2.2)

### 12. 版权与查重：不用开浏览器

- 每个字族自动给出**版权结论**：个人免费 / 收费 / 免费商用 / 未知，并附**证据句**（读了哪些授权文档）
- 徽标挂在卡片、速览条上；全文在详情面板
- **绝不自动生成版权文件**：目录里**本来就有**授权文件就读它；没有就不动你的文件夹，
  改看**字体文件自带的版权信息**（详情面板「版权文件」一行会如实显示）；同目录两份矛盾授权 → 判「未知」让你自己看
- 判错了？详情面板里可**手动改判**并记录
- **查重**：同一个字体标识有多个文件时自动标出，详情面板里处理

### 13. 在 Photoshop / Illustrator / CorelDRAW / Affinity 中应用

右键字族 → 「在 {app} 中应用…」：

- **Photoshop / Illustrator**：脚本直送，不用翻菜单
- **CorelDRAW**：直接驱动它的 COM 对象模型（中文按中文名匹配）
- **Affinity**：开启自动激活后，打开的文档缺什么字体、库里有的自动补上

装了官方插件 **「字体套用（PS / AI / CDR）」** 之后还有两条更快的路：

- **速览里双击任意可复制的位置**（整行 / 展开的字重行）→ 直接套到最近在用的设计软件；
- 插件行右键 →「双击行为：先选窗口」→ 双击后点一下目标窗口再套用（15 秒内，点任务栏也认）。
  两种模式在插件右键菜单里一键切换，设置面板里能看到当前值。

### 14. ⚡ 速览条：任何应用里 1 秒切字体

![速览条：贴顶的启用字体面板](quickbar.png?v=2.2.2)

1. 任何界面按 <kbd>Alt</kbd>+<kbd>`</kbd>——主窗口收成**贴顶速览面板**
   （热键在 设置 → 系统 → 「速览快捷键」里改，见下图）
2. 只显示**已启用**的字体：点名字复制、**双击套用到设计软件**（需装「字体套用」插件）、★ 收藏、开关直接启停、"> 3" 展开同族字重、右键出全套菜单
   （右键菜单里**直接打字**就能搜字体：默认搜已启用的，<kbd>Tab</kbd> 切换全部——见第 16 节）
3. 顶部：搜索已启用字体 · 改预览文字和字号 · **图钉**固定 · 「完整界面」回主窗口
4. 不用了：拖回屏幕顶它自己收成一条细线，鼠标靠近再展开；或按 <kbd>Alt</kbd>+<kbd>`</kbd> 收回

### 15. 对比

1. 点工具栏「**对比**」进入挑选模式（或多选后右键 → 对比 N 个）
2. 挑 2–4 个字族
3. 并排看同样文字在不同字体下的效果，随时移除重挑

### 16. 键盘党：命令面板与快捷键

- <kbd>Ctrl</kbd>+<kbd>K</kbd>：命令面板——输入即达（跳视图、启停、对比、在应用中应用、快照…）

![命令面板：输入即达](palette.png?v=2.2.2)

- **右键菜单打字即搜**：任何右键菜单（卡片 / 列表 / 样张 / 速览 / 详情面板）出现后**直接打字**，
  顶部立刻出现搜索框，全库字体实时过滤——<kbd>↑</kbd><kbd>↓</kbd> 选择、<kbd>Enter</kbd> 或点击选中，
  自动跳到对应视图并滚动到该字体位置；<kbd>Esc</kbd> 先清空搜索、再按一次关菜单

![右键菜单里直接打字：菜单顶部出现搜索框，结果实时过滤，底部提示还能继续缩小](contextmenu.png?v=2.2.2)

- **Tab 切搜索范围**：搜索时按 <kbd>Tab</kbd>（或点搜索框旁的徽章）在「已启用 ↔ 全部字体」间切换——
  速览默认只搜已启用字体（选中就在速览内定位；选中未启用的会自动退回完整界面并定位），完整界面默认全部
- <kbd>?</kbd>（或侧栏「快捷键」）：完整快捷键表——导航 / 选择 / 对选中操作 / 快照全都在

![快捷键表：按 ? 或点侧栏「快捷键」打开，分「导航 / 选择 / 对选中操作」三组](shortcuts.png?v=2.2.2)

### 17. 多字体库：最多 3 个库地址，一键切换

![设置 → 字体库文件夹：默认库 + 自定义库列表，行内切换](libraries.png?v=2.2.2)

字体不放在一个地方？设置 → **字体库文件夹**：

1. 默认库是安装目录旁的「字体库」文件夹；打开「**使用自定义文件夹**」就能加自己的
2. 点「**添加文件夹…**」最多加 3 个库地址，每个库都挂上 FontManager 的**专属文件夹图标**，资源管理器里一眼认出
3. 行尾「**切换**」按钮换当前库，扫描结果实时跟着换；「📁」直接打开这个文件夹，「✕」移除
4. 库的列表跟着软件走——换电脑导出数据也一起带过去

### 18. 外观与语言

![设置面板：语言 / 系统 / 字体库…所有开关都在这一列](settings.png?v=2.2.2)

设置里可换：浅色 / 深色主题 · 界面音效开/关 · **减弱动效**（动画收敛、降透明度）·
九种界面语言（简体中文 · 繁體中文 · English · 日本語 · Deutsch · Español · Français · Português (Brasil) · Русский）。

### 19. 再进一步：插件 / API / MCP

想让它**自己干活**？看下一节。

---

## 🔌 插件、本地 API 与 MCP

FontManager 把核心能力开放给自动化——**默认关闭、仅限本机、按权限放行：**

| 层 | 做什么 | 文档 |
|---|---|---|
| **本地 HTTP API** | 只监听 `127.0.0.1` 的 REST API：查字体、启停、快照、整理数据。端口可设、令牌可重置、每条路由都有权限检查 | — |
| **插件** | 独立进程，通过 stdin/stdout 的 JSON + **受限令牌**通信——插件崩溃绝不会带走主程序。插件可以自带解释器（`interpreterPath`），也可以直接是自包含的 `.exe` | [docs/PLUGINS.md](docs/PLUGINS.md) |
| **MCP 服务器** | 把本地 API 包装成 MCP 工具，让 Agent（WorkBuddy、Claude、Cursor…）在对话里驱动你的字体库 | [mcp/README.md](mcp/README.md) |

### 📥 安装现成插件

官方插件集中在 **[FontManager-Plugin](https://github.com/706972745/FontManager-Plugin)** 仓库。
1.4.4 起两种装法：

- **拖拽安装**：把插件 ZIP 拖进软件窗口任意位置——主程序按 `plugin.json` 自动识别
  并安装（普通字体 ZIP 包仍然按字体导入，两者不会混淆）；
- **按钮安装**：**设置 → 插件 → 「从 ZIP 安装」**。

手工装法（任何版本都行）：解压出插件文件夹，放进插件目录
（**设置 → 插件 → 「打开插件目录」**），回软件里打开开关即可。

**关于解释器**：安装包自带一份**共享 Python 运行时**（Python 3.13 + Pillow +
fontTools，位于软件目录 `python-runtime/`）——**机器上没装 Python 也能直接跑
标准库插件**，什么都不用装。解释器解析顺序：插件自带（`interpreterPath`）→
主程序内置运行时 → 系统 Python。重依赖插件仍可自带 `runtime/`；
完整说明与排障见 [docs/PLUGINS.md](docs/PLUGINS.md)。

手工安装步骤（任何版本都行）：

1. 到 [插件库 Releases](https://github.com/706972745/FontManager-Plugin/releases/latest) 下载想要的插件 ZIP
2. 解压出插件文件夹（如 `specimen-export`）
3. FontManager → **设置 → 插件 → 「打开插件目录」**，把文件夹放进去
4. **设置 → 插件** 里打开插件开关（或点「重新扫描」）
5. 在任意字族上**右键 → 插件 ›** 使用；**设置 → 插件** 里那一行本身也是入口：
   行尾**齿轮**打开插件自己的设置面板（插件声明了才有），在**行上右键**能看到不需要
   选中字体的那些功能（打开导出目录、改保存位置…）

### 🧩 插件中心：浏览、安装、上传

![插件中心面板：卡片、搜索与三类筛选；底部常驻说明上传与登录 GitHub 的用途](workshop.png?v=2.2.2)


社区插件放在 **[FontManager-Workshop](https://github.com/706972745/FontManager-Workshop)** 仓库，
软件里通过「插件中心」浏览。它是一块**按需下载的独立面板**——装在**你的数据目录**里
（`<数据根>\workshop-panel`），主程序用本机回环服务打开它；**安装包里既没有它的入口，
也不会从安装目录加载它**：

1. **设置 → 插件 → 「下载插件中心面板」**：从 GitHub 拉面板包，核对 `sha256` 后装到数据目录
   （进度、失败重试，与上面解释器运行时那套一致）
2. 装好后**标题栏最左侧**出现拼图图标（悬停显示「插件中心」），点开是独立窗口
3. 面板里搜插件、按「官方 / 社区」与运行时筛选；点卡片看详情（详细说明、申请的权限、文件列表），
   一键安装 / 卸载，已装的会标「已安装」

几件和行为有关的事：

- **下载与安装都不需要 GitHub 账号**；只有「上传自己的插件」才需要登录
- **上传和登录的用途说清楚**：「上传插件」只是把插件存进可分享、可留存的共用仓库；
  登录 GitHub 只为了让你管理自己上传的插件（迭代更新、下架删除），**并无其他用途**。
  这句常驻面板底部，粘令牌那一步也会再显示一次
- **面板会自己更新**：装过之后，启动时会查一次（24 小时内不重复），有新版本**后台装好并提示一句**；
  **没装就什么都不下载**，也可以在 设置 → 插件 里把自动更新关掉。所以面板发新版不用等软件发版
- **点别处自动收起**：面板失焦就隐藏，再打开还是点标题栏那个图标（拖动窗口时不会误收）
- **会动字体库的插件有警示**：申请了 `write:fonts`（启停 / 删除 / 移动字体）或 `import`
  （往库里加字体文件）的插件，卡片上带「改动字体库」标记，详情页顶部有整条警告。
  **上传不受影响**——提示只在下游，只在你准备安装时出现
- **审核口径**：社区插件由 AI 自动核对规则后上架，审核**不会改动插件内容**；请只安装你信任的插件
- **清单缓存三级**（内存 → 本机数据目录 → 网络），拉取带 12 秒超时与一次重试，
  网络卡住不会一直转圈

#### 上传自己的插件（面板内完成，不跳网页）

面板右上角 **上传插件** → 弹窗走四步：

| 步 | 做什么 |
|---|---|
| **① 连 GitHub** | 粘一次 fine-grained 令牌（只需 `Contents` + `Pull requests` 读写）。令牌用 **DPAPI 加密**存在本机，不上传云端；连过之后不用再粘 |
| **② 选文件夹** | 主程序弹系统目录框，**支持一次选多个插件目录** |
| **③ 核对清单** | 目录里有 `plugin.json` 就自动预填，没有就手填。校验规则与仓库 CI 逐条对齐：插件 ID 正则、文件后缀白名单、单文件 10MB / 单插件 20MB、权限白名单、入口脚本必须在包里 |
| **④ 提交** | 后台自动 fork → 同步 main → 逐文件上传 → 建提交 → 开 PR。**多个插件共用一次提交、一个 PR**，进度分四段显示 |

PR 合并后 CI 重算 `index.json`，插件才会出现在中心里。

**下架与迭代跟着你的 GitHub 账号走，不跟这台电脑**：连上账号后，弹窗里会列出署名属于你的插件
（含匿名上传的），每条一个「下架」按钮，提交后是一条「删除该目录」的 PR。
匿名署名由登录名稳定派生（`anonymous-<hash(login)>`，不存本机、不是随机串），
所以换电脑、重装软件，只要登录同一个账号，照样能更新或下架自己的插件。

「以匿名身份上传」只对**仓库维护者**可用：CI 的归属校验要求目录名以 `__<PR 作者>` 结尾，
普通用户以匿名身份提交会被拦下，所以那一项对其他人是灰的。

### 🖥️ 使用本地 API

1. **设置 → 本地 API** 打开开关——地址牌显示实际地址（如 `127.0.0.1:58202`），端口可在下面输入框自定义
2. **令牌**默认打码隐藏，点眼睛显示；泄露了就点「重置令牌」（旧的立即失效）
3. 所有请求都要带请求头：`Authorization: Bearer <令牌>`
4. 试试看（PowerShell / curl）：

```powershell
# api.json 现在跟着「数据根」走。默认安装（NSIS，装在 %LOCALAPPDATA%\FontManager）
# 就是下面这个路径；装到别的目录时换成 <安装目录>\data\api.json。
$cfg = Get-Content "$env:LOCALAPPDATA\FontManager\data\api.json" | ConvertFrom-Json
# 健康检查
curl.exe -H "Authorization: Bearer $($cfg.token)" $cfg.base/health
# 搜字体
curl.exe -H "Authorization: Bearer $($cfg.token)" "$($cfg.base)/fonts?q=思源&limit=10"
# 启用一个字族（写入系统，任何应用的字体菜单立刻可用）
curl.exe -X POST -H "Authorization: Bearer $($cfg.token)" -H "Content-Type: application/json" `
  -d '{"family":"Noto Sans SC"}' $cfg.base/fonts/activate
```

常用端点速查（**本版共 20 条路由 / 21 个方法**，全部带权限闸门；完整表见
[docs/PLUGINS.md](docs/PLUGINS.md)）：

| 端点 | 作用 |
|---|---|
| `GET /health` | 健康检查：字体总数、当前令牌的权限、全部权限清单 |
| `GET /fonts` `GET /fonts/families` | 列出 / 搜索字体（q、limit、offset、family、license） |
| `POST /fonts/activate` `POST /fonts/deactivate` | 启用 / 停用字族（**只认字体库内的路径**） |
| `POST /fonts/scan` `POST /fonts/apply` | 触发库扫描（30 秒节流） / 把字体套到 PS·AI·CDR |
| `GET /apps/active` | 最近在用的设计软件（「自动套用」用） |
| `GET/POST /snapshots` `DELETE /snapshots/{name}` `POST /snapshots/{name}/apply` | 快照：列表 / 创建 / 删除 / 应用 |
| `GET /curation` `PUT /curation/{rating,favorite,tags,collection,note}` | 读整理数据 / 改评分、收藏、标签、分组、备注 |
| `POST /export/pack` `GET /jobs/{id}` | 打包导出（异步任务） / 查进度 |
| `POST /import` | 导入字体包（需「允许危险操作」总开关 + `import` 权限） |

> 请求体上限 16 MiB；`/health` 里的 `permissions` 是**当前这枚令牌**的权限，
> `allPermissions` 才是全局清单。端口每次启动轮换，脚本里别硬编码，从 `api.json` 现读。

#### 权限：403 是怎么回事

每条路由都有一道**权限闸门**。插件拿到的是**受限令牌**，只含它 `plugin.json` 里
`permissions` 申报过的那几项，越权直接 **403**（正文会写明缺哪一项）。

| 权限 | 能做什么 |
|---|---|
| `read:fonts` | 读字体 / 字族清单、启用状态 |
| `write:fonts` | **启用 / 停用 / 重扫**——改的是系统级状态，最该盯紧的一项 |
| `read:snapshot` / `write:snapshot` | 看 / 建 / 删 / 应用方案快照 |
| `read:curation` / `write:curation` | 读 / 改你写的标签、备注、评分、收藏 |
| `export` / `import` | 触发打包导出、查进度 / 导入字体包 |
| `write:apply` | **把字体套到 Photoshop / Illustrator / CorelDRAW**（会去驱动别的软件） |
| `read:apps` | 问「现在最近在用的是哪个设计软件」 |

这 **10 项**就是权限白名单的全部（`api.rs::PERMS`）。插件在 `plugin.json` 里写 `*`、
或写错一个字母，都会被**直接丢掉并记日志**，不会拿到全权；`GET /health` 的
`permissions` 能当场核对最终签发了什么。

请求的判定顺序是 **401（没令牌）→ 403（没这项权限）→ 422（请求体格式错）**：
权限检查在解析 body **之前**就跑完了，所以「缺权限」永远不会表现成 422。

少了权限，改**插件自己**的 `plugin.json` 把权限加进 `permissions`，再「重新扫描」即可
（令牌是启用时签发的，不重启不会变）——**不用改 FontManager**。想确认自己手里到底有什么，
读 `GET /health` 的 `permissions` 字段（`allPermissions` 才是全部可用权限）。

> 完整权限表、加新接口的规矩（`routes()` + `perm_for()` 必须同时改，否则**默认放行**）、
> 以及 `perm_for` 里 `match` 顺序的坑，见 [docs/PLUGINS.md](docs/PLUGINS.md#权限403-到底是谁拦的)。

### 🤖 接入 MCP（让 Agent 驱动你的字体库）

1. 设置 → 本地 API 开关打开（MCP 靠它工作）
2. 在 MCP 客户端配置里加一项（路径换成自己的绝对路径）：

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

3. 完事。MCP 服务器**自己找** `api.json`（先看 `%LOCALAPPDATA%\FontManager\data\`，
   再看 `%APPDATA%\FontManager\`）拿端口和令牌，重置令牌也不用改配置。
   如果你把 FontManager 装在了 `%LOCALAPPDATA%` 以外的地方，用 `ZFM_API_JSON`
   指向实际的 api.json —— 「设置 → 本地 API」的报错文案里会打印它的完整路径。WorkBuddy：连接器管理 → 自定义 MCP → 粘贴配置 → 点「信任」；
   Claude Desktop / Cursor 同理。

之后就可以在对话里说「列出我的思源字体」「应用快照 上班配置」——
10 个工具详见 **[mcp/README.md](mcp/README.md)**。

#### Agent + 字体库能玩出什么？

MCP 只交给 Agent 一套「查、启、停、记」的动词，剩下的想象力是 Agent 的。
几个真实可行的玩法：

- **以图搜字**：把一张海报、logo 或聊天截图丢进对话，让 Agent 看图里字形的特点
  （衬线、字重、笔画收尾……），再翻库里的字体逐个比对——
  「我库里有没有和这张图一样的字体？叫什么名字？」
  Agent 能通过 `font_detail` 拿到字体文件路径，直接打开字体文件渲染样张核对后再下结论，
  不靠猜
- **缺字自愈**：把设计稿或文档要用的字体清单发给 Agent——库里缺的它告诉你，
  库里有的直接帮你启用，省去一个个翻字体菜单
- **规模化整理**：「给上周导入的字体全部打上“待审”标签」「把评分低于 3 星的字族都停用」
  这类几十次点击的活，一句话的事
- **定时巡检**：给 Agent 排个定时任务，每天扫一遍新字体、套用指定快照、把库的状态汇报给你

> 以图搜字这类玩法需要 MCP 客户端本身支持发图（WorkBuddy、Claude Desktop 都可以）。

这些默认都没有开启；把本地 API 关掉，所有层同时失效。

---

## ⌨️ 键盘快捷键

在应用里按 <kbd>?</kbd> 查看完整且始终最新的列表——搜索、启停、快照、
命令面板与速览条都在里面。

---

## 🌍 翻译

开箱即用九种语言：简体中文 · 繁體中文 · English · 日本語 · Deutsch ·
Español · Français · Português (Brasil) · Русский。
想添加你的语言？看 **[docs/TRANSLATING.md](docs/TRANSLATING.md)**——不需要写代码。

---

## 📥 获取 FontManager

到 **[Releases](../../releases/latest)** 下载最新安装包：

- `FontManager_x.y.z_x64-setup.exe` — NSIS，按用户安装，无需管理员权限
- `FontManager_x.y.z_x64_en-US.msi` — MSI，按机器安装，装入 Program Files

两个安装包都**未做代码签名**，SmartScreen 可能会请求确认。运行前请先核对
Release 说明中的 SHA-256。

**数据放在哪（2.1.5 起）**—— 程序、字体库和软件产生的一切都在安装目录里，
想整体搬走 / 备份就是搬一个文件夹：

```
<安装目录>\                  NSIS 默认：%LOCALAPPDATA%\FontManager
├─ fontmanager.exe
├─ 字体库\                    你的字体（用户资产，绝不自动删）
├─ plugins\                   插件（用户资产）
└─ data\                      软件自己产生的一切：
   ├─ state.json              标签 / 分组 / 收藏 / 启停台账 / 快照
   ├─ prefs.json              偏好
   ├─ font-cache.json         解析缓存（删了自动重建）
   ├─ api.json                本地 API 端口 + 令牌
   ├─ activation.log          诊断日志
   ├─ preview-cache\ thumb-cache\   预览与缩略图（按需重建）
   ├─ online\ Trash\          在线目录 / 许可证 / 回收站
```

装到 `D:\Apps\FontManager`，上面这些就全在 D 盘。从 2.1.4 升级时数据会迁进 `data\`，
随后**刻意清掉旧的 `preview-cache` / `thumb-cache`**——它们是纯生成物，留着等于在 C 盘
继续占 400MB，与「缓存都放在安装目录下面」的要求相反；升级后第一次预览/缩略图会慢一点，
因为要在新位置重建。**这是设计行为，不是没删干净**：标签、分组、收藏、台账、快照、插件
一个字节都不会少，那才是「可回滚」真正要保的东西。若该目录当前用户不可写
（典型是 MSI 版装进 `Program Files`），数据会回退到
`%LOCALAPPDATA%\FontManager\data`；`activation.log` 第一行永远写着实际位置：
`data_root=… source=install|localappdata|roaming(fallback)`。
从 2.1.4 升级时会把旧的 `%APPDATA%\FontManager` 数据自动复制进 `data\`，
旧目录保留当备份（回退到 2.1.4 仍能用）。

**一处刻意的例外** —— WebView2 运行时会把自己的浏览器配置缓存放在
`%LOCALAPPDATA%\com.iieozo.fontmanager`（约 100MB，是内嵌浏览器内核的 Chromium 缓存）。
这个目录由 Windows 托管，**不是软件数据**，也不会跟着安装目录搬走；
勾选「同时删除全部数据」卸载时会一并清掉。

### 卸载

用「设置 → 应用」或卸载程序卸载 NSIS 版时，确认页有一个
**「同时删除应用数据」** 复选框：

- **不勾（默认）**：只删程序本体。字体库、插件、运行时、`state.json`、缓存、
  备注、快照全部保留，重装后接着用。
- **勾选**：除程序本体外，把本软件自己创建／下载的内容按白名单清干净 ——
  安装目录下的 `字体库`、`plugins`、`data`（账本 / 偏好 / 缓存 / 日志 / 在线目录 / 回收站）、
  `python-runtime`、`node-runtime`，
  `%APPDATA%\FontManager`（2.1.6 起不再处理 0.8.x 留下的 `ZFontManager` 目录），
  `%LOCALAPPDATA%\FontManager\data`、`%LOCALAPPDATA%\FontManager\字体库`，
  三个文件关联注册键，以及 HKCU 字体表里
  **值数据指向本软件字体库**的注册项；恢复到像没装过的状态。
  `data` 只在确实有我们自己的文件（`state.json` / `font-cache.json` / `api.json` /
  `.zfm-data-root`）时才整删。

清理**不会**动系统字体、系统字体注册项、用户自定义字体库里的字体、用户放进
安装目录的其它文件，也不会删你导出到文档或其它位置的快照与样张。
覆盖安装／自动更新不会触发清理；MSI 版没有这个复选框，卸载始终只删程序本体、
保留数据。

---

## 🪟 平台说明

FontManager 基于 Tauri v2 构建，继承了跨平台代码底子，但本分支**只发布
Windows 二进制**（NSIS + MSI）并在 Windows 上测试。系统字体保护、启停与
回收站都走 Windows 自己的机制（注册表 + GDI）——从不修改字体文件本身。

---

## 🔒 隐私

简短版：**开箱状态，什么都不外发。**

- ❌ 无账号、无注册、无遥测、无崩溃上报
- ❌ 你的字体、标签、分组、备注永远不会被上传——不存在这个功能，开或关都没有
- ✅ 一切都在你电脑上的本地文件里
- ✅ 唯一可联网的可选功能是**在线字体面板**（默认关闭），它只联系 Google Fonts
  目录与 GitHub 发布资源——传出去的只有你的 IP 和你选择下载的字体，
  与你已有的库无关

本地 API 只监听 `127.0.0.1`，在你打开之前一直处于关闭状态。

---

## 🛠 从源码构建

```bash
pnpm install
npx vite build
npx tauri build --bundles nsis,msi
```

需要 Rust（MSVC）1.85+ 与 Node 24+（见 `package.json` 的 `engines`）。

### 改完代码先跑这五条

| 命令 | 2.2.2 的基线 |
|---|---|
| `npm test` | 428 项：427 通过 / 1 跳过 / 0 失败 |
| `cargo test --lib` | 299 通过 / 0 失败 / 16 ignored（**必须带 `--lib`**，不带会因 `generate_context!` 缺 `custom-protocol` 编译失败） |
| `npx tsc --noEmit` | 0 错误 |
| `node check-locales.mjs` | 主程序 9 语言：zh-CN / zh-TW 100%，其余语言按设计回退英文；脚本判 `OK` |
| `node tools/check-panel-i18n.mjs` | 插件中心面板 149 键 × 9 语言全齐 |

另外 `node tools/check-silent-paths.mjs` 会扫安装器的静默安装路径（当前 FAIL 0 / WARN 2），
`node tools/route-c.mjs status` 看安装器界面开关状态。这几条也是发版流水线在跑的门禁。

---

## 🙏 致谢

FontManager 由 **IIEOzo** 构建，从 **ZFontManager 0.8.0** 迭代而来。
今天两者之间只剩这个起点这一层关系。

<div align="center">

| | |
|---:|:---|
| 📦 **源码** | github.com/706972745/FontManager |
| 🔌 **插件** | github.com/706972745/FontManager-Plugin |

</div>

觉得 FontManager 有用？一个 ⭐ 都能实实在在帮到后来的人。

---

## 📄 许可证

FontManager 是自由软件，遵循 **GNU General Public License v3.0**。

用人话说：你可以使用、分享和修改它；但如果你分发修改后的版本，
必须让下一个人获得同样的自由。

迭代起点那部分代码的版权声明保留在 [LICENSE](LICENSE) 里（GPL 的要求）。

---

<div align="center">
<br>

<img src="src-tauri/icons/32x32.png" alt="" width="20" />

**FontManager** · 你的字体，你的电脑，你说了算

<sub>由 <a href="https://github.com/706972745">IIEOzo</a> 构建与维护 ·
从 ZFontManager 0.8.0 迭代而来</sub>

</div>
