# 插件 ID 统一为 `FM-XXX-XXX` —— 规则、官方件对照表、仓库 README 段落

> 2026-11-26 需求：ID 统一成 `FM-XXX-XXX`，官方插件一起改，插件中心只认 `FM` 前缀，
> 上传前先告知，仓库 README 写清。目的：**多个软件共用一个插件库**，按前缀分拣，互不抢名。

---

## 1. 规则

```
FM-XXX-XXX
```

| 项 | 规定 |
|---|---|
| 前缀 | `FM`，**必须大写**（就是 FontManager 的编号） |
| 两段 | 各自是任意长度的**字母或数字**（大小写随意）：`FM-ADOBE-FONT`、`FM-FONT-SYNC`、`FM-001-abc` |
| 字符集 | 只允许 `A-Z a-z 0-9` 和这两条短横线；点号 / 下划线 / 空格一律不允许 |
| 总长 | ≤ **40**（安装目录名是 `<id>__<作者>`，Windows 路径不吃太长） |
| 正则 | `^FM-[A-Za-z0-9]+-[A-Za-z0-9]+$`（总长 ≤ 40） |

三个环节同一条口径（客户端一处定义：`src/lib/workshop.ts` 的 `isPluginId()`）：

| 环节 | 行为 |
|---|---|
| 插件中心列表 | 不符合的条目**一条都不显示**（官方件、社区件同一道闸） |
| 上传弹窗 | 顶部常驻说明；ID 不合规 → 本地报错、提交按钮不可点 |
| registry CI | `validate_plugins.py` 再用同一正则挡一次 |

---

## 2. 官方插件改名对照

| 现 ID | 新 ID |
|---|---|
| `font-sync` | `FM-FONT-SYNC` |
| `font-stats` | `FM-FONT-STAT` |
| `specimen-export` | `FM-FONT-SPEC` |
| `font-apply` | `FM-FONT-APPLY` |
| `template-hello` | `FM-DEMO-HELLO` |
| `font-renamer`（社区示例） | `FM-FONT-RENAME` |
| `spec-counter`（社区示例） | `FM-FONT-COUNT` |

命名建议：`FM-<领域>-<动作>` —— `FONT` / `ADOBE` / `DEMO` 这类领域段 + `SYNC` / `RENAME` / `SPEC` 这类动作段。
以后别的软件照抄这个形状，换掉前缀即可（`AM-...` 给 AssetManager）。

### 每个官方件要改的地方（在 `FontManager-Plugin` 仓库里）

1. `plugins/<id>/plugin.json` → `id`，**目录名也要跟着改**；
2. registry 仓库 `FontManager-Workshop` 的 `plugins/<id>__<author>/` 目录名（社区件才有）；
3. release 包内目录名与 zip 名（`FM-FONT-SYNC-0.9.3.zip` 这种）；
4. `index.json` 里的 `id` / `dir` / `download`（由聚合脚本生成，源数据改了它会跟着变）。

### 已装用户的迁移

老 ID 装出来的目录（`font-sync` 等）**不会被自动改名**：插件本身照旧能跑，但插件中心会当成
另一个插件。建议顺序：

1. 先把 registry（index.json 与目录）改成新 ID 并上线；
2. 再发带这条过滤规则的新面板；
3. 在更新说明里提一句：老版本插件请先在 设置 → 插件 里卸载，再从中心装新 ID 的版本。

> ⚠️ 顺序反了会出现「插件中心暂时空着」：新面板会把老 ID 全部过滤掉，直到 registry 改完。

---

## 3. 可直接粘到 `FontManager-Workshop` README 的段落

### 中文

```markdown
## 插件 ID 规范：`FM-XXX-XXX`

本仓库同时服务多个软件，每个软件占一个前缀，互不抢名字。FontManager 的插件 ID
必须写成 **`FM-XXX-XXX`**：

- `FM` 是固定前缀，**必须大写**；
- 后面两段各是任意长度的字母或数字（大小写随意）：`FM-ADOBE-FONT`、`FM-FONT-SYNC`、`FM-001-abc`；
- 只允许字母、数字和这两条短横线，整串不超过 40 个字符；
- 目录名统一为 `plugins/<FM-XXX-XXX>__<你的 GitHub 登录名>`。

**不符合这条规则的插件不会被收录，也不会在插件中心显示；上传对话框里同样提交不了。**
这条规则由上传端的本地校验、聚合脚本与 CI 三处共同执行，正则：

    ^FM-[A-Za-z0-9]+-[A-Za-z0-9]+$

提交前先在 [FontManager 的插件开发指南](https://github.com/706972745/FontManager/blob/main/docs/PLUGINS.md)
核对 `plugin.json` 的 `id` 与目录名是否一致。
```

### English

```markdown
## Plugin ID rule: `FM-XXX-XXX`

This registry is shared by several apps, each owning one prefix so names never collide.
A FontManager plugin ID must be **`FM-XXX-XXX`**:

- `FM` is a fixed, **uppercase** prefix;
- followed by two runs of letters or digits (case-free, any length): `FM-ADOBE-FONT`, `FM-FONT-SYNC`, `FM-001-abc`;
- letters, digits and those two hyphens only, at most 40 characters in total;
- the folder is always `plugins/<FM-XXX-XXX>__<your GitHub login>`.

**Plugins with any other ID are not accepted and never appear in the Plugin Center** —
the upload dialog refuses them before submitting. The rule is enforced in the client,
the aggregation script and CI alike:

    ^FM-[A-Za-z0-9]+-[A-Za-z0-9]+$

Double-check `plugin.json`'s `id` and the folder name against the
[FontManager plugin guide](https://github.com/706972745/FontManager/blob/main/docs/PLUGINS.md)
before opening a PR.
```

---

## 4. CI 侧建议（`validate_plugins.py`）

```python
ID_RE = re.compile(r"^FM-[A-Za-z0-9]+-[A-Za-z0-9]+$")
ID_MAX = 40

def check_id(plugin_id: str) -> None:
    if len(plugin_id) > ID_MAX or not ID_RE.match(plugin_id):
        fail(f"插件 ID 必须写成 FM-XXX-XXX（大写 FM + 两段字母数字，≤ {ID_MAX} 位）：{plugin_id}")
```

聚合脚本（`aggregate_index.py`）也建议顺手跳过不合规的目录，并在日志里报一条 ——
免得它们静默堆在仓库里、谁都不知道为什么没上架。
