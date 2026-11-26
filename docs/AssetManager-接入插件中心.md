# AssetManager 接入插件中心 · 交接文档

> 写给之后做 AssetManager 插件中心的同事。
> **现状**：AssetManager 尚未接入，插件库那边已经按「双软件共用」改造完毕（2026-11-26），
> 所以接入时**不需要再改 registry 的脚本**，只需要客户端那一侧。
>
> 契约的唯一出处是 [`多软件共用插件库.md`](./多软件共用插件库.md)；本文是实现步骤与坑。

## 一、一句话

插件库（`Manager-Workshop` 社区 / `Manager-Plugin` 官方）是**两个软件共用**的，
按 ID 前缀分桶：`FM-` 是 FontManager，`AM-` 是 AssetManager。
AssetManager 要做的是：**拿 `by-app/am.json` 当自己的清单**，上传时只允许 `AM-` 前缀，
面板用同一套代码另出一个构建产物。

## 二、先确认这张表（改之前对一遍）

| 项 | FontManager（已实现，可照抄） | AssetManager（要做的） |
|---|---|---|
| 清单地址 | `.../Manager-Workshop/main/by-app/fm.json` | `.../Manager-Workshop/main/by-app/am.json` |
| 仓库 raw 前缀 | `.../Manager-Workshop/main` | 同左（同一个仓库） |
| 上传目标仓 | `706972745/Manager-Workshop` | 同左 |
| 官方件仓 | `706972745/Manager-Plugin` | 同左 |
| ID 规则 | `^FM-[A-Za-z0-9]+-[A-Za-z0-9]+$`，≤ 40 | `^AM-[A-Za-z0-9]+-[A-Za-z0-9]+$`，≤ 40 |
| 面板资产 | `panel-fm.zip` + `panel-fm-meta.json` | `panel-am.zip` + `panel-am-meta.json` |
| 官方件资产名 | `FM-XXX-XXX.zip` | `AM-XXX-XXX.zip` |

`by-app/am.json` **已经存在**（空数组，脚本每次聚合都会写），所以 AssetManager 接入时
清单地址直接可用，不会 404。

## 三、客户端要做的四件事

### 1. 清单拉取（只读浏览 + 安装）

```
GET https://raw.githubusercontent.com/706972745/Manager-Workshop/main/by-app/am.json
```

结构跟全量 `index.json` 一样：

```json
{ "version": 1, "generatedAt": "...", "official": [...], "plugins": [...] }
```

每个条目里有 `id / name / brief / detail / author / version / runtime / minAppVersion /
lang / download / size / dir / files / permissions`。社区件多 `dir` + `files`（逐文件
sha256 + 直链），官方件只有 `download`（zip 直链）。

**必须做的一层**：拿到条目后再按 `^AM-` 过滤一次。理由不是「清单可能脏」，而是
缓存 / 用户自己装的 GitHub 加速器 / 中间人代理都可能把旧文件递给你。FontManager 的实现是
`parseEntry()` 里一条 `isPluginId(id)`，不合格直接丢。

### 2. 安装

- 下载 → 校验 sha256（社区件逐文件、官方件整包）→ 解到插件目录 `<id>__<author>`。
- **不要相信清单里的路径**：拼路径前必须做「不许 `..`、不许绝对路径、不许盘符」的检查，
  zip 里也要防 zip-slip。FontManager 的 `install_zip_into` 有现成的拒绝逻辑。
- 插件目录里 `plugin.json` 的 `id` 与清单 id 必须一致，否则装完认不出来。

### 3. 上传 / 下架

FontManager 走的是「GitHub 设备码登录 → 直接开 PR」或「维护者直推」，没有 fork：

- 作者上传 → 开一个 PR 到 `Manager-Workshop`，目录 `plugins/<AM-id>__<登录名>/`；
- 作者下架 → 开一个 `[takedown] plugins/<目录>` 的 issue，仓库 Action 校验
  「发起人 == 目录署名者」后删目录；
- 维护者（admin / maintain）→ 直接 commit 到 main。

如果 AssetManager 复用这套，**PR 正文里请带一行 `app: AM`**，方便维护者一眼看出归属
（现在的 CI 还没强制校验这一行，但以后加校验时不会把老 PR 判错）。

**上传前必须做本地校验**（不要等 CI 打回）：
- ID 符合 `^AM-`；名称 ≤ 25 字；版本是 semver；
- `entry` 在 `files` 里且文件真实存在；
- 权限名在**你自己软件的 PERMS 白名单**里（注意：registry 的 `validate_plugins.py`
  里那份 PERMS 是 FontManager 的，AssetManager 的权限名不同 → 见下面「坑 ④」）。

### 4. 面板（可选，但强烈建议复用）

FontManager 的插件中心是一个独立 web 产物（React + Vite），由主程序起一个
`127.0.0.1` 随机端口的静态服务 + 一次性 key 提供给 webview。要复用：

- 面板代码在 `ZFontManager/src/workshop/`，只有几处是 FontManager 专属：
  `INDEX_URL`、`REPO`、`RAW_BASE`、上传时校验的 ID 正则、i18n 文案；
- 做法：把这几处抽成一份 `app.config.ts`（`{ prefix, indexUrl, repo, officialRepo }`），
  两个软件各传一份参数，**一套源码两个构建产物**；
- 发布产物命名 `panel-am.zip` + `panel-am-meta.json`，放在 `Manager-Workshop` 的 v1 release；
- 主程序侧读 meta（`{version, sha256, size}`）→ 比对本地版本 → 下载 zip → 校验 sha256 →
  解到自己的 app-data 子目录（FontManager 用 `workshop-panel`，AssetManager 换个名字）。

**为什么必须用 release 资产、不能用仓库 raw**：raw 前面有 CDN（`max-age=300`，加随机
查询串也绕不过），会出现「zip 是新的、meta 是旧的」→ sha256 校验失败 → 用户装不上。
release 资产不走那层缓存（FontManager 2026-11-15 踩过）。

## 四、坑（都是真踩过的，按严重程度排）

**① 目录名 = ID，不要图省事用中文/空格**
安装目录名就是身份，改名等于换插件：启用状态、配置、用户认知全断。
`<id>__<author>` 里 `<author>` 只能是 `[A-Za-z0-9-]` 或 `anonymous-xxxx`。

**② 插件的「存储键」不要跟着 ID 改**
凭据名、`%APPDATA%\<软件>\<插件>`、快照文件名这些是**用户数据的位置**，不是身份。
FontManager 改名时把 `font-sync` 的凭据名 `FontManager/font-sync/vault` 原样留着，
老用户升级后不用重新登录。AssetManager 一开始就按这个规矩来，以后改名零成本。

**③ 旧 ID 迁移要认领老目录**
ID 一改，用户机器上还躺着老目录（manifest 里是旧 id）。安装逻辑里要有一张
「旧 ID → 新 ID」的别名表，按它找到老目录**原地覆盖**，否则会装出第二份 ——
右键菜单里出现两条一样的项。FontManager 的实现见 `plugins.rs` 的 `LEGACY_ID_ALIASES`，
装完还要把老 ID 的运行实例停掉（`disable(old_id)`）。

**④ registry 的权限白名单目前是 FontManager 的**
`validate_plugins.py` 里的 `PERMS` 是 FontManager 的权限名（`read:fonts` 等）。
AssetManager 的权限名不同，**不能直接沿用**。两条路：
- 让 `PERMS` 变成「按前缀分组」的表（`{"FM": {...}, "AM": {...}}`），CI 按目录前缀选表；
- 或者 AssetManager 自己再挡一层，registry 侧先放宽。
**接入前必须先定这件事**，否则 AM 插件会被 CI 以「未知权限」拒掉。

**⑤ 名称上限 25 字（按字符数，不是字节）**
卡片一行放不下更长的名字。JS 里 `"😀".length === 2`，按 `length` 算会把 emoji 判成 2 个字，
要用 `[...str].length`；Python 的 `len()` 天然正确。

**⑥ 下架不能只看清单**
清单要等聚合脚本重算（实测 10 秒 ~ 2 分半，有加速器更久）。下架后要么探目录 404
（`raw.../plugins/<dir>/plugin.json`），要么等下一次清单。只看清单会出现「已经下架还在显示」。

**⑦ 清单别用 `?v=随机串` 绕缓存**
GitHub 加速器会**忽略查询串**、照旧返回缓存内容。要新鲜就读 GitHub API 的 contents
（无缓存），或者接受 CDN 延迟。

**⑧ 未登录调 api.github.com 只有 60 次/小时**
上传后的状态轮询别做成秒级：FontManager 的做法是「下架探目录 5 秒一次（不走 API）、
PR 状态 60 秒一次（走 API）」。

**⑨ 面板 key 与「面板必须能自己重启」**
面板服务绑 `127.0.0.1` + 随机端口 + 一次性 key；主程序重启后 key 失效，面板要能识别
401 并提示「重新打开插件中心」，而不是白屏。

**⑩ 别把两个软件的面板产物写成同一个文件名**
不然 AssetManager 发一次面板，FontManager 的面板就被覆盖了。这就是 `panel-fm.*` /
`panel-am.*` 的由来。

## 五、接入顺序（建议）

1. **定 ID 规则与权限表**（`AM-` 前缀、PERMS 分组）—— 这是所有事情的前提；
2. **只读浏览**：拉 `by-app/am.json`、列表、安装、卸载（不做上传）；
3. **上传 / 下架**：设备码登录 → PR / issue；
4. **面板**：复用 UI，出 `panel-am.*`，接自更新；
5. 把 `official.json` 里加上 AM 的官方件条目（官方件放 `Manager-Plugin` 的 `AM-*/`）。

每一步都能独立上线，不需要等前一步「完美」。

## 六、验收清单（照这个勾）

- [ ] 清单拉的是 `by-app/am.json`，不是 `index.json`；
- [ ] 列表里看不到任何 `FM-` 开头的插件；
- [ ] 上传时 ID 不是 `AM-XXX-XXX` → 本地就报错、提交按钮不可点；
- [ ] 装完的目录名 = `<AM-id>__<作者>`，`plugin.json` 的 id 与清单一致；
- [ ] 下架后插件从列表消失，且不会「刷新又回来」；
- [ ] 面板能从 release 自动更新，sha256 不匹配时拒绝安装并提示；
- [ ] 两个软件的面板产物、插件目录、清单互不覆盖。

## 七、什么时候必须更新本文

改了下面任何一项，**同一次 PR 里**把本文对应段落一起改掉（不然同事照着做会踩坑）：

- 清单地址 / 切片结构 / `by-app/*.json` 的字段；
- ID 规则、前缀表、名称上限；
- 面板资产命名、meta 结构、自更新流程；
- registry 的校验脚本（`validate_plugins.py` / `aggregate_index.py` / `selftest.py`）；
- 官方件仓的目录约定与资产命名；
- 上传 / 下架的通路（PR、issue、直推）与所需的 GitHub 权限。

改动记录写在本文末尾：

| 日期 | 改了什么 | 谁 |
|---|---|---|
| 2026-11-26 | 首版：双软件共用 + `FM`/`AM` 前缀 + 清单切片 + `panel-*` 资产 | — |
