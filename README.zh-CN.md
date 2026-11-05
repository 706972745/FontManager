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

![主界面：字体库、实时预览与详情面板](main.png)

- **三种视图**：卡片 / 列表 / 瀑布流，工具栏一键切换；每张卡片都用字体**本体**渲染预览
- **工具栏**：搜索、预览文字自定义（默认 "Hello IIEOzo"）、预览字号滑杆（8–96px 八档）、筛选、排序
- **虚拟列表**：几千上万字面照样顺滑滚动，预览按需加载（LRU 缓存防内存爆）
- **智能分类**：中日韩字族按名字识别、等宽 / 衬线 / 无衬线自动归类、
  变量字体（VAR）与 OpenType 特性一目了然

### 侧栏：一切从左边开始

- **浏览**（字体库 4194 · 收藏 · 最近导入）· **已启用 / 启用至关闭 / 已停用 / 系统字体**四个状态视图
- **分组**：自由建组，把字族拖进去；**标签**：批量选中一键打标
- **快照**：把当前的启用集合存成档案，随时**应用 / 合并到当前 / 切换**
- 底部入口：**在线字体 · 回收站 · 关于 · 快捷键**（按 <kbd>?</kbd> 随时看全表）

### 启用与停用——杀手级功能

卡片右侧的开关就是启停：写进系统，**所有应用的字体菜单立刻生效**。
停用的字体从各应用消失但仍在库里待命，秒回。

- **启用至关闭**：临时用一下的字体，退出软件自动还原原状
- **批量**：多选后右键「启用 {count} 个」；上次批量没跑完，启动时会问要不要**继续**
- **系统字体保护**：画系统界面要用的字体带 OS 锁徽标，不能停用不能删

### 详情面板：一个字族的全部底细

![详情面板：多字号样张与元数据](detail.png)

点任意字族展开右侧详情：**多字号实时样张、变量字体轴调节、样式数 / 格式 /
文字系统 / 字形数 / 版权全文 / 文件路径**，右上角直接启停、收藏、导出。
名称冲突（多个文件声明同一字体标识）会在这里明确警告。

### 对比与样张

- **对比**：挑最多 4 个字族并排比（工具栏「对比」或右键）
- **字体样张**：整页样张可导出 PNG，交付给客户前最后一眼

### 安装与导入

- **拖进窗口即导入**（认 ZIP；一个 ZIP 混多个字族会被**整包拒绝**并说明原因——库不被「惊喜」填满）
- **双击安装**：`.S-FontManager / .P-FontManager / .L-FontManager` 专属格式双击直接进库
- **在线字体**：内置 Google Fonts 目录（衬线 / 无衬线 / 手写 / 图标… 分类浏览）
  与 Nerd Fonts 发布，**授权文本摆在下载按钮旁边**，下载自动带版权文件
- **回收站**：移除先进回收站（随时还原），确认后才永久删除

### 在 Photoshop、Illustrator、CorelDRAW、Affinity 中应用

右键字族 →「在 {app} 中应用…」，字族直接进设计软件：

- **Photoshop / Illustrator**：COM 脚本直送，无需手动找菜单
- **CorelDRAW**：没有脚本接口就**直接驱动 COM 对象模型**——中文字体按中文名匹配
- **Affinity 自动激活**：连上 Affinity 的 MCP 服务后，打开的文档缺什么字体、
  库里有的自动帮你激活补齐，选中即用

### ⚡ 速览条（QuickBar）

![速览条：贴顶的启用字体面板](quickbar.png)

<kbd>Alt</kbd>+<kbd>`</kbd>（热键可自定义）随时唤出——主窗口整个 **morph 成贴顶的速览面板**：

- 只列**当前启用**的字体：每行真实字形预览、版权状态徽标（商用免费 / 未知…）、
  版权行、一键 ★ 收藏、展开字族成员（如 "> 3"）
- 顶部：启用计数、搜索已启用字体、预览文字与字号调节、**图钉固定**、
  「完整界面」一键回主窗口
- **贴顶自动隐藏**：收成一条细线浮在屏幕顶，鼠标靠近即展开；拖到其他屏幕边缘停靠
- 右键任意行 = 完整右键菜单（启停 / 复制各种名字 / 分组 / 插件…）

### 整理与判定，全在本地

- **收藏与星级**：点 ★ 一键一星，最多五星；备注逐字族记录
- **自动查重**：相同字体标识的多余文件直接标出
- **版权自动判定**：读字体自带的授权文档（目录里有授权文件不新建、
  同目录矛盾授权判未知），给出**个人免费 / 收费 / 免费商用 / 未知**结论 +
  证据句，速览与卡片上直接挂徽标

### 备份与搬迁

整个库导出成 `.ZFontManager` 整包（**最大 2 GiB 自动分卷**）——字体文件 +
分组 / 标签 / 快照 / 备注评分一起走，到哪都能整包导回。

### 命令面板与快捷键

<kbd>Ctrl</kbd>+<kbd>K</kbd> 命令面板：跳转视图、启停、对比、在应用中应用、
快照操作——手不离键盘。<kbd>?</kbd> 看完整快捷键表。

### 主题与语言

浅色 / 深色主题、可选界面音效、**减弱动效**模式（动画收敛、透明度降低）；
九种语言开箱即用，欢迎参与翻译。

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
