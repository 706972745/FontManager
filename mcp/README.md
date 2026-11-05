# FontManager MCP Server

把 FontManager 的本地 API 包装成 MCP 工具，让 Agent（WorkBuddy / Claude / Cursor / 任何支持 MCP 的客户端）
在对话里直接查字体、启停、建快照、评分。零依赖，只要机器上有 Node.js。

## 前置条件

1. FontManager 在运行；
2. FontManager → 设置 → 本地 API，开关打开（端口自动即可）；
3. 服务器自己读 `%APPDATA%\FontManager\api.json` 拿端口和令牌，**不需要你手动填**。
   （重置令牌后不用改配置 —— api.json 会更新，MCP 下次调用自动用新的。）

## 接入方法

在 MCP 客户端的配置里加一项（路径换成自己的绝对路径）：

```json
{
  "mcpServers": {
    "fontmanager": {
      "command": "node",
      "args": ["C:\\path\\to\\fontmanager-mcp\\index.mjs"]
    }
  }
}
```

- WorkBuddy：连接器管理 → 自定义 MCP → 粘贴上面的配置 → 点「信任」启用。
- Claude Desktop：`claude_desktop_config.json` 同上。
- Cursor：MCP 设置页同上。

## 提供的工具（10 个）

| 工具 | 作用 |
|---|---|
| `list_fonts` | 列出 / 搜索字体（q、limit、offset） |
| `list_families` | 按字族聚合列出 |
| `font_detail` | 一个字族的全部字面与路径 |
| `activate` / `deactivate` | 启用 / 停用字体（写入系统） |
| `scan_library` | 触发一次库扫描 |
| `list_snapshots` / `apply_snapshot` | 快照列表 / 应用快照 |
| `get_curation` / `set_note` / `set_rating` | 读备注评分 / 写备注 / 评分 |

## 安全说明

MCP 用的是 FontManager 签发的**主令牌**（全权限），所以它能在你机器上启用/停用字体。
不想让它动系统，就在 FontManager 设置里把「本地 API」关掉 —— api.json 会被清掉，MCP 自然失效。
