# 插件开发指南（plugin.json 规范）

> 只想**用**插件、不想开发？跳到 [官方插件库](https://github.com/706972745/FontManager-Plugin)：
> 下载 ZIP → 解压 → 设置 → 插件 →「打开插件目录」放进去 → 打开开关 → 右键「插件 ›」。
> 插件需要的解释器不用自己装：设置 → 插件 → 运行时管理 里一键下载（见下文）。
>
> **插件行本身也是入口**（1.3.7 起）：设置 → 插件 里每个插件那一行，右侧的**齿轮**打开
> 插件自己的设置面板（插件声明了才有），在**行内任意位置右键**能看到该插件不需要选中字体
> 的功能（打开报告目录、清缓存之类）。

FontManager 的插件是**进程外程序**：主程序绝不把插件代码加载进自己，插件崩了不影响软件。
通信只有两条：stdin/stdout 上的 JSON 行（握手 + 调用），以及本地 HTTP API（受限令牌）。

插件目录（1.3.8 起）：**`<软件安装目录>\plugins\<插件目录>\plugin.json`** —— 跟着安装目录走，
整个文件夹拷走就是一套完整的软件。安装目录不可写（MSI 装到 `C:\Program Files`）或调试构建时，
回退到 `%APPDATA%\FontManager\plugins`；**老用户原位置有插件就继续用原位置**，不搬家。
不确定在哪？设置 → 插件 →「打开插件目录」会直接打开当前生效的那个目录。

## plugin.json 完整示例

```json
{
  "id": "com.example.my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "apiLevel": 1,
  "entry": "main.py",
  "interpreter": "python",
  "permissions": ["read:fonts", "write:curation"],
  "hooks": ["init", "context-menu", "settings"],
  "menus": [
    { "title": "对我的字族做点什么", "on": "family" },
    { "title": "打开报告目录", "on": "plugin" }
  ],
  "settings": { "title": "我的插件 · 设置", "hook": "settings" }
}
```

| 字段 | 说明 |
|---|---|
| `id` | 全局唯一 ID（建议反向域名），启用状态记忆按它来 |
| `entry` | 入口文件：`main.py` / `index.mjs` / 直接一个 `.exe` |
| `interpreter` | `python` / `node` / 留空（entry 是 exe 时留空即可） |
| `interpreterPath` | **自带解释器**：相对插件目录的路径（如 `"runtime/python.exe"`）。写了它就不做系统探测——插件自己背环境，用户机器上什么都不用装 |
| `requirements` | **运行环境自述（1.5.4 起，强烈建议写）**：`runtime`（如 `"Python 3.10+"`）、`libraries`（如 `["Pillow 13"]`）、`system`（如 `["Windows PowerShell"]`）、`platforms`、`note`。软件会在插件清单每一行标出「自带 / 需要 Python / 无需环境 / 缺少运行时」并在悬停里给出完整清单，发布页也会生成「运行环境」列。不写时软件按 `interpreter` + `interpreterPath` 推断 |
| `permissions` | 申请的权限：`read:fonts` / `read:curation` / `write:curation` / `import` 等；令牌按这个列表过滤，没申请的路由返回 403 |
| `menus` | 右键菜单项：`title` 显示文本，`on` 挂载对象 —— `family`（字族右键，默认）/ `plugin`（**插件自己那一行**的右键，1.3.7 起） |
| `settings` | **有设置面板就写这一项**（1.3.7 起）：`title` 是齿轮的悬停文字，`hook` 是要调的钩子名（默认 `settings`）。不写 = 没有设置，界面上不显示齿轮 |

## 运行环境：看得见、按需下载、可删除（1.4.11 起）

**安装包不再内置解释器**（1.4.11 之前内置过 Python；1.4.10 短暂内置过 Node）——
安装包瘦回 ~19 MB，需要什么解释器由**用户自己决定**下载。找它们的地方：
**设置 → 插件 → 「插件运行时」** 两行（Python / Node.js）：

- **看得见**：每行显示安装状态（版本号、占用 MB）、系统里另外探测到的解释器版本、
  哪些插件在用。没装的一目了然，装没装、缺不缺用户说了算；
- **一键下载**：没装的行有下载按钮 —— 从 GitHub 官方 release 拉 zip 装进软件目录
  （Python ~19 MB，Node ~32 MB），有实时进度条；下载的运行时在离线机器上也能用；
- **可删除**：不写插件也不用插件了，删掉运行时立刻省下几十 MB。有插件正在运行时
  会先被拦（Windows 锁着运行中的 exe），关掉插件开关就能删；
- **随时补回**：删了之后随时一键重新下载，不用重装软件。

解析顺序（哪层找到用哪层）：

1. `interpreterPath` —— 插件**自带**的解释器（重依赖插件推荐随插件分发便携版运行时）；
2. **软件目录里的运行时**（上一步下载的）—— `python-runtime/`（Python 3.13 + Pillow +
   fontTools）、`node-runtime/`（Node.js 22 LTS）；
3. 用户在 设置 → 插件 里手动指定的路径（隐藏兜底，prefs `pluginRuntime`）；
4. 系统自动探测（PATH 与常见安装目录，逐个探活，跳过 Windows 商店的下载引导桩）。

离线环境：到 [release 页](https://github.com/706972745/FontManager/releases/latest)
手动下载 `python-runtime.zip` / `node-runtime.zip`，解压到软件安装目录即可。

`entry` 直接写 `.exe`（`interpreter` 留空）的插件天然自包含，什么都不依赖。

### 插件作者怎么选运行时

| 插件形态 | 建议 |
|---|---|
| 只用标准库（如 font-sync） | 什么都不带 —— 用户下载一次运行时即可，插件 zip 最小 |
| 需要 Pillow / fontTools 等第三方库 | 自带 `runtime/` + `interpreterPath`（参考 font-stats/specimen-export），环境自己背，主程序不做适配 |
| Node 插件，只用 Node 标准库 | `interpreter: "node"`，什么都不带 |
| Node 插件，要 npm 依赖 | 把 `node_modules/` 一起打进插件 zip，或自带便携 Node |
| 自包含程序 | `entry` 直接指向 `.exe`，`interpreter` 留空 |

### 用户侧排障：提示「没找到可用的 Python / Node.js 解释器」

1. **设置 → 插件 → 运行时管理 → 点下载**（十几 MB，几秒钟的事）；
2. 或安装 [Python 3.10+](https://www.python.org/downloads/) /
   [Node.js LTS](https://nodejs.org/)（Python 勾选 **Add python.exe to PATH**）；
3. 或改用自带运行时的插件版本（插件 Releases 里的 full 包）；
4. 仍不行：日志（设置 → 诊断）里搜 `解释器` 能看到每级探测的结论。

## 通信协议

主程序启动插件后往 **stdin** 写 JSON 行：

```json
{ "type": "init", "pluginId": "...", "apiLevel": 1, "apiBase": "http://127.0.0.1:PORT/api/v1", "apiToken": "plugin-..." }
{ "type": "invoke", "hook": "context-menu", "payload": { "family": "字族名", "menu": "用户点的菜单项标题" } }
{ "type": "invoke", "hook": "context-menu", "payload": { "menu": "打开导出文件夹", "source": "plugin-row" } }
{ "type": "invoke", "hook": "settings",      "payload": { "source": "settings" } }
{ "type": "invoke", "hook": "snapshot-missing",
  "payload": { "families": ["思源宋体", "霞鹜文楷"], "missing": 42, "total": 320, "snapshots": ["全量-2026-11"] } }
```

`hooks` 里列出自己会处理的钩子名（`init` / `context-menu` / `settings` / `snapshot-missing`），
只是给自己做文档，主程序不强制校验；但**`snapshot-missing` 是唯一一个由主程序主动挑人发的钩子** ——
只有声明了它、且正在运行的插件才会收到（见下）。

### `snapshot-missing`：快照缺字体的联动（主程序 1.8.3+）

快照只存字体清单、不存字体文件。用户在新机器上导入快照后，往往有一批条目本机没有。
主程序不自己下载任何东西，而是在提示条上给一个动作按钮，点击后**广播**给所有声明了
`"hooks": ["snapshot-missing"]` 的插件：

| 字段 | 含义 |
|---|---|
| `families` | 缺失字族名（已去重、已过滤空值），插件可以直接拿去比对远端包 |
| `missing` | 缺失的**条目**数（同族多字重会算多条，>= `families.length`） |
| `total` | 这批快照的条目总数 |
| `snapshots` | 涉及的快照名（用户一次可能导入多个） |

约定：

- **只被调用一次、不保证响应**：插件该做的是把用户带到自己的补全界面并预演（列出会拉哪些），
  **不要直接开始大批量下载** —— 用户还没确认要补什么；
- 没有插件声明这条 hook 时按钮不出现，提示文案与以前完全一致（所以老插件不会看到空按钮）；
- 主程序不认识任何具体插件，别在这里假设「只有 font-sync 会接」。

插件往 **stdout** 写 JSON 行（每行一个，UTF-8）：

```json
{ "type": "log", "message": "进日志" }
{ "type": "toast", "message": "弹提示" }
{ "type": "open-url", "url": "https://…", "title": "窗口标题（可选）" }
{ "type": "progress", "text": "正在同步 3/10…", "percent": 30, "running": true }
```

- `open-url`（1.4.5+）：主程序按安全规则处理——指向插件自己面板的本地回环地址开**应用内窗口**，
  外部 https 链接开**系统浏览器**，其余拒绝。插件别自己 `os.startfile`，走这条才不会被安全策略拦。
- `progress`（1.4.8+）：长任务的实时进度。主程序把它投到**主窗口底部进度条**（和扫描/打包进度同一位置）：
  `percent` 给 0–100；没给就画流动的不确定条；`running: false` 表示结束，`text` 写结果
  （「完成：…」或「失败：…」），结束文字停留 5 秒后收起。主程序 <1.4.8 会忽略这条，
  所以**配合 `toast` 一起发**，老版本至少还有开始/结束的弹窗提示。

注意：中文 Windows 上 Python 默认按 GBK 写管道，主程序按 UTF-8 解析——插件侧请用 UTF-8 输出
（Python 可设 `PYTHONUTF8=1`，主程序拉起 python 插件时已自动带上）。

## 设置面板（`settings` 字段 + `settings` 钩子）

插件是独立进程，主程序**从不替插件画界面**。所以「插件设置」的约定是：

1. `plugin.json` 写 `"settings": { "title": "…", "hook": "settings" }`；
2. 设置 → 插件 → 该插件那一行右侧出现一个**齿轮**（没写 `settings` 就没有齿轮，避免点了没反应）；
3. 用户点齿轮（插件在运行时），主程序往插件 stdin 发：

```json
{ "type": "invoke", "hook": "settings", "payload": { "source": "settings" } }
```

4. 插件收到后**自己**弹面板 —— Tk 小窗口、Win32 对话框、开浏览器指向本地页面……都行。
   面板里改的配置由插件自己持久化（放插件目录里的 `config.json` 最省事）；
5. 插件没在运行时齿轮是灰的，悬停会提示先打开开关（主程序不会替你拉起插件）。

**两个坑**：

- **不要在插件主线程里 `mainloop()`**。面板开着的时候 stdin 还会来别的调用（右键菜单、
  再点一次齿轮），主线程被 `mainloop` 占住就等于插件卡死 —— 另起一个 daemon 线程跑 UI。
- 没有图形库的运行时（精简版 Python 没有 `tkinter`）要有降级路径，例如退化成系统
  文件夹选择框；直接崩掉会让用户看到「插件启动 1 秒内就退出」。

参考实现：`examples/plugin-specimen-export/main.py` 的 `open_settings_panel()`。

## 插件行右键菜单（`"on": "plugin"`）

`menus` 里 `"on": "plugin"` 的项不再挂到字族右键，而是挂在**设置 → 插件 → 该插件那一行**上：
在那一行任意位置右键就能看到一个菜单，里面是这些项，加上主程序自带的两条
（`打开插件设置`、`打开插件目录`）。

```json
"menus": [
  { "title": "导出示例图（PNG）", "on": "family" },
  { "title": "设置导出位置…",      "on": "plugin" },
  { "title": "打开导出文件夹",      "on": "plugin" }
]
```

点击时照旧走 `context-menu` 钩子，payload 里没有 `family`，但多一个 `source`：

```json
{ "type": "invoke", "hook": "context-menu",
  "payload": { "menu": "打开导出文件夹", "source": "plugin-row" } }
```

什么时候该用 `plugin` 而不是 `family`：**功能不需要选中某个字族**的时候 ——
打开报告目录、清缓存、重新扫描、改导出位置这类。硬挂在字族右键里，用户得先找一款
字体才能点到，很别扭。

插件按 `menu` 标题分派即可（标题就是用户点的那一行文字）：

```python
def handle_invoke(hook, payload):
    payload = payload or {}
    if hook == "settings":                 # 齿轮
        open_settings_panel()
        return
    if hook != "context-menu":
        return
    menu = payload.get("menu") or ""
    if menu.startswith("打开导出文件夹"):     # 插件行右键
        open_export_folder()
        return
    family = payload.get("family") or ""    # 字族右键才有
    if family:
        export_family(family)
```

## 本地 API（受限令牌）

每个启用的插件拿到一枚**只含其声明权限**的令牌。常用端点：

```
GET  /api/v1/health
GET  /api/v1/fonts?q=&family=&limit=&offset=
POST /api/v1/fonts/activate       { "paths": [...] }
POST /api/v1/fonts/deactivate     { "paths": [...] }
GET  /api/v1/curation
PUT  /api/v1/curation/note        { "family": "...", "note": "..." }
PUT  /api/v1/curation/rating      { "family": "...", "stars": 3 }   ← 字段名是 stars，不是 rating
PUT  /api/v1/curation/favorite    { "family": "...", "favorite": true }
PUT  /api/v1/curation/tags        { "family": "...", "tags": ["衬线", "标题"] }
PUT  /api/v1/curation/collection  { "name": "分组名", "families": ["族1", "族2"] }  ← 1.9.24+；整份名单，空数组 = 删掉分组
```

### 端点 / 权限 / 是否「重大操作」（1.9.25 起）

| 端点 | 方法 | 权限 | 重大操作 |
|---|---|---|---|
| `/health` | GET | 只要令牌 | — |
| `/fonts`、`/fonts/families` | GET | `read:fonts` | — |
| `/fonts/activate`、`/fonts/deactivate`、`/fonts/scan` | POST | `write:fonts` | ✅ |
| `/fonts/apply` | POST | `write:apply` | — |
| `/apps/active` | GET | `read:apps` | — |
| `/snapshots` | GET | `read:snapshot` | — |
| `/snapshots`、`/snapshots/{name}` | POST / DELETE | `write:snapshot` | ✅ |
| `/snapshots/{name}/apply` | POST | `write:snapshot` | ✅ |
| `/curation` | GET | `read:curation` | — |
| `/curation/{rating,favorite,tags,note,collection}` | PUT | `write:curation` | — |
| `/export/pack`、`/jobs/{id}` | POST / GET | `export` | — |
| `/import` | POST | `import` | ✅ |

> 端口默认自动挑一个空闲的（`api.json` 里的 `port`），也可以在 设置 → 本地 API 里固定；
> 只监听 `127.0.0.1`。

**「重大操作」要过两道闸（1.9.25）**：会改字体库或系统字体状态的操作（上表 ✅ 的那些），

1. 设置 → 本地 API 的**「允许危险操作」总开关**必须打开，否则一律 403；
2. 还要在**「允许谁做重大操作」**里单独勾上这个客户端。

客户端标识：`api`（本地 API 脚本，用主令牌）、`mcp`（MCP，请求头带 `x-zfm-client: mcp`）、
插件就是它的 **plugin id**（插件令牌的名字，客户端改不了）。
总开关关着时，单独授权怎么勾都无效 —— 两道闸是「与」的关系。

带 `Authorization: Bearer <apiToken>`。完整示例见 `examples/plugin-specimen-export/`
（右键字族导出示例图 PNG，启动时自动跑一遍 API/权限自检）。

### 套用字体到 PS / AI / CDR（1.9.11 起）

`POST /api/v1/fonts/apply` —— 需要 `write:apply`。

**为什么要开这个端点**：套用这件事主程序里已经有一整套引擎（`adobe.rs`：启用检查、
CJK 提醒、CorelDRAW 常驻 COM 宿主、9 种 outcome）。插件自己写 COM / JSX / PowerShell
等于把它复制一遍，两边必然跑偏 —— 主程序修好的问题插件里还在。所以插件只负责
「选字体、认目标、翻提示」，套用一律走这里。

```json
POST /api/v1/fonts/apply
{
  "app": "photoshop",
  "postscriptName": "SourceHanSansSC-Regular",
  "label": "思源黑体 Regular",
  "family": "思源黑体",
  "aliases": ["思源黑体 CN"]
}
```

- `app`：`photoshop` / `illustrator` / `coreldraw`（其它值 → **400**）
- `postscriptName` / `family` 必填且非空（缺了 → **400**）
- `label` 只用于提示文案，可省；省了 / 空串时回退成 `family`
- `aliases` 是本地化族名候选（CorelDRAW 认中文名，只给英文名会成片找不到），可省

成功返回 `200 {"outcome": "applied:1"}`，`outcome` **原样透传**引擎的返回值：

| outcome | 含义 |
|---|---|
| `applied:N` | 应用到 N 个图层 / 文本框 |
| `created` | 目标软件里没有选中文字，新建了一个文本框写进去 |
| `no-text-selected` | 选中的对象不是文字 |
| `font-not-found` | 目标软件里没这个字体（多半没启用 / 装完没重启软件） |
| `no-document` | 目标软件没打开文档 |
| `not-running` | 目标软件没在运行 |
| `app-no-response` | 有窗口但不响应（弹着对话框 / 正在渲染） |
| `launch-timeout` | 尝试拉起软件但超时 |
| `ps-error:…` | 脚本层报错，冒号后是原文 |

调用方要留足超时：PS / AI 最多 30 秒，CorelDRAW 最多 60 秒（内部会起 PowerShell 并轮询）。
建议 `timeout=90`。

### 最近在用的设计软件（1.9.11 起）

`GET /api/v1/apps/active` —— 需要 `read:apps`。给插件的「自动」项用：

```json
{"app": "photoshop", "exe": "photoshop.exe"}
{"app": null, "exe": ""}
```

判定规则：先看前台窗口；前台是 FontManager 自己、或任务栏 / 桌面（`explorer.exe`）时，
沿 Z 序往下最多翻 30 个窗口，跳过不可见 / 最小化 / 带 owner 的窗口，第一个属于
PS/AI/CDR 的就是答案。前台是别的软件时直接返回 `null` —— 那种情况下用户确实不在用设计软件。

没有目标时**也是 200**（`{"app":null,"exe":""}`），这是正常状态，不是错误。

## 权限：403 到底是谁拦的

插件跑在独立进程里，**所有能力都通过本地 API 走 HTTP**，所以「权限」不是一句口号，
而是每个请求都要过的一道闸。理解这三步，403 就不再是玄学：

```
请求 ──▶ auth 中间件 ──▶ require_perm 中间件 ──▶ handler
         （认令牌）      （查这张表放不放行）    （真正干活）
         401 在这拦       403 在这拦
```

1. **`auth`**：看 `Authorization: Bearer <apiToken>`。没有 / 令牌不存在 → **401**
   （`缺少 Authorization: Bearer <token>`）。
2. **`require_perm`**：拿 `方法 + 路径` 去权限表里查这一条要什么权限，
   再看令牌有没有 → 没有就 **403**（正文会写明缺哪一项）。
3. **handler**：这时候才解析 body、才可能因为字段不对返回 **422**。

> 关键点：权限检查是**中间件**，跑在 body 解析之前。所以**同一件事缺权限一定是 403，不会先报 422**
> —— 如果你看到 422，那说明权限是够的，问题在请求体格式。

### 权限名单

令牌的权限**就是** `plugin.json` 里 `permissions` 那一串，但要先过一遍白名单
（签发处：`plugins.rs` 调 `api::sanitize_plugin_perms`）：只发 `PERMS` 里登记过的名字，
其余一律丢掉并写一行日志。可用权限名单定义在 `src-tauri/src/api.rs` 的 `PERMS`：

| 权限 | 能做什么 | 对应端点 |
|---|---|---|
| `read:fonts` | 读字体 / 字族清单、启用状态 | `GET /fonts`、`GET /fonts/families` |
| `write:fonts` | **启用 / 停用 / 重扫**（改的是系统级状态） | `POST /fonts/activate`、`/deactivate`、`/scan` |
| `read:snapshot` | 看方案快照列表 | `GET /snapshots` |
| `write:snapshot` | 建 / 删 / 应用快照 | `POST /snapshots`、`DELETE /snapshots/{name}`、`POST /snapshots/{name}/apply` |
| `read:curation` | 读你写的标签 / 备注 / 评分 / 收藏 | `GET /curation` |
| `write:curation` | 改上面这些 | `PUT /curation/{note,rating,favorite,tags}` |
| `export` | 触发打包导出、查导出进度 | `POST /export/pack`、`GET /jobs/{id}` |
| `import` | 导入字体包 | `POST /import` |
| `write:apply` | **把字体套用到 Photoshop / Illustrator / CorelDRAW**（会去驱动别人的软件） | `POST /fonts/apply` |
| `read:apps` | 问「现在最近在用的是哪个设计软件」 | `GET /apps/active` |

**`*` 不等于全权，插件写了也拿不到**（1.9.2 起）：签发时按上表白名单过滤，`*` 和拼错的
权限名会被直接丢掉，`activation.log` 里留一行「申报了不受支持的权限 […]，已忽略」。
想用某个端点就把表里对应的名字写上；写错了的表现是「接口 403 + 日志里有告警」，
而不是悄悄拿到更多权限。设置页插件卡上显示的是**实际生效**的权限，不是 manifest 原文。

### 少了权限怎么办

改**插件自己**的 `plugin.json`，把它加到 `permissions` 里，然后设置 → 插件 →
「重新扫描」（或关掉开关再打开）——令牌是启用时签发的，改完不重启不会变：

```json
{
  "permissions": ["read:fonts", "write:fonts"]
}
```

**不需要改 FontManager**。权限表是主程序的固定白名单，只要表里有这一项、你申报了，就能用。

### 怎么自查

`GET /api/v1/health` 返回的 `permissions` 是**当前这枚令牌**的真实权限，
`tokenName` 是令牌名，`allPermissions` 才是全部可用权限的清单。插件启动时打一行日志对比一下，
比猜快得多：

```python
health = api_get("/health")
log(f"我是「{health['tokenName']}」，权限：{health['permissions']}")
```

### 给主程序加新接口的规矩（改 FontManager 的人看）

新增一个 API 要**成套**改这几处，漏了第 2 步那道口子就对所有已登录令牌**默认放行**：

1. `api.rs::routes()` 里 `.route(...)` 注册路径；
2. `api.rs::perm_for()` 里加一行 `方法 + 路径 → 权限名`；
3. `PERMS` 里没有合适的权限名，就新增一个，并同步这张表；
4. 本文件上面的权限表补一行。

`perm_for` 是个 `match`，**从上往下取第一条命中的**，顺序很要紧：`GET /snapshots` 必须写在
`_ if p.starts_with("/snapshots")` 之前，否则「查快照」会被「写快照」那条吃掉。
1.9.11 的 `POST /fonts/apply` 同理 —— 它必须写在 `POST if p.starts_with("/fonts/")` 之前，
否则会拿到 `write:fonts`（能改系统字体表的权限）而不是 `write:apply`。
`api.rs` 里有条单测（`apply_and_active_use_their_own_perm`）钉住这个顺序。
默认分支 `_ => None` 是**不校验**，只在 `/health` 这种明确无害的端点上留口子；
另有 `every_route_is_gated` 单测直接读源码里的 `.route(...)`，新端点忘了登记权限会立刻变红。

## 调试

- 插件 stdout / stderr 全部进 `%APPDATA%\FontManager\activation.log`（`[plugin:<id>]` 前缀）；
- 启用后 1 秒的存活体检也会写日志，「刚启用就退出」多半能在里面看到退出码；
- 装好后设置 → 插件 →「重新扫描」刷新清单与右键菜单。
