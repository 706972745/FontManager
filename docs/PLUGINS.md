# 插件开发指南（plugin.json 规范）

> 只想**用**插件、不想开发？跳到 [官方插件库](https://github.com/706972745/FontManager-Plugin)：
> 下载 ZIP → 解压 → 设置 → 插件 →「打开插件目录」放进去 → 打开开关 → 右键「插件 ›」。
> 每个插件自带运行环境，机器上不用装 Python / Node.js。

FontManager 的插件是**进程外程序**：主程序绝不把插件代码加载进自己，插件崩了不影响软件。
通信只有两条：stdin/stdout 上的 JSON 行（握手 + 调用），以及本地 HTTP API（受限令牌）。

插件目录：`%APPDATA%\FontManager\plugins\<插件目录>\plugin.json`（设置 → 插件 →「打开插件目录」可直接打开）。

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
  "hooks": ["init", "context-menu"],
  "menus": [
    { "title": "对我的字族做点什么", "on": "family" }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | 全局唯一 ID（建议反向域名），启用状态记忆按它来 |
| `entry` | 入口文件：`main.py` / `index.mjs` / 直接一个 `.exe` |
| `interpreter` | `python` / `node` / 留空（entry 是 exe 时留空即可） |
| `interpreterPath` | **自带解释器**：相对插件目录的路径（如 `"runtime/python.exe"`）。写了它就不做系统探测——插件自己背环境，用户机器上什么都不用装 |
| `permissions` | 申请的权限：`read:fonts` / `read:curation` / `write:curation` / `import` 等；令牌按这个列表过滤，没申请的路由返回 403 |
| `menus` | 右键菜单项：`title` 显示文本，`on` 挂载对象（目前 `family`） |

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
```

插件往 **stdout** 写 JSON 行（每行一个，UTF-8）：

```json
{ "type": "log", "message": "进日志" }
{ "type": "toast", "message": "弹提示" }
```

注意：中文 Windows 上 Python 默认按 GBK 写管道，主程序按 UTF-8 解析——插件侧请用 UTF-8 输出
（Python 可设 `PYTHONUTF8=1`，主程序拉起 python 插件时已自动带上）。

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
