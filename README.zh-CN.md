[English](README.md) | **简体中文**

---

<div align="center">

<img src="src-tauri/icons/128x128.png" alt="FontManager icon" width="110" />

# FontManager

**你的全部字体，一键启停，永不离开你的电脑。**

在一个干净、快速的应用里预览、整理、启用和安装字体。<br>
几千款字族也能在一台机器上整理清楚——还带插件、本地 API<br>
和 MCP，让你的其他工具一起参与。

<br>

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-gray?style=flat-square)](LICENSE)
[![Version](https://img.shields.io/badge/Version-1.3.2-gray?style=flat-square)](../../releases)
[![Platform](https://img.shields.io/badge/平台-Windows-gray?style=flat-square)](#-平台说明)
[![Languages](https://img.shields.io/badge/界面语言-9种-gray?style=flat-square)](#-翻译)
[![Built with Tauri](https://img.shields.io/badge/构建于-Tauri%20v2-gray?style=flat-square)](https://tauri.app)

<br>

**[⬇ 下载最新版](../../releases/latest)** ·
**[📝 更新日志](CHANGELOG.md)** ·
**[🐛 问题反馈](../../issues)** ·
**[🔌 插件开发](docs/PLUGINS.md)** ·
**[🤖 MCP 接入](mcp/README.md)**

<br>

<img src="main.png" alt="FontManager —— 实时预览的字体库、启停开关与详情面板" width="920" />

<sub>字体库：每个字族都以自己的字形实时渲染，离任何应用的字体菜单都只差一个开关。</sub>

</div>

<br>

---

## 📖 目录

- [为什么是 FontManager？](#-为什么是-fontmanager)
- [功能导览](#-功能导览)
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

FontManager 始于 [ZFontManager](https://github.com/TheHolyOneZ/ZFontManager)——
TheHolyOneZ 对「Linux 上没有像样的字体管理器、别家好用的还要收费」这个简单苦恼的回应。
**本项目就是这款软件的迭代版**：从 ZFontManager 0.8.0 出发的一支定制构建，
长出了自己的发版路线。对原作者的感谢，两个方向都是真诚的。

在这个地基之上，本分支加了什么：

- **自动化是一等公民。** 可选开启的本地 HTTP API、带独立权限令牌的进程外插件系统、
  以及一个 MCP 服务器——Agent 和脚本无需碰界面，就能查字体、启停字族、管理快照。
- **Windows 优先的发版路线**——NSIS 与 MSI 安装包、有自己专属图标的字体库文件夹，
  以及覆盖全部九种语言的界面打磨。

原版所有好的部分都还在：处处实时预览、一键启停，以及那条铁律——
**字体文件永远留在你的电脑里**。

> [!WARNING]
> **系统字体受保护。** 操作系统画自己界面要用的字体，不能从 FontManager
> 停用或删除，你可以放心探索。这些字体的卡片上是一个小小的 **OS** 锁形徽标
> （而不是开关），悬停可见原因。

---

## 🎯 功能导览

### 整个字体库，实时渲染
库加载完成的瞬间，每个字族都以它自己的字形显示——搜索即时过滤，
虚拟列表让上万个字面依然顺滑。

### 启用与停用——杀手级功能
一次点击启停任何字族。停用的字体从所有应用的字体菜单里消失，
但仍在库中待命，随时秒回。

### 先试用，再入库
从 ZIP 包或双击字体文件安装。混装多个字族的 ZIP 会被整包拒绝并说明原因，
你的库永远不会被「惊喜」填满。

### 浏览并下载免费字体
内置的在线面板拉取 Google Fonts 目录与 Nerd Fonts 发布；
授权文本就摆在下载按钮旁边。

### 在 Photoshop 或 Illustrator 中应用
把字族直接送进 Adobe 应用；或者开启 **Affinity 自动激活**，
选中即用。

### 整理：分组、快照、收藏、备注与评分
标签和分组负责结构；快照把某个启用状态存下来、以后一键恢复；
收藏和一键 ★ 评分；逐字族备注，带**自动授权判定**——直接读字体自带的授权文档。

### 是回收站，不是碎纸机
移除的字体先进 FontManager 自己的回收站——可恢复，绝不直接消失。

### 查重、读授权
查重与版权分类全在本地完成，「这个能不能商用」不用打开浏览器。

### 对比、瀑布流、透视
并排对比、任意字号的瀑布流样张，以及展示每个字面、文件与元数据的详情面板。

### 速览条（QuickBar）
<kbd>Alt</kbd>+<kbd>`</kbd> 唤起的全局速览：在任何地方搜索整个字体库，
可以收成屏幕边缘的一条细线，需要时再弹回来。

### 备份与搬迁
把整个库导出成 `.ZFontManager` 整包（最大 2 GiB 分卷），到哪都能导入——
字体、整理数据与快照一起走。

### 主题、音效与动效
浅色与深色主题、可选的界面音效，以及让所有动画收敛的「减弱动效」模式。

### 你的语言
开箱即用九种语言，欢迎参与翻译。

---

## 🔌 插件、本地 API 与 MCP

FontManager 把核心能力开放给自动化——**默认关闭、仅限本机、按权限放行：**

| 层 | 做什么 | 文档 |
|---|---|---|
| **本地 HTTP API** | 只监听 `127.0.0.1` 的 REST API：查字体、启停、快照、整理数据。端口可设、令牌可重置、每条路由都有权限检查 | — |
| **插件** | 独立进程，通过 stdin/stdout 的 JSON + **受限令牌**通信——插件崩溃绝不会带走主程序。插件可以自带解释器（`interpreterPath`），也可以直接是自包含的 `.exe` | [docs/PLUGINS.md](docs/PLUGINS.md) |
| **MCP 服务器** | 把本地 API 包装成 MCP 工具，让 Agent（WorkBuddy、Claude、Cursor…）在对话里驱动你的字体库 | [mcp/README.md](mcp/README.md) |

### 📥 安装现成插件

官方插件集中在 **[FontManager-Plugin](https://github.com/706972745/FontManager-Plugin)** 仓库，
每个插件独立目录、**自带运行环境**，下载解压即用（机器上不用装 Python）：

1. 到 [插件库 Releases](https://github.com/706972745/FontManager-Plugin/releases/latest) 下载想要的插件 ZIP
2. 解压出插件文件夹（如 `specimen-export`）
3. FontManager → **设置 → 插件 → 「打开插件目录」**，把文件夹放进去
4. **设置 → 插件** 里打开插件开关（或点「重新扫描」）
5. 在任意字族上**右键 → 插件 ›** 使用

### 🖥️ 使用本地 API

1. **设置 → 本地 API** 打开开关——地址牌显示实际地址（如 `127.0.0.1:58202`），端口可在下面输入框自定义
2. **令牌**默认打码隐藏，点眼睛显示；泄露了就点「重置令牌」（旧的立即失效）
3. 所有请求都要带请求头：`Authorization: Bearer <令牌>`
4. 试试看（PowerShell / curl）：

```powershell
$cfg = Get-Content "$env:APPDATA\FontManager\api.json" | ConvertFrom-Json
# 健康检查
curl.exe -H "Authorization: Bearer $($cfg.token)" $cfg.base/health
# 搜字体
curl.exe -H "Authorization: Bearer $($cfg.token)" "$($cfg.base)/fonts?q=思源&limit=10"
# 启用一个字族（写入系统，任何应用的字体菜单立刻可用）
curl.exe -X POST -H "Authorization: Bearer $($cfg.token)" -H "Content-Type: application/json" `
  -d '{"family":"Noto Sans SC"}' $cfg.base/fonts/activate
```

常用端点速查：

| 端点 | 作用 |
|---|---|
| `GET /health` | 健康检查 + 字体总数 |
| `GET /fonts` `GET /fonts/families` | 列出 / 搜索字体（q、limit、offset） |
| `POST /fonts/activate` `POST /fonts/deactivate` | 启用 / 停用字族 |
| `POST /fonts/scan` | 触发一次库扫描 |
| `GET/POST /snapshots` `POST /snapshots/{name}/apply` | 快照：列表 / 创建 / 应用 |
| `GET/PUT /curation*` | 备注、评分、收藏、标签 |

> 每条路由都有权限检查；插件的受限令牌越权会被直接拒绝（403）。

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

3. 完事。MCP 服务器**自动读** `%APPDATA%\FontManager\api.json` 拿端口和令牌，
   重置令牌也不用改配置。WorkBuddy：连接器管理 → 自定义 MCP → 粘贴配置 → 点「信任」；
   Claude Desktop / Cursor 同理。

之后就可以在对话里说「列出我的思源字体」「应用快照 上班配置」——
10 个工具详见 **[mcp/README.md](mcp/README.md)**。

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

需要 Rust（MSVC）1.85+ 与 Node 20+。Rust 单元测试用 `cargo test --lib`，
界面测试用 `npm test`。

---

## 🙏 致谢

FontManager 由 **IIEOzo** 构建，迭代自
**[TheHolyOneZ](https://github.com/TheHolyOneZ)** 的
**[ZFontManager](https://github.com/TheHolyOneZ/ZFontManager) 0.8.0**——
没有那个地基，就没有这里的一切。谢谢。

<div align="center">

| | |
|---:|:---|
| 🧬 **上游项目** | github.com/TheHolyOneZ/ZFontManager |
| 👤 **原作者** | github.com/TheHolyOneZ |
| 🌐 **原作者网站** | zsync.eu |
| 🍴 **本分支源码** | github.com/706972745/FontManager |

</div>

觉得哪个项目有用？一个 ⭐ 都能实实在在帮到后来的人。

---

## 📄 许可证

FontManager 是自由软件，遵循 **GNU General Public License v3.0**——与上游一致。

用人话说：你可以使用、分享和修改它；但如果你分发修改后的版本，
必须让下一个人获得同样的自由。

---

<div align="center">
<br>

<img src="src-tauri/icons/32x32.png" alt="" width="20" />

**FontManager** · 你的字体，你的电脑，你说了算

<sub>迭代自 <a href="https://github.com/TheHolyOneZ">TheHolyOneZ</a> 的 ZFontManager ·
由 <a href="https://github.com/706972745">IIEOzo</a> 维护</sub>

</div>
