# 插件开发指南（plugin.json 规范）

> 只想**用**插件、不想开发？跳到 [官方插件库](https://github.com/706972745/FontManager-Plugin)：
> 下载 ZIP → 解压 → 设置 → 插件 →「打开插件目录」放进去 → 打开开关 → 右键「插件 ›」。
> 每个插件自带运行环境，机器上不用装 Python / Node.js。
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
| `permissions` | 申请的权限：`read:fonts` / `read:curation` / `write:curation` / `import` 等；令牌按这个列表过滤，没申请的路由返回 403 |
| `menus` | 右键菜单项：`title` 显示文本，`on` 挂载对象 —— `family`（字族右键，默认）/ `plugin`（**插件自己那一行**的右键，1.3.7 起） |
| `settings` | **有设置面板就写这一项**（1.3.7 起）：`title` 是齿轮的悬停文字，`hook` 是要调的钩子名（默认 `settings`）。不写 = 没有设置，界面上不显示齿轮 |

## 运行环境的解析顺序

1. `interpreterPath` —— 插件**自带**的解释器（推荐随插件分发便携版运行时）；
2. 用户在 设置 → 插件 里手动指定的路径；
3. 系统自动探测（PATH 与常见安装目录，逐个探活，跳过 Windows 商店的下载引导桩）。

`entry` 直接写 `.exe`（`interpreter` 留空）的插件天然自包含，什么都不依赖。

## 通信协议

主程序启动插件后往 **stdin** 写 JSON 行：

```json
{ "type": "init", "pluginId": "...", "apiLevel": 1, "apiBase": "http://127.0.0.1:PORT/api/v1", "apiToken": "plugin-..." }
{ "type": "invoke", "hook": "context-menu", "payload": { "family": "字族名", "menu": "用户点的菜单项标题" } }
{ "type": "invoke", "hook": "context-menu", "payload": { "menu": "打开导出文件夹", "source": "plugin-row" } }
{ "type": "invoke", "hook": "settings",      "payload": { "source": "settings" } }
```

`hooks` 里列出自己会处理的钩子名（`init` / `context-menu` / `settings`），只是给自己做文档，主程序不强制校验。

插件往 **stdout** 写 JSON 行（每行一个，UTF-8）：

```json
{ "type": "log", "message": "进日志" }
{ "type": "toast", "message": "弹提示" }
```

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
PUT  /api/v1/curation/rating      { "family": "...", "rating": 3 }
PUT  /api/v1/curation/favorite    { "family": "...", "favorite": true }
```

带 `Authorization: Bearer <apiToken>`。完整示例见 `examples/plugin-specimen-export/`
（右键字族导出示例图 PNG，启动时自动跑一遍 API/权限自检）。

## 调试

- 插件 stdout / stderr 全部进 `%APPDATA%\FontManager\activation.log`（`[plugin:<id>]` 前缀）；
- 启用后 1 秒的存活体检也会写日志，「刚启用就退出」多半能在里面看到退出码；
- 装好后设置 → 插件 →「重新扫描」刷新清单与右键菜单。
