# Changelog

All notable changes to ZFontManager are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.9.6] — 2026-10-29

0.9.5-1 / 0.9.5-2 / 0.9.5-3 三个预发布版本的合并正式版，内容与它们一致：

- **速览界面：把「排列」换成「筛选」**——速览工具条原来那个排序下拉改成完整界面同款
  筛选菜单（来源 / 分类 / 版权 / 语言支持 / 格式 / 特性 / 变体 / 可停用 / 按字符），
  条件与完整界面共用同一份状态（在速览里勾选，回完整界面照样生效）；列表只筛「已启用」
  字体的规则不变，排序仍跟随完整界面当前的排序方式。筛选逻辑抽成
  `applyFamilyFilters()`，两个界面共用一份，避免口径跑偏。
- **版权判定改为「保守优先」+ 判定留痕写进备注**（0.9.5-1）：删掉单字「免费」判商用
  免费、`ofl`/`gpl` 裸子串等误判来源；多证据冲突一律判「未知」；授权文件支持
  UTF-8 / UTF-16 / GBK；详情面板备注新增「判定依据：…｜原文「…」｜来源：…」，
  0.9.5-2 起还带「授权原文：」渠道条款摘录。每个字族只自动写一次，用户改过不覆盖。
- **「个人免费、商用收费」一律判「个人免费」**（0.9.5-2）：`personal use only` /
  `non-commercial` / 「不可商用」「禁止商用」等条款不再标成收费；仍判收费的只剩
  真要求付钱/试用的表述。判定口径带版本号，旧自动备注按新口径自动重写。
- **刷新按钮收编「直接放进字库」的字体**（0.9.5-3）：扫描开头递归走一遍字库目录，
  没登记过的字体自动补进链接字体（记入库时间），版权判定、备注、启停状态走同一条链；
  顺带修掉额外目录与链接记录指向同一文件时出现两份卡片的问题。
- **修正**（0.9.5-3）：`Free for commercial or non-commercial use` 被 `non-commercial`
  带偏成个人免费 → 新增英文「明确可商用」标记，在个人免费之前判定；
  个人免费的备注此前引不到原句，已补。

#### 验证（0.9.6 发布前真机回归）

- `cargo test` 71 通过（新增 `lone_woff_creates_staging_dir` 回归：落单 WOFF 导入
  必须自建 staging 目录）；`pnpm test` 54 通过。
- 真机抽样：Gobold Bold → 个人免费 + 备注留痕（原文「Personal use: FREE」）；
  Blue Highway Linocut → 商用免费；Tamanegi_Geki → 商用免费 + 渠道原文两行齐全。
- 真机：把未导入的测试字体丢进字库目录，点刷新即自动收编出现在列表；测完清理。
- 速览回归：Alt+` 收起/展开、光标感应、完整界面按钮往返全部正常。

## [0.9.5-3] — 2026-10-29

### 修正：`free for commercial or non-commercial use` 被误判成个人免费

- 9.5-2 把 `non-commercial` 归到「个人免费」后，`This font is freeware. Free for commercial
  or non-commercial use.`（Blue Highway 那类）被误判成个人免费——它其实是**允许商用**。
- 修法：新增 `OPEN_EXPLICIT_EN`（`free for commercial` / `commercial use is free` /
  `commercial use: free` / `free for any commercial`），在个人免费判定**之前**先认；
  中文仍按「不可商用里含可商用」的老顺序放在收费判定之后。
- 顺带修：`Reason::PersonalOnly` 之前没参与「找原文」，个人免费的备注引不到原句，现在补上。
- `NOTE_RULES_VERSION` 升到 3，装的旧自动备注会在下次扫描时按新口径重写。

## [0.9.5-2] — 2026-10-29

### 版权口径：「个人免费、商用收费」一律判「个人免费」

- **改动**（`copyright.rs` / `license.ts`）：`personal use only` / `non-commercial` /
  `not for commercial` / 「不可商用」「禁止商用」「非商业使用」「仅限个人」「仅供个人」/
  `Personal use: FREE` 等条款，从「收费」改为**「个人免费」**。用户口径：字体本身免费可用，
  只是商用要另购授权，标成收费等于把免费字体说成要花钱。
- 仍然算「收费」的只剩真要求付钱/试用的：`purchase a license` / `requires a license` /
  `buy the commercial license` / 试用 / 评估 / `shareware` / 「收费」「付费」。
- 备注依据新增一条文案：「写明个人使用免费、商用需另购授权「xxx」」，不再是笼统的「限制条款」。
- 判定口径带版本号 `NOTE_RULES_VERSION`：升级后旧自动备注自动作废、按新口径重写
  （只删「判定依据：/授权原文：」开头的，用户手写备注不动）。

### 修复：刷新按钮刷不出「直接放进字库」的字体

- **原因**：`scan_fonts` 只扫「系统字体目录 + 额外目录 + `state.linked` 里登记过的路径」。
  用户手动往字库文件夹丢的字体既不在 `linked`、也没人遍历 → 点刷新永远看不见。
- **修法**：扫描开头先 `discover_managed()` 走一遍字库目录（递归、跳过 woff/woff2），
  把没登记过的字体**自动收编**进 `linked` + `added`（记入库时间），之后走同一条解析链
  （版权判定、备注、启用状态一致）。已登记过的按大小写不敏感比较跳过，重复点刷新不会重复收编。
- 顺带修掉一个潜在重复：额外目录与 `linked` 指向同一文件时会出现两份卡片，现在按路径去重。

#### 验证

- `cargo test` 69 通过（新增 `discovers_fonts_not_yet_registered`、
  `personal_free_with_paid_commercial_is_personal`）；`pnpm test` 53 通过。
- 真机：往字库目录放入一个未经导入的测试字体后重启/刷新，日志出现
  「[scan] 字库里发现 1 个未导入的字体，自动收编」，`state.linked` 增加该路径，字体出现在列表；
  删掉测试字体与其 state 记录后恢复原状。

## [0.9.5-1] — 2026-10-29

### 版权判定改为「保守优先」+ 判定留痕写进备注

**背景**：用户要求「但凡不能百分百肯定，就不要随便设置版权」，同时希望能直接在软件里
看到判定依据是哪一段原文。

#### 改判定口径（`copyright.rs` / `license.ts`）

- **删掉三条误判来源**：① 单字「免费」直接判商用免费；② `"ofl"` / `"gpl"` 裸子串匹配
  （`Soflow`、`logo` 会中）；③ `"limited license"` 判限时。
- **新顺序**：① 许可证身份（OFL / Apache / MIT / BSD / CC0 / UFL / GPL / Arphic / IPA，
  短标记走词边界，认 `GPLv3` / `OFL1.1`）→ 商用免费；② 明确「个人免费」；③ 确凿的
  收费 / 受限 / 试用 / shareware；④ 明确「可商用」；⑤ 其余（只写免费 / free /
  保留所有权利）→ **未知**。
- **证据冲突不猜**：同一段文本既给开源许可又要求买授权 → 未知；同一目录两份授权文件
  说法不同 → 未知。
- **`may not be modified / redistributed`、`all rights reserved` 不再判收费**：这些讲的是
  分发，不是能不能商用（旧版冤枉了 8 个字面）。
- **name 表 14（许可证链接）终于用上了**：正文判不出来时，`scripts.sil.org/ofl`、
  `apache.org/licenses`、`creativecommons.org/publicdomain/zero`、`ubuntu.com/licence`、
  `gnu.org/licenses` 作为兜底证据。
- **编码兜底**：授权文件按 UTF-8 → UTF-16(BOM) → UTF-8 lossy 读。原来只认 UTF-8，
  记事本另存的 UTF-16 / GBK 中文授权说明直接被丢掉。
- 前端 `license.ts` 与后端逐条对齐（此前前端没有中文标记、没有词边界，两侧结论会不一致）。

#### 新增：授权渠道 + 判定依据 → 详情面板「备注」

- `usage_note()` 从授权文档里摘**原句**（不改写、不总结）：含渠道词（公众号 / 电商 /
  印刷 / LOGO / 游戏 / APP…）且 ±6 字内有授权口吻的句子，或「个人 / 企业……可商用」总述，
  最多 3 句、200 字。
- `inspect_dir()` 同时给出分类与留痕文本，备注形如：

  ```
  授权原文：此款字体无论是个人还是企业都可以免费商用
  判定依据：商用免费（开源许可证（sil open font license））｜原文「This Font Software is licensed under the SIL Open Font License, Version 1.1」｜来源：OFL.txt
  ```

  判不出来时同样留痕：`判定依据：未知版权（只写了免费，没写能不能商用）｜原文「免费下载，欢迎分享」`。
- 写盘新命令 `seed_license_notes` + `AppState.noteSeeded`：**只在该字族没有备注且从未
  自动写过时写一次**——用户改过不覆盖、删掉不复活。前端扫描结束后批量提交一次。
- 扫描侧同目录只读一次授权文件（`dir_info` 缓存），分类与备注一起带出。

#### 验证

- `cargo test` 20 项版权相关用例通过（含 5 项留痕用例）；`pnpm test` 53 通过。
- 按真实库 5461 个字面做新旧口径 A/B：仅 13 个变动（6 收费→未知、4 限时→未知、
  2 未知→收费、1 未知→商用免费），5448 个不变。
- 真机（0.9.5-1，4103 字族 / 5785 字面）：扫描 0.8 秒完成，**1946 个字族**自动写入备注，
  分布 未知 1700 / 收费 125 / 商用免费 121。抽样核对：
  - `Scheherazade` → 商用免费，原文「SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007」（name 表 13）
  - `Gobold` → 收费，原文「Commercial use: DONATE, mininal $10 USD…」（Readme.txt）
  - 大量西文 → 未知，「只写了保留权利 / 禁止转发，没说要收费」+ 原文「All Rights Reserved」

#### 两个必须记住的坑

1. **链接字体走的是另一条扫描分支**（`scan_fonts` 里的 linked 循环），原来**完全不判目录版权**，
   `copyright_class` / 目录里的授权说明对这批字体形同不存在。用户几千个字体几乎全是链接进库的，
   所以这个功能等于从未生效过。现在两条分支都做判定。
2. **平铺大目录不能按目录判版权**：把 4930 个字体放在同一个目录时，拿「目录里第一个字体的
   name 表」去判整个目录，会让 3922 个字族全被写成同一句无关的授权原文。
   修法：目录级只认**授权文件 + 目录名后缀**（`inspect_dir_files_only`），name 表证据改成
   逐字面判定（`inspect_face`），各字族只引用自己的原文。

## [0.9.5] — 2026-10-29

### 版本号统一提升到 0.9.5 + 发布

- 六处版本号（package.json / tauri.conf.json / Cargo.toml / Cargo.lock / README×2）由 `0.9.4-1` 统一提升到 **`0.9.5`**（前端 `src/lib/version.ts` 直接读 package.json，无需单独改）。
- 本版本包含 0.9.4 与 0.9.4-1 的全部修复：
  - **WOFF 智能判重 / 解包**：导入时 woff 与同名 ttf/otf 是同一字体则自动跳过；落单 WOFF1 解包还原成 sfnt（OTTO→.otf）强制入库；WOFF2 暂不支持，跳过并计数。
  - **修复「完整界面 → 速览」过渡顶栏闪现**：改为事件门控淡入（dock 接管后才显示内容），不再依赖固定时长动画。
- 发布 Windows NSIS 安装包 `ZFontManager_0.9.5_x64-setup.exe`，并同步更新 GitHub Release 与说明文档。

## [0.9.4-1] — 2026-10-29

### 修复：单独的 WOFF 解包时报「系统找不到指定的路径」

- **现象**（0.9.4 真机测试）：拖入/导入只含 `.woff` 的目录，弹
  「安装失败 — woff → ttf：系统找不到指定的路径。(os error 3)」，字体没进库。
  同名 ttf+woff 的判重分支正常，只有「落单 WOFF1 解包」这条路径失败。
- **根因**：解包产物先写到 `%APPDATA%\ZFontManager\staging`，而 staging 目录
  只会在 **zip 导入**分支里 `create_dir_all`。拖放/导入文件夹时该目录并不存在，
  `fs::write` 直接报 `ERROR_PATH_NOT_FOUND`。
- **修法**（`installer.rs::process_webfonts`）：解包前先 `create_dir_all(staging)`，
  失败不早退（后续 `fs::write` 会给出更具体的错误）。
- **真机验证**：只含 `ZfmLone.woff` 的目录 → 解包出 `ZfmLone.ttf`（61400 字节、
  文件头 `00010000`、`AddFontResourceW` 返回 1），字族卡片正常显示与预览；
  同名 ttf+woff 目录仍然只导入 ttf（toast「已跳过 1 个 WOFF」）；`.woff2` 目录
  跳过并提示，不产生任何安装项。

## [0.9.4] — 2026-10-29

### WOFF 智能判重 / 解包 + 速览切换闪现修复

- **导入自动判重 WOFF 与 TTF/OTF**（新模块 `webfonts.rs`）：Windows 的 GDI 字体机制
  根本不加载 WOFF/WOFF2（`AddFontResourceW` 必定失败），以前链进来的 woff 只能变成
  「永远无法启用」的死面。现在导入（含拖放、导入文件夹、zip）时：
  - woff 与同目录同名的 ttf/otf **是同一款字体**（对比 family、unitsPerEm、字形数，
    name 表一致的才认）→ 自动跳过 woff，保留适配最高的原生格式，导入结束弹
    「已跳过 N 个 WOFF」提示（`toast.webfontsSkipped`，9 语言）；
  - 落单的 WOFF1 → 解包还原成 sfnt（flavor 是 OTTO 就还原成 .otf）强制入库，
    转换文件没有源路径可链，与 zip 同规则走移动模式；
  - WOFF2 需要 Brotli + 变换表重建（glyf/loca/hmtx 转换编码），暂不支持，跳过并计数。
  - 扫描层同步加了零开销的路径级判重：同目录同名的 ttf/otf 在列时不再为 woff 建 face。
  - WOFF1 解包是完整的 sfnt 重建：表按 tag 排序、4 字节对齐、逐表校验和、
    head.checkSumAdjustment 按规范修正。
- **修复「完整界面 → 速览」过渡中速览顶栏闪现**（`QuickBar.tsx`）：原实现靠 qb-birth
  固定时长动画（挂载 300ms 延迟 + 200ms 淡入）压住内容，但 `adoptQuickbarDock` 有一段
  等挂载的轮询（最长 600ms），首屏上千张卡片的渲染还会堵主线程——动画一放完 dock 还没
  接管，morph 已清、docked 未置位的空档里，顶栏（已启用 N / 搜索框 / 完整界面按钮）就在
  34px 的窗口条里亮出来。改为**事件门控**：dock 接管后才淡入；几何失败走「仅切换界面」
  分支时由兜底计时器放行。删除 qb-birth 相关 CSS。
- 测试：`webfonts` 2 条新单测（WOFF1 解包回环 + 坏数据拒绝）；修正 `adobe` 一条
  断言 0.9.3 旧脚本结构的过时测试；cargo test --lib 54 通过、node --test 全过、
  check-locales 9 语言 100%。

## [0.9.3-13] — 2026-10-29

### 预热百分比不再来回跳、窗口圆角、网络环境记忆

- **底部预热百分比稳定了**（`warm.rs`）：原来每次复测都先把 `percent` 写成 50，界面每 90 秒就会
  从「100%」跳到「50%」再跳回「100%」，看起来像连接不稳。现在探测期间沿用上一次的结论
  （`Slot.stable` 与 `percent` 分离），只有从没成功过的才显示 50 这个「正在连」的中间值。
  另外**已经 100% 过的允许一次瞬时失败**：Photoshop 开大文件、弹模态框时 COM 会临时拒绝，
  以前立刻甩 0% 是误报，现在连续两次才判定掉线。
- **窗口四角改成系统圆角**（新模块 `window_round.rs`）：用 DWM 的 `DWMWA_WINDOW_CORNER_PREFERENCE`，
  和资源管理器、设置这些原生窗口同一套裁剪，半径与抗锯齿天然一致；不用把 html/body 改透明
  （那会让「速览 ↔ 完整界面」形变时露出桌面）。Win10 上属性不被支持，四角维持原样，无副作用。
- **速览细线态切直角**：速览收起后窗口只有 12 逻辑像素高，DWM 圆角是固定半径（约 8px），
  套上去会把整窗裁成胶囊、把抓手线两头切进圆角里——这就是「抓手线坏了」。现在
  `watch_height` 每 150ms 读一次窗口高度，矮于 24 物理像素就切 `DWMWCP_DONOTROUND`，
  线该什么样还是什么样；展开后自动切回圆角。
- **速览收起提示条文案居中**：`justify-content: center` + 文案不再占满剩余宽度，
  整组「圆点 + 文案」在条内居中（原来贴在最左边，右边空一大片）。文案比窗口还长时（俄语等）
  才收缩出省略号。
- **「raw 直连不可达」写进配置**（`net.rs` + `state.rawUnreachable`）：原来这个标记是进程内静态，
  重启后第一次在线请求又要先撞 10 秒 `raw.githubusercontent.com` 超时才切镜像，用户以为卡死。
  现在状态翻转时落盘（只翻时才写），启动时 `seed_raw_unreachable` 灌回去；网络恢复后自动清掉。
  实测：重启后打开 Lora 详情从 10 秒级的「加载中…」变成 1.2 秒内出内容。

## [0.9.3-12] — 2026-10-28

### 版权文件：导入时提醒、详情里标注、能按字体身份反查

- **详情面板新增「版权文件」行**：字族目录里有 `OFL.txt` / `LICENSE` / `版权说明.txt` 这类文件就直接列文件名；
  没有则显示「未找到」+「搜索版权文件」按钮；字面全在系统字体目录时显示「系统字体目录」（不往 `C:\Windows\Fonts` 写文件）。
- **导入后提醒**：`installPaths` 成功落盘后异步检查每个新目录，缺版权文件就弹一条 info 提示
  （`warnMissingLicenses`，只提醒，不挡导入、不改任何文件）。
- **新增 `font_license_fetch` 命令 + `search_license`**：按「族名 + PostScript 名」双严格匹配到上游取许可证：
  1. 族名必须与 `METADATA.pb` 的 `name` 完全一致（忽略大小写/首尾空格）；
  2. 必须有一个 PostScript 名与上游列表里的某一条完全一致 —— 这是同一款字体的身份证明；
  3. 正文长度 > 512 且含 `license`，防止把 404 页面写进字体目录。
  任一条对不上就返回「没搜到」，绝不猜。命中后把许可证写进该字族所有可写的目录，文件名沿用上游（`OFL.txt` 等），
  头部附来源、设计者与匹配依据（PostScript 名），方便事后核对。
- **快速否定**：先用本地在线目录筛一遍族名，商业字体（如 Helvetica Neue LT Pro）点搜索会立刻得到「没找到」，
  而不是去上游挨个试 6 次。
- 按钮提示文案「只有族名与 PostScript 名都完全一致时才会写入」，把判定标准直接摆在用户眼前。
- `Source Sans Pro` 这类上游已改名的旧条目，详情报错补上「该字体可能已在上游改名或下架」。

新增 14 个 i18n 键 × 9 语言；顺手补齐 ru 缺的 2 个 `quickbar.*` 键，并修掉 zh-CN/zh-TW
`toast.fontUnknownToAppSub` 占位符数量不一致（`i18n:check` 现在全绿）。
Rust 侧新增 3 个单测 + 1 个 `#[ignore]` 联网严格性用例（Lora 命中 / 错 PostScript 不命中 / 无 PostScript 不命中 / 已改名条目不命中）。

## [0.9.3-11] — 2026-10-28

### 在线栏目：只下缺的，不重复下载

之前不管按哪个按钮，都会把整个字族的字体文件重新拉一遍 staging（已有的只是跳过安装，流量照付）。

- **「补充版权文件」只下载许可证**：`online_download` 新增 `files` / `license` 两个参数，
  按钮按当前收录情况算出真正要下的文件；只缺版权时 `files=[]`，一个字体文件都不下。
- **「补全缺失 (n/m)」只下缺的字重**：`filesToDownload()`（`lib/onlineCoverage.ts`）按
  「斜体 + 字重 + PostScript 名」挑出字库里还没有的文件，已有的字重、已覆盖字重轴的可变字体都不再下载。
- **修复：补字重会把同一个字族劈成两个目录**。不带许可证时版权分类算成「未知版权」，
  安装目录名随之变成「族名（未知版权）」，和原有的「族名（商用免费）」并存。
  现在 `install_online` 优先沿用它找到的同族目录（目录名去掉「（…）」后与族名相等）。
- **修复：只补版权文件时不再凭空建目录**：已有字族目录非空时不新建空目录。
- staging 清理改为按「第一个待装文件」的父目录算，全部跳过时也能清干净。
- 下载范围写进 `activation.log`：`online[id]: N 个字体文件待下载（只补字库里缺的），license=…`。
- 上游改名或下架的目录条目（如 `Source Sans Pro` → `Source Sans 3`）详情会 404，
  报错补上「该字体可能已在上游改名或下架」的说明，不再只有一行 HTTP 404。

`npm test` 新增 4 个 `filesToDownload` 用例；顺手修正 `license.test.ts` 里 3 个停留在
`free` 旧枚举名的陈旧断言（现在是 `free_commercial`）。

## [0.9.3-10] — 2026-10-28

### 导览扩充（11 → 15 步）

把近几个版本新增的功能补进了新手导览（`Onboarding.tsx`），每步照常高亮对应区域：

- **按文字系统筛选**（`[data-tour="filters"]`，筛选按钮加了 data-tour 属性）：「中文」「日文」分开、只有字形真正覆盖该系统的字体才命中、覆盖不全标「汉字不全」
- **所有字重一目了然**（卡片）：点卡片展开字重、字重名大小跟随示例字号滑块、悬停字重大字预览立即切换、笔形按钮一键应用
- **缺字直言相告**（卡片）：画不出示例文字会直说；同族兄弟版本有中文时指路「中文见 XXX」
- **面板宽度随你调**（详情面板）：拖左边缘调宽、双击恢复；「字符集」行给出可核对的真实数字

9 个语言各补 8 个 `tour.*` 键（en / zh-CN / zh-TW / ja / de / fr / es / pt-BR / ru）。

无其他行为改动；导览邀请卡的步骤圆点数随 `STEPS.length` 自适应。

## [0.9.3-9] — 2026-10-28

> 由桌面会话录制（`desktop-session-recorder`）抓到的三条反馈促成：
> 「动画不同步」「点关于也一样」「跟详情相关的动画都卡顿」。

### 根因：一个 660ms 里同时发生了三种速度

用逐帧采样（27ms 一帧）量了「点卡片 → 详情面板打开」时两块区域的到位曲线：

| 时刻 | 主区域（工具栏/列表） | 右侧面板 |
|---|---|---|
| 54ms | 还是旧样子 | 还是旧样子 |
| **75ms** | **一帧内跳完**（差值 10.70 → 0.02） | 才开始滑入 |
| 486ms | — | 外壳到位 |
| 640ms | — | 内容还在逐块冒出 |

**布局 0ms、面板 300ms、内容 660ms**，三种速度叠在一起，观感就是「左边一哆嗦、
右边慢慢磨」。拆开看是三处独立问题：

1. `.detail` 是 flex item，`width: 348px` 固定，**它一挂载就占满布局**，主区域
   立刻被挤窄 —— 没有任何过渡。而面板自己的动画只有 `x: 348 → 0`（滑入）。
2. `detail-inner` 的 `staggerChildren: 0.04` + `delayChildren: 0.06`，18 个
   variants 子元素 → 最后一块比外壳晚 0.5 秒才出现。
3. 弹簧 `springSoft`（180/24）用在**布局宽度**上会过冲，A 区曲线出现
   2.46→6.98→3.87→6.00→7.61→3.17 的来回震荡。

### 改法

* **宽度参与动画**：`<motion.aside>` 的 `initial/animate/exit` 从 `x` 改成
  `width: 0 ↔ panelWidth`，用固定缓动 `easeTop`（200ms）而不是弹簧。主区域跟着
  逐帧收缩/展开，和面板是同一帧、同一条曲线。
* **内容定宽不重排**：`--panel-w` 写在 aside 上（`= panelWidth`），
  `.detail-inner` 用它做 `width`，展开途中只被裁出来、不逐帧换行。
  滚动从 `.detail`（改 `overflow: hidden`）移到 `.detail-inner`。
* **内容跟着壳一起到**：`staggerChildren` 0.04 → **0.012**、`delayChildren` 0.06 → **0**。
* **拖拽调宽跟手**：新增 `resizing` 状态，拖动期间 `transition={{ duration: 0 }}`，
  松手恢复 200ms。

### 实测（同样的采样脚本）

| | 修复前 | 修复后 |
|---|---|---|
| 主区域开始动 | 75ms（并且是瞬跳完成） | 与面板同帧启动 |
| 主区域到位 | 75ms（瞬跳） | ~259ms（平滑收窄） |
| 内容全部到位 | 660ms | ~400ms（长尾是字体预览异步加载） |
| 中间态帧数 | **0 帧**（没有过渡可言） | 6~8 帧连续插值 |

拖拽调宽、面板滚动、双击恢复 348 都复验通过。

### 已知遗留（未在本版处理）

TopBar 是 `flex-wrap: wrap`（宽度不够时换行成两排，注释里写明是为了不让按钮压到
面板上）。面板拉到 430~557px 之间跨过阈值时，动画中途会换行一次、列表整体下移 44px。
这是布局层的跳变，与本次修的面板动画无关；要彻底消除得给 TopBar 做「窄时收按钮」的
响应式收缩，属于独立改动。

## [0.9.3-8] — 2026-10-28

### 字重行的字号跟着示例文字走

展开卡片后的字重列表（Thin / Light / Regular …）原来固定 11px，示例文字拉到
96px 时那一列小得几乎看不清，比例完全失衡。现在字重名的大小由顶部的示例字号
滑块决定：**完整界面取 1/4，速览界面取 1/8**（速览面板只有卡片一半宽，比例要小一档）。

* 新增 `FaceLine.tsx::faceLineFontSize(previewSize, divisor)`，两个调用点各自把自己的
  容器换成 CSS 变量 `--face-line-size`（`.card-styles` 传 4，`.qb-faces` 传 8），
  `.face-line-name` / `.face-line-apply` 读这一个变量，样式仍然只有一套。
* **兜底 11px**：字号滑块最小 8px，除下来是 1~2px，会没法读。取
  `max(11, size/divisor)`，也就是任何档位都不会比改动前更小。
* 行右侧的笔形按钮同步缩放（`字号 + 10px`，svg 取字号 ×0.9），否则字放大了按钮
  还是 22px 一颗小点，看着像漏了缩放。
* 行高补 `1.3`：默认继承行高在 24px 文字下会散开，撑得列表过高。

实测（96px 档位）：完整界面字重名 24px、按钮 34px；速览 12px、按钮 22px；
8px 档位两处都停在 11px，行距无重叠、无截断。

## [0.9.3-7] — 2026-10-28

> 由「HarmonyOS Sans 明明有中文却标了无中文」这条反馈引出的一轮改造。

### 背景：那次判断其实是对的

`HarmonyOS_Sans_Regular.ttf` 只有 143 KB、866 个码位，cmap 里
`U+4E2D`（中）/ `U+56FD`（国）/ `U+6587`（文）/ `U+4E00`（一）的 glyph 全是 0。
华为这套包是按语言拆开的：`HarmonyOS_Sans/` 是西文基础版，中文字形在
`HarmonyOS_Sans_SC/`（8 MB）和 `_TC/`（4 MB）里，是**两个独立的 family**。
所以「无中文」没判错，错的是软件只说了「没有」，没说「中文在哪个版本里」。

但这轮确实挖出了三处真问题。

### 修复

- **纯中文字体拿不到「有中文」标记**（真 bug）。`SCRIPT_PROBES` 里 `cjk` 的探针是
  `[0x4E00, 0x3042]`——要求汉字和假名**同时存在**。纯中文（没有假名）的字体因此
  永远拿不到标记：详情面板的「书写系统」显示不出中文，筛选菜单里勾「CJK / 中文」
  也筛不出任何中文字体。现在拆成 `han`（汉字）、`kana`（假名）两个独立探针。
- **汉字判定口径太松**。原来「中国文」三个字命中 2 个就算有中文，只嵌了几十个
  汉字的字体（图标字体、只做标题字的展示字体、日文字体的汉字子集）也算「有中文」，
  用户拿它排正文才发现一片豆腐块。现在改成 97 个**简繁同形高频字**分层抽样
  （沿 U+4E00–U+9AD4 分散），命中 60% 才算 `full`，命中一部分算 `sparse`
  （卡片显示「汉字不全」），0 个算 `none`。抽样表与 Rust 端 `parser::HAN_SAMPLE` 同源。
- **「未知」版权标签没有归因**。这轮核对发现 HarmonyOS Sans 全系列 48 个 ttf 的
  name 表里根本没有 nameID 13（license）/ 14（licenseURL），华为把许可单独放在了
  压缩包的 `字体授权说明.txt`，所以标「未知」是准确的，本轮不改。

### 新增

- **同族版本指路**（缺中文时）。整族一个汉字都没有、但同名前缀下另有含中文的版本时，
  卡片上的「无中文」后面补一句「中文见 HarmonyOS Sans SC」。优先级：SC / CN / GB /
  Hans → TC / TW / HK / Hant → 其他；只推荐 `full` 的版本（`sparse` 推过去等于让用户
  踩另一个坑）。只在真的缺中文时查询，结果按家族名缓存。
- **详情面板显示字符集统计**：新增 `font_charset` 命令，枚举 cmap 全部码位，给出
  「字符集：866 字符 · 汉字 0」这样的硬数据，让判断从「一个结论」变成「可核对的事实」。
  按需调用（打开详情时算一次），不参与扫描。

### 变更

- 字体缓存 `CACHE_VERSION` 1 → 2。老缓存里纯中文字体没有 `cjk` 标记，无法就地迁移，
  **升级后第一次启动会重新解析整个字体库**（一次性的），之后恢复缓存速度。
- 筛选菜单里的「CJK」拆成「中文」「日文」两项。

### 验证

- 抽样表在真机字体上的命中率：微软雅黑 / 黑体 / 宋体 / 微软正黑 / 日文 YuGothic /
  韩文 Malgun / 鸿蒙 SC / 鸿蒙 TC 全部 **97/97 = 100%**；Arial / Segoe UI / Consolas /
  鸿蒙基础版 / 鸿蒙阿拉伯版全部 **0/97**。
- 全库随机抽 320 个字体：`none` 264、`full` 54、`sparse` **0**——60% 阈值没有误伤任何
  现有字体，中间态在这个库里不存在。

## [0.9.3-6] — 2026-10-28

> 全功能回归测试（完整界面 / 速览界面 / 右键菜单 / 切换动画 / 系统级热键）后的小修。

### 修复

- **录制速览快捷键时，按下 Ctrl / Alt 会被误当成「组合键已确定」**。原来的判断是
  「按下的键是修饰键、且 ctrlKey/altKey/metaKey 都为 false 才算只按了修饰键」，
  但按下 Ctrl 的那一刻 ctrlKey 已经是 true，于是 Ctrl 键自己的 keydown 直接被采纳，
  录出来是「Ctrl + Control」这种没有主键的组合——用户想录 Ctrl+Shift+K 必然踩到，
  而且设置里显示出来的组合跟真正注册的完全不是一回事。
  现在改成「按下的键本身就是修饰键（Shift/Ctrl/Alt/Win）就一律先等着」，主键按下时才定稿。
  录出来的是 `Ctrl + Alt + M` 这种真正带主键的组合。

### 测试

- 完整界面：侧栏 7 个分类、搜索/清除、示例文字替换、字号滑块、筛选、排序（名称/样式数/文件大小）、
  视图切换、对比、导入、重新扫描、卡片展开字重、笔形菜单、复制字体名/路径、右键菜单全项、
  星标收藏、启停开关、详情面板（字号列表 / OpenType 特性 / 启停 / 快照开关 / 重置 / 全部导出）、
  标题栏（进速览 / 设置）、设置面板、侧栏分组+快照+回收站+关于+快捷键面板。
- 速览界面：搜索与计数联动、清除、字号 8–96px、排序、示例文字、字重面板、笔形菜单、
  右键菜单全项、点击标题复制家族名、自动隐藏开关、完整界面按钮、最小化与热键恢复。
- 切换动画：完整界面 → 速览为原生 300ms 逐帧形变（24 帧连续插值，尺寸与位置同步）；
  速览内细线 ↔ 面板为多段渐变；速览 → 完整界面按设计走「先隐藏再显示」，不暴露大跨度跳变。
- 系统级热键 Alt+`：进速览、速览内展开/收起、最小化后恢复全部正常。

## [0.9.3-5] — 2026-10-28

> 版本号按用户要求跳到 0.9.3-5（0.9.3-4 未出包）。本版内容 = 下面这条缺字提示的改动，
> 加上版本号对齐；功能与 0.9.3-3 一致。

### 变更

- **缺字提示改成「顶替示例文字」而不是「贴在旁边」**。0.9.3-2 把「无中文」放在预览行末尾，
  卡片一宽就飘到右边缘；更根本的问题是：字体明明画不出这两个字，预览里却还在用回退字体
  显示「你好」，看着像支持。
  现在只要这个字重画不出示例文字里的某种文字，**那一格就不再显示示例文字，直接显示标注**：
  - 完整界面：主卡片预览行、展开后的每个字重行；
  - 速览界面：卡片第二行的示例文字同样被顶替。
  - 标注沿用「这种格式暂时无法预览」那种**灰色小字**（不加边框、不抢眼），文案跟着示例文字的
    语言走（无中文 / 无日文 / 无拉丁 …），悬停提示里列全缺的几种；只有「真的缺」才顶替，
    字体加载失败时仍旧显示「这种格式暂时无法预览」。
  - 三处的标注都比原来那行字矮，所以都补了最小高度：换字的一瞬间卡片不会缩一下。

### 变更（字重区统一）

- **完整界面展开后的字重区改成和速览界面一模一样**（用户要求）。两处现在共用同一个
  `components/FaceLine.tsx`，样式统一在 `.face-line / .face-line-name / .face-line-apply`，
  以后不会再各写一套：
  - 行内只留「字重名 + 缺字提示 + 笔形按钮」，**不再重复渲染示例文字**——鼠标划过这一行时
    卡片主预览就切到该字重，行里再放一份「你好」纯属重复，还把列表撑得很高；
  - 悬停效果统一成「左侧 2px 竖条 + 整行底色」，原来是只有竖条亮、没有底色；
  - 行尾按钮从 `⋯` 换成速览那颗笔形图标（点开的是同一个字重菜单）；
  - 字重列表整体更紧凑，展开后卡片高度明显变小。
  - 旧的 `.face-row / .face-marker / .face-style / .face-sample / .face-tail / .face-actions`
    等样式随之删除，避免两套规则互相打架。

## [0.9.3-2] — 2026-10-28

### 修复

- **「这种格式暂时无法预览」的字体其实能正常显示**。库里有 270 个字面在 WebView2 里
  必然加载失败，卡片上只剩一行提示。逐个查 OTS 报错，是几类问题叠在一起：
  - **`.ttc / .otc` 字体集合**：Chromium 直接拒收 ttcf 容器（`Invalid TTC version`），
    哪怕里面每个字面都完好；
  - **cmap 只有旧编码子表**：Big5 / GBK / ShiftJIS / Wansung / Mac Roman 这些 OTS 全不认
    （`no supported subtables were found`）。库里 105 个是 GBK 的 cmap format 2；
  - **cmap 里有脏映射**：指向 `numGlyphs` 之外的「字形号」，OTS 判 `Range glyph reference too high`；
  - **其它畸形表**：`maxp` 的 maxZones 写成 7、`head`/`hhea` 版本号写成 2、`post` 版本非法、
    零长度表、`vmtx` 覆盖不到全部字形。

  现在加载失败时会向后端要一份**能加载的副本**：把字面从集合里抽出来成独立 sfnt，
  用系统代码页（936/950/932/949）把旧编码翻成 Unicode，重建 (3,1) format 4 +
  (3,10) format 12 的 cmap，顺手纠正上述几个字段，写到
  `%APPDATA%\ZFontManager\preview-cache`，前端拿它重试一次。
  **原字体文件全程只读，一个字节都不改**。缓存按「mtime + 大小 + 字面序号 + 算法版本」命名，
  目录总量封顶 384 MB，超了淘汰最久没用的。

  全库体检（270 个字面）：266 个修复后能正常加载渲染，剩 4 个
  （金梅海報大豆豆字 / 金梅海報書法字形 / 雅坊美工13 / GNIU00B）是 `glyf` 数据本身损坏，
  重写字形风险太大，仍旧显示「无法预览」。

### 变更

- **「无中文 / 无日文」标签从卡片头挪到预览行**：挂在名字后面会挤掉「样式数」和启用开关，
  而且离示例文字太远；现在贴在预览文字右侧，预览本身失败时也紧挨着那行提示。

## [0.9.3-1] — 2026-10-28

### 新增

- **示例文字的语言覆盖标注**：顶栏「示例文字」输入框里的内容会先判出用到哪些书写系统
  （中文 / 日文 / 韩文 / 拉丁 / 西里尔 / 希腊 / 阿拉伯 / 希伯来 / 泰文 / 天城文），
  再逐个字面查有没有对应字形；缺哪种就在**完整界面的字族卡片、卡片内字重行、速览卡片、
  速览字重行**上标出来（如「无中文」「无日文」），样式沿用原来的「无中文」小胶囊。
  判定口径与「无中文」一致：每个书写系统 3 个常用探针命中 2 个才算支持——探针是固定的，
  所以输入里的生僻字不会把一款正常字体误判成缺字，用户逐字打字也不会让几千个查询反复失效。
  新增命令 `font_coverage`（`parser::face_glyph_hits`）。用户没输入示例文字时不标注。

### 修复

- **吸顶判定的单位混用**：`useQuickbarDock` 的 `measure()` 把 `outerPosition()` 除以 scale
  换成逻辑像素后，又拿**物理像素**的 `workArea.position.y` 去减。任务栏在底部时
  `workArea.y = 0` 恰好算不歪，但**任务栏置顶 / 多显示器纵向排列**时差值会直接顶出容差，
  吸顶、贴顶收起、贴顶展开会整体失效；另外 `setPosition` 也把这个物理值当逻辑坐标写回，
  对齐会偏 `edge × (scale−1)` 像素。现在 edge 先除以 scale 再参与比较与定位。

## [0.9.2-5] — 2026-10-28

### 修复

- **「明明装了却找不到字体」**：全库比对（5819 个字面 × Photoshop 6075 / Illustrator 5917 条字体记录）发现，
  352 个「已激活但名字对不上」的字面里，**85 个只是写法差异**——
  字体文件里写 `D3 Euronism`，PS/AI 里登记成 `D3-Euronism`（空格 vs 连字符），
  反过来 `Graverplate Regular` / `Graverplate-Regular` 也有。
  现在应用时会构造一组候选名（原名 / 空格↔连字符 / 去掉分隔符 / 字族名 / 族名+字重），
  先用 `app.fonts.getByName` 找到目标软件真正认的那个再赋值。
- **失败提示讲清楚原因**：字体列表是目标软件启动时加载的，运行中新启用的字体它并不知道。
  `font-not-found` 的提示现在会说明「重启一次目标软件再试；重启仍不行说明该文件不被它识别」。

### 排查结论（本机实测）

| 分类 | 数量 | 占比 | 说明 |
|---|---|---|---|
| 名字完全对得上 | 4875 | 83.8% | 直接可用 |
| 未激活 | 388 | 6.7% | 应用时会自动整族启用 |
| 激活了但名字对不上 | 349 | 6.0% | 其中 85 个是写法差异（本次已修） |
| 没有 PostScript 名 | 141 | 2.4% | 只能靠字族名回退 |
| 只有一方认识 | 63 | 1.1% | PS/AI 字体表不同步 |
| woff / woff2 | 3 | 0.1% | 系统无法安装，必然不可用 |

## [0.9.2-4] — 2026-10-28

### 修复

- **部分字重「点了没反应」**：字重级应用时，脚本里的回退名传的是 `"字族 字重"` 这种组合串
  （比如 `思源黑体 Bold`），可 PS / AI / CorelDRAW 的字体表里根本没有这个名字，
  PostScript 名一旦不被识别就再也找不到 → 报 `font-not-found` / `font-rejected`。
  现在前后端多传一个**真正的字族名**，脚本的回退顺序变成 PostScript 名 → 字族名 → 组合名。
- **应用字重会让底部预热条「刷新一下」甚至变红**：预热心跳每隔一段时间探测一次 PS / AI 的
  对象模型，而应用字体也要占一次 COM，两边撞在一起时探测容易超时被判定为失败。
  现在**应用成功后把该软件标记为「刚刚探测过」**，心跳安静一个新鲜期，并清掉失败态。

### 新增

- **字重选中态**：卡片展开后点某一行字重 = 用这个字重预览（主预览、字形示例、族名都会跟着换），
  该行左侧亮起竖条、底色加深，样式名旁边标「预览中」。速览里的字重行同理；
  复制字体名等操作改走右键菜单（点行不再直接复制，避免「不知道点了会发生什么」）。

## [0.9.2-3] — 2026-10-28

### 新增

- **每个字重可以单独右击**：卡片展开后的字重行、速览里展开的字重行，直接**右击**就弹出该字重自己的菜单
  （应用到 Photoshop / Illustrator / CorelDRAW、复制字体名、复制 PostScript 名、复制路径、在资源管理器显示）。
  右击区域是整行，不用再去找那个小按钮；行尾的「⋯」保留，作为可点击的等价入口。
- **顶栏示例框优先显示真实字体**：`Hello` 那个输入框现在用真实字体渲染（优先用当前选中字族，
  没选中就用第一个字族）。它比卡片先挂载，所以字体最先加载出来——一进界面就能看到「字体在出来了」，
  卡片随后按虚拟滚动一屏一屏补上。

## [0.9.2-2] — 2026-10-28

### 新增

- **字重可以单独应用**：一个字体族里每个字重都有自己的 PostScript 名（如 `SourceHanSansSC-Bold`），
  以前右键只能整族套用（用的还是 Regular 那一个），想给选中的文字单独换粗体做不到。
  - 完整界面：展开字重后，**每个字重行尾**多了一个「⋯」按钮 → 应用到 Photoshop / Illustrator /
    CorelDRAW、复制字体全名（`字族 字重`）、复制 PostScript 名、复制文件路径、在资源管理器显示。
  - 速览界面：字族卡片右侧的字重数量变成**可点开**（和完整界面同一套展开逻辑），展开后每个字重
    单独一行：点名称复制该字重的字体名，右侧画笔按钮弹出同一份字重菜单。
  - 右键菜单**没有**新增条目（保持原样），字重操作只在展开后的字重行里。
- **扫描时边读边显示**：原生侧每解析 120 个字面就把这一批推给前端（`scan:batch`），
  界面「读到多少显示多少」，不再等整库扫完才一次性铺出来——启动观感快很多。
- **热键呼出的面板停留 1 秒**：按快捷键叫出速览后给 1 秒观察期，这期间鼠标没进面板就自动收起；
  鼠标进来了就转成正常模式（之后移出静置再收）。

### 修复

- **「读取 100% 之后字体还不出来」——真正的元凶找到了**：
  进度条统计的只是「扫描目录里的字体」（这台机器 301 个），而通过「链接」方式导入的字体
  有 **5416 个**躺在目录之外，原来每个启动都要**逐个重新解析、完全不走缓存**。
  实测冷启动这一段要 **11.27 秒**——进度早就 100% 了，用户当然觉得卡住。
  - 链接字体现在同样走解析缓存（按 路径 + 修改时间 + 大小），并边解析边推给界面。
  - 缓存落盘改成**合并写**：扫描目录与链接字体是两次独立扫描，各自只知道自己见过的路径，
    直接覆盖会把对方那一半抹掉。
  - 注册表探测改为与扫描**并行**（原来串行排在扫描之后）。
  - 实测（同一台机器、5819 个字面）：冷启动 **12.39s → 1.00s**（链接字体 11.27s → 0.56s、
    目录解析 949ms → 111ms）。
- `restoreLastActivation` 恢复上次激活时不再整库 `rescan()`（注册表刚写完又重扫重判，
  界面会在 100% 之后再闪一次骨架屏），改成直接把对应字面在本地标成激活。

## [0.9.2-1] — 2026-10-28

### 新增

- **速览快捷键可自定义**：Alt + ` 是写死的，一旦和别的软件撞键就没有退路。现在设置 → 系统里
  多了一个「速览快捷键」按键框：点一下进入录制（边框亮起并轻微呼吸），按下想要的组合即可生效，
  旁边还有「恢复默认」。录制时 Esc 取消；只按修饰键会等主键；纯字母/数字不带 Ctrl / Alt / Win
  的组合会被拒绝（否则等于把正常打字抢走），F1–F24 允许单独使用。
  - 前后端共用一份配置：前端 `lib/hotkey.ts`（虚键码 + 修饰键 + 展示名）负责匹配与录制，
    原生侧 `window_dock.rs::HotkeySpec` 用同一份数据 `RegisterHotKey`，语义完全一致
    （用 `keyCode` 而不是 `key`，中文输入法下也不会跑偏）。
  - 改键走 `set_quickbar_hotkey` 命令：热键注册绑在消息泵线程上，命令只能
    `PostThreadMessage` 叫醒它重新注册；新组合被别人占用时会明确提示「快捷键注册失败」，
    而不是变成一个按了没反应的死键。
  - 启动时从 `prefs.quickbarHotkey` 读取并注册，重启后保持。
- **「在完整界面按快捷键唤出速览」开关（默认开启）**：关掉之后，停在完整界面时按快捷键
  不再跳转到速览（适合把这个键分给了别的软件的用法），但**在速览里仍然可以**用它
  展开 / 收起面板。

### 修复

- **热键唤出的速览可能拿不到键盘焦点**：Windows 的前台窗口锁会拒绝后台进程
  `SetForegroundWindow`，原来只靠 Tauri 的 `setFocus()`，经常静默失败——面板明明弹出来了，
  接着按 Esc / 打字却全落到别的软件里（实测「热键唤出 → 立刻 Esc」三次里有一次收不回去）。
  新增原生命令 `focus_quickbar`：`AttachThreadInput` 临时挂到前台线程的输入队列后再
  `SetForegroundWindow` + `BringWindowToTop` + `SetFocus`，必达；失败才退回 `setFocus()`。
  修后同一套「5 次急速连切」连跑 3 轮，全部精确回到基线。

### 说明

- 速览里的提示文案（"靠近或按 xxx 展开"）会跟着用户设置的按键变化，不再写死 Alt + `。
- 版本号规则：本项目用 semver，但小修按「最后一段加一」递进（0.9.2-1 → 0.9.2-2 → 0.9.2-3 …），
  下一轮功能版本再进到 0.9.3。

## [0.9.1] — 2026-10-28

### 新增

- **系统级 Alt + `（全局热键）**：原来这个快捷键挂在前端 `keydown` 上，只有本软件有焦点时
  才生效——窗口收成屏幕顶端一条、或者用户正在别的软件里时，按了完全没反应。
  现在原生侧用 Win32 `RegisterHotKey` 注册成全局热键（独立线程跑 `GetMessage` 泵，
  `MOD_NOREPEAT` 防连发），任何软件在前台都能把速览拉下来：
  停在完整界面 → 切进速览并直接展开；停在速览 → 展开 / 收起切换。
  注册失败（被输入法之类抢走）只打日志，界面内快捷键照旧可用。
- **启动进度百分比**：完整界面底部与速览底部各加一条进度（`.load-progress`），
  显示「正在读取字库 done/total · 百分比」，读不完还有骨架屏；九种语言文案同步补齐。
- **启动时立刻亮窗口**：原来窗口是「前端 `init()` 全部跑完才 show」——几千个字体扫完前
  用户对着空桌面等，什么反馈都没有。改成原生 `setup` 里直接 `show()`，
  启动 1.4 秒内就能看到骨架屏 + 进度条（勾了「启动时最小化」则仍保持不弹窗）。
- **字体解析结果缓存**：`fontcache.rs` 按「路径 + 修改时间 + 大小 + 来源」记住每个文件的
  解析结果，没改过的字体下次扫描直接复用，只解析新增 / 改动的文件。
  缓存落盘放在后台线程，扫描结果先交给界面；`active` / `added_at` 这类运行时字段
  仍由 `scan_fonts` 重新合并，不会被缓存里的旧值污染。

### 修复

- **速览界面能拖放导入字体**：速览是「查字体名 / 复制」的浮层，把字体文件拖进去就开始
  往字体库里装，完全是意外行为。现在速览挂一个空监听把窗口级拖放事件吃掉，
  `DropZone` 里的导入入口也加了 `quickbar` 状态判断。
- **快速反复切换速览 / 完整界面后窗口停在半路**：两边都是几百毫秒的多段异步操作
  （形变 → 藏窗口 → 换界面 → 摆几何 → 再显示），而 `quickbar: true/false` 是在流程
  **中段**才翻的，于是「连点 / 连按」能让两套流程同时跑：一套收窗口、一套摆几何，
  最后停在「宽度已经是速览的、位置还留在主界面」的错乱态。
  - 切换串行化：`quickbarBusy` + `quickbarWant`，同一时刻只跑一个流程，
    期间的新请求只记「最终想去哪」，跑完再补一趟。
  - 进入速览的形变结束后**显式落一次终态几何**（`setSize` + `setPosition`），
    不再依赖动画逐帧写成功——窗口被遮挡 / 刚被隐藏过时个别帧会被系统吞掉。
  - 退出速览显示窗口后**读回校验**几何，对不上就补写，避免「人回到完整界面、
    窗口还留着速览尺寸」。
  - 真机验证：5 次连按 × 3 轮，每次收尾都精确回到 1280×820。

## [0.9.0] — 2026-10-27

本版本由 0.8.28 + 0.8.29 的修复汇合而成，并通过了万级字体的导入与千级字体的批量启停压测。

### 变更

- 版本号进入 0.9.0：字库导入、批量启停两条主链路都完成了大容量压测。

### 压测结论（真机）

- **一次性导入 5873 个字体文件（文件夹导入，链接模式）**：全程无崩溃，进程存活、内存稳定。
- **批量启用 / 停用千级字体（1639 字族/1981 文件启用；2244 字族/约 3232 文件停用）**：
  无崩溃；修复后**批量期间界面全程可响应**（数百次采样 0 次无响应），侧栏计数实时变化。
  批量耗时主要花在 GDI 装载与逐个解析字体文件（磁盘 I/O），属固有成本。

## [0.8.29] — 2026-10-27

### 修复

- **一次性启停上千个字体会把界面整个卡住（几千个要二三十分钟）**。压测时发现的：
  批量启停走的是同步命令，跑在主线程上，而且**每个字体**都要
  ① `user_entries()` 把 HKCU 字体表全量枚举一遍（批量自己还在往里写，越跑越慢 → 整体 O(n²)）、
  ② 再 `SendNotifyMessage(HWND_BROADCAST, WM_FONTCHANGE)` 广播一次。
  实测 5000 级批量只有 ~2.5 个/秒，窗口直接「无响应」。
  - 批量改为 `async` + `spawn_blocking`，在主线程之外跑，界面不再冻结（`Store` 包一层 `Arc`）。
  - 新增 `registry::RegCache`：一次批量只枚举一遍注册表，写入/删除时增量维护索引，
    `names_for` / `is_machine` / `unique_name` 全部 O(1) 复用。
  - `WM_FONTCHANGE` 只在整批结束后广播一次（`activation::sync_batch`），
    单个字体启停的路径不变，仍是每改一个广播一次。

## [0.8.28] — 2026-10-27

### 修复

- **速览贴在屏幕顶边时，点「最小化」/ 从任务栏还原的那两段系统动画很难看**。
  贴顶时窗口只剩一条十几像素高的细线，Windows 会从这个又扁又宽的位置播一段
  「飞到任务栏」的最小化动画，还原时又从任务栏「放大」回来。
  现在只有「贴着屏幕顶边」这一条路径改掉（不在顶边仍是系统默认动画）：
  - **最小化**：先把内容向上卷走并淡出（`.qb-content` 的 `qb-roll-up`，160ms），
    再把窗口一步压成细线，然后给这个窗口设上 `DWMWA_TRANSITIONS_FORCEDISABLED`
    并**真最小化**——没有飞行动画，看起来就是「收起来 → 直接消失」。
  - **还原**：因为最小化前窗口已经是细线，且 DWM 过渡仍关着，所以还原时没有放大动画，
    那条透明抓手栏**在原地直接出现**；拿到焦点 300ms 后把 DWM 过渡开回去，
    不影响别的窗口行为。
  - 新增原生命令 `set_window_transitions`（`window_dock.rs`），逐窗口开关，
    不碰系统全局的动画设置；`dwmapi` 只用一个函数，直接 extern 声明，
    没有为此给 `windows-sys` 加 `Win32_Graphics_Dwm` feature。

### 说明

- 0.8.30 / 0.8.31 里对「速览收起 / 展开」的改动全部回退，吸顶收起仍然是原来那套
  （提示条 → 细线）；这次只加最小化 / 还原这一条路径。

## [0.8.27] — 2026-10-27

### 修复

- **CorelDRAW 预热指示条一直卡在 0%（就是「一直链接不上」）**：常驻 COM 宿主其实每次都在
  1 秒内就绪，但握手那一步拿宿主回复的 **base64 文本**直接跟 `"ready"` 比较，永不相等，于是
  每次都要干等满 10 秒判定「握手超时」→ 状态回落成 0%。后果不止是那个百分比：每次应用字体
  都退化回一次性脚本，用户点一下要等四五秒。现在先解码再比对，宿主复用恢复正常
  （`%TEMP%\zfontmanager-comhost.log` 里能看到 `spawn: ready in xxxms`）。
- **已经开着时再点桌面图标，什么也没发生（还会多出一个任务栏图标）**：加入单实例守卫。
  第二个进程只负责把 `Local\ZFontManager.Activate` 事件拍一下然后退出，已经在跑的那个实例
  收到后**退出速览 / 还原几何 / 显示并聚焦**，直接回到完整界面。不再出现两个一模一样的图标。
- **速览界面在任务栏里留着一格**：进入速览时窗口设 `skip_taskbar`，回到完整界面才恢复——
  速览是常驻悬浮面板，收起来就剩屏幕顶端一根线，不该在任务栏占位。
- **提示条「速览已收起 · 靠近或按 Alt + ` 展开」是硬消失的**：原来是到点直接切到细线状态
  （提示行一帧消失，窗口再自己变矮），看起来像被一刀切掉。现在多一个 `retract` 过渡阶段：
  提示行向上滑走并淡出、底色与边框同时淡成透明、那条线同时从 46px 摊成整宽，260ms 走完
  才落定成细线。

### 说明

- 本轮改动来自 17:16 那次操作录制（3 条 bug 全部在数据里对上了：握手超时日志连续 20 次、
  任务栏残留、`500x15@1198,0` 的提示条几何）。

## [0.8.26] — 2026-10-27

### 修复

- **CorelDRAW 应用字体偶发「启动超时」**：宿主在 CorelDRAW 忙过一次之后可能攥着一个卡死的
  COM 连接，原来会一直等到 25 秒超时再报一句误导性的「启动超时」。现在：APPLY 超时从 25s
  降到 12s，超时后**丢掉宿主重建并自动重试一次**（实测新连接 0.6 秒就通），两次都超时才报
  「CorelDRAW 没有响应」，并给出「可能在弹窗/导出/渲染大图」的解释。预热重试从 4 分钟延长到
  10 分钟，避免开机 10 分钟后才用就又冷启动。`%TEMP%\zfontmanager-comhost.log` 会记录每次
  握手/预热/应用的耗时，方便下次定位。
- **窗口变窄时顶部工具栏压到详情面板标题上**：`.topbar` 改为可换行，窄窗口下工具栏自动折成
  两行，不再溢出到右侧详情面板；详情面板标题补 `min-width: 0`，字体名过长时老老实实省略号。
- **导入快照后「字体像没导进来」说不清**：导入提示现在会明确给出结果——「共 N 个字体，本机
  都有」或「共 N 个，其中 M 个本机没有（快照只记清单，不含字体文件）」。

### 新增

- **底部预热指示条**：完整界面与速览界面最下方，只显示当前**正在运行**的 Photoshop /
  Illustrator / CorelDRAW，用百分比表示预热进度。100% = 在那边替换字体不用等；连不上会标红。
  纯展示，不响应点击。

## [0.8.25] — 2026-10-27

### 修复

- **在 CorelDRAW 中应用字体太慢（约 5 秒 → 约 0.2 秒）**
  根因不是脚本本身，而是 CorelDRAW 自动化对象图的「首次访问税」：在同一个进程里实测
  `ActiveDocument` 首次 0.9 秒、`ActiveSelectionRange` 首次 1.0 秒、
  `shape.Text.Story` 首次 1.7 秒、`story.Font` 首次 0.9 秒，合计约 4.5 秒；
  而同一个对象第二次访问只要 20~50 毫秒。0.8.24 虽然已经做到「拿到结果就杀掉子进程」，
  但每次点击仍然新起一个 PowerShell，于是这份税每次都要重交一遍。
  现在改为**常驻 COM 宿主**（`src-tauri/src/comhost.rs` + `comhost.ps1`）：一个长期存活的
  `powershell -Sta` 进程把 CorelDRAW 连接攥在手里，应用启动后在后台完成预热（含对象图预touch），
  用户真正点下去时只剩热路径。实测：预热后连续应用字体为 **190~230 毫秒**。
  宿主起不来 / 崩溃 / 管道断开时自动回落到原一次性脚本，功能不会整体失效。
- **`Get-FailCode` 在字体很多的机器上会拖慢失败路径**：原来把整个 `FontList` 逐个塞进数组
  再遍历，是 O(n²)；改成哈希表比对并提前短路。安装上万字体时这段本来能耗掉数秒。

### 变更

- CorelDRAW 宿主进程在应用退出时显式结束，不会残留在后台。

## [0.8.24] — 2026-10-27

### Fixed

- **「速览细线最小化后彻底卡死，点它、划过它都不再展开」。** 录制器抓到的确定现场：
  点任务栏把细线最小化后，Windows 把窗口挪到 `-32000,-32000`，`onMoved` 照样触发，
  `measure()` 量出来「离屏幕顶边十万八千里」→ 状态机判定「用户把窗口拖走了」→
  解除吸顶、走展开动画。可最小化时 `setSize` 是无效的，展开尺寸一个字都写不进去，
  于是状态机停在「未吸顶、已展开」，窗口却还是 15px 细线——`onEngage` 走不到
  `expand()`（要求已吸顶），`onPointerMove` 也提前 return（要求已吸顶），彻底没入口。
  现在三道防护：
  - `measure()` 增加 `isMinimized()` 判定，并把 `-32000` 这类哨兵坐标当「量不到」，
    最小化途中不再产生假位置；
  - 「离开顶边」不再只看一帧，等 `SETTLE_MS` 后复测确认，且拖动中不响应；
  - 新增 `healGeometry()` 自愈：状态说已展开、窗口却不到展开高度的一半时把尺寸补写回去，
    点一下窗口、切回焦点、拖动结束都会触发，任何来源的状态/几何脱节都能自己爬出来。
  - `collapse()` 遇到「已经在提示条高度以内」不再静默 return，而是把吸顶状态接回去，
    避免留下同样的死局。
- **「细线悬停不再自动展开（必须先点一下）」。** 上一版用「窗口当前有没有焦点」当门控，
  结果在别的软件里用鼠标划过细线永远不展开，等于把常驻入口废掉。改为时间窗门控
  `REVEAL_AFTER_BLUR_MS`（失焦 600ms 内不响应，之后照常展开）：既不会「点到别处→
  立刻收起→马上弹回」，也不用先点一下。
- **「速览拖动结束后没有被重新判定」。** `useWindowDrag` 松手后不再有 move 事件，
  吸顶状态机拿不到最后一帧。现在松手会派发 `zfm:window-drag-end`，拖离顶边会正确地
  解除吸顶、拖回顶边会重新吸住。
- **「卡片上『N 种样式』在窄窗口里变成竖排、压住右侧徽标」。** 中文标签在 flex 行里
  没禁止换行，被挤压时按「每个字」折行成一列竖字。`N 种样式` 加 `white-space:nowrap`，
  卡片标题改走省略号收缩。
- **「在 CorelDRAW 中应用字体太慢（4~7 秒）」。** 分段计时：工具自身 77ms、挂 COM 32ms、
  等就绪 951ms、读选中 968ms，脚本本体约 2 秒；剩下 5~7 秒全花在 **PowerShell 退出时
  释放 CDR 的 COM 对象**上。改为边跑边读 stdout，结果行一出现就结束子进程，不再等它优雅收尾。
- **「在 CorelDRAW 中应用没反应，提示找不到字体」。** 真机逐项对照确认：CDR 拒绝给
  **纯中文文字**套**西文字体**（`Story.Font`、`Characters.All.Font`、`Characters.First.Font`
  三种写法全部静默忽略，也不抛异常），只有含中文字形的字体才写得进去；中英混排则正常。
  旧代码读回比对失败后一律报「找不到字体」，误导用户。现在区分 `font-not-found` 与
  `font-rejected`，后者提示「该字体覆盖不到这段文字的字符（常见于给中文文字套西文字体）」。

### Changed

- 新增 9 语言的 `toast.fontRejected` / `toast.fontRejectedSub` 文案。

## [0.8.23] — 2026-10-27

### Fixed

- **速览收成细线后不再是一颗「胶囊」。** 之前窗口虽然只有 12 逻辑像素高，但页面和窗口本体
  都不透明——`.qb-frame` 还在铺底色 + 1px 边框，细线就被包在一个带边框的圆角矩形里，
  看起来像底下垫了层东西。现在窗口启用 `transparent: true`，bar 阶段把 html/body 和
  `.qb-frame` 的底色、边框全部让开，屏幕上只剩那条实心短线；多出来的窗口面积
  是真正透明的指针靶子。
- **细线高度随分辨率微调改用真实屏幕高度。** `clamp(4px, 0.45vh, 10px)` 里的 `vh`
  是**窗口**视口高——收起后窗口只有 12px，`0.45vh` 恒等于 0，永远落到下限 4px。
  现在收起时按工作区高度算好（约屏高 0.45%，4~10px）写进 `--dock-line-h`。
- **「速览收起后最小化再恢复，窗口卡住不动」。** 根因：窗口最小化 / 被完全遮挡时
  WebView2 停发 `requestAnimationFrame`，收起/展开动画永远走不到完成回调，
  `animating` 就一直是 true，之后所有收起、展开、长回提示全被它拒掉。
  现在页面不可见时动画直接落到终态；可见时也挂了一道 `setTimeout` 兜底
  （后台定时器会被钳到 ~1s，够用），保证动画状态一定会释放。
- **「在 Photoshop 中应用」改为切换选中文字图层的字体，不再动不动就新建。**
  之前只看 `doc.activeLayer.kind`：用户在图层面板里点中的往往是**编组**，
  组不算文字图层，结果明明选中了文字却跑去新建。现在：
  - 编组（含嵌套）递归进去，把里面所有文字图层都换掉；多选图层逐个处理；
  - PostScript 名认不出时再试一次字族名；
  - 有选中但里面没有任何文字图层时返回新状态 `no-text-selected`
    （提示「未选中文字图层」），**不再悄悄新建**；新建只发生在完全没有选中时。
- **「在 Illustrator 中应用」同样修整。** 编组（GroupItem）递归取里面的文字；
  `textFonts.getByName` 先试 PostScript 名再试字族名；选中了非文字对象时返回
  `no-text-selected` 而不是新建文本框。

### Changed

- 新增 9 语言的 `toast.noTextSelected` / `toast.noTextSelectedSub` 文案。

## [0.8.22] — 2026-10-27

### Changed

- **「在 … 中应用」提速。** CorelDRAW 脚本里的读回比对等待从 40ms 缩到 10ms、连接就绪轮询
  从 400ms 缩到 200ms、整体预算从 180s 收紧到 60s（未运行时脚本现在会立刻返回）。
- **速览收起后的细线保持原来的宽度和位置。** 之前收成细线时窗口会额外变窄并水平居中，
  看起来就是「线跑到屏幕中间顶部去了、还变短了」。现在只把高度收下去，
  宽度、水平位置都和速览展开时一致；细线本身的高度改为随分辨率微调
  （`clamp(4px, 0.45vh, 10px)`：1080p≈5px、4K≈10px）。

### Fixed

- **用一段时间后突然闪退（渲染进程崩溃）。** 根因是字体预览用的 `FontFace` 对象
  一旦 `document.fonts.add()` 就常驻渲染进程——每个字体文件动辄几 MB，
  长时间滚动浏览会把内存慢慢吃满，WebView2 直接崩。现在加了 LRU 淘汰：
  常驻上限 200 个字体，最久没用的先从 `document.fonts` 里删掉，滚回去看时自动重载。
- **细线感应事件改为边沿触发。** 原来光标停在感应带里时每 240ms 持续发一次事件，
  前端会被反复拉进展开/收回循环里空转；现在只在「带外 → 带内」跳变时发一次。

- **「在 CorelDRAW 中应用」改成和 Photoshop / Illustrator 同一条规则：软件没在运行就直接提示
  「CorelDRAW 未运行」，不再替用户拉起软件。** 原因：CorelDRAW 不注册 Running Object Table，
  「是否在运行」只能看进程；而机器上常装着多个版本的 CorelDRAW，无版本号的主 ProgID 指向哪个
  版本不可控——直接按 ProgID 激活会把**旧版** CorelDRAW 拉起来（实测踩中）。运行中的情况下，
  现在会先读每个 ProgID 的 `CLSID\LocalServer32`，挑「exe 路径 = 正在运行的 CorelDRW.exe」的
  那个版本再连接，保证挂到用户已经打开的那个实例上。

- **速览收起后只剩一条 5px 的横线。** 原来收成 30px 左右的一条带提示的条带，占地方不说，
  贴在屏幕顶端时还容易被误点到。现在提示亮完 1 秒后直接收成一条 5px 的实心短线，
  宽度只有 120px、水平居中，不再横跨整个速览宽度。
- **细线靠「光标靠近」展开。** 线只有 5px 高，鼠标几乎不可能真的进到窗口里，
  所以改为由原生侧（`window_dock.rs`）每 90ms 看一眼光标位置：落在窗口正下方
  22 物理像素的感应带里就通知前端展开。Alt + ` 和直接点击照旧可用。

### Added

- **右键菜单 / 命令面板新增「在 CorelDRAW 中应用」。** 和「在 Photoshop 中应用」用法一致：
  有选中文本就换字体，没有就在页面上新建一行美术字。CorelDRAW 没有 JavaScript 接口，
  所以这里由 PowerShell 直接驱动它的 COM 对象模型（`CreateDocument` / `ActiveSelectionRange` /
  `Layer.CreateArtisticText` / `Text.Story.Font`），字体名同时试「字族名」和「PostScript 名」。
  CorelDRAW 没运行会自动拉起（最多等 90 秒），没装或启动超时会各自提示。
  macOS 上没有 CorelDRAW，该条目只在 Windows 显示。

### Fixed

- **「在 CorelDRAW 中应用」点了没反应。** 第一版脚本照着 CorelDRAW 的老文档写的，
  在 Graphics Suite 2022（v24）上四处都对不上，逐项实测后修正：
  ① CorelDRAW **不注册 Running Object Table**，即使进程在跑，
  `Marshal.GetActiveObject` 也永远返回 `MK_E_UNAVAILABLE`，因此脚本上来就判定
  「没运行」并且什么都不做——现在统一走 `[Type]::GetTypeFromProgID` +
  `[Activator]::CreateInstance` 激活（已在运行时会直接挂到现有实例上）；
  ② 建文档没有 `Documents.Add()`，要用 `$app.CreateDocument()`；
  ③ 换字体不能写 `IVGStructFontProperties.Name`（2022 上连结构体自身的值都不会变），
  正确入口是 `Shape.Text.Story.Font`，CorelDRAW 认不出的名字会被静默忽略，
  只能靠赋值后读回来比对来判定成功；
  ④ `Layer.CreateArtisticText` 只有三参版本，带字体名 / 字号的重载会抛
  `DISP_E_TYPEMISMATCH`，字号改用 `Text.Story.Size`（单位是点，与文档单位无关）。

### Fixed

- **速览收起一段时间后再展开，偶尔会「卡住」不动。** 三个竞态一起导致：
  ① 窗口几何操作原来只靠一个 `animating` 标志互斥，`measure()` 之类的异步调用正好落在
  「标志还没置上、几何已经发出去」的窗口期，两边同时改几何就互相打架——现在加了独立的
  几何锁，同一时刻只允许一个修改在跑；
  ② 收成短线时窗口要变窄并居中，展开时却没有把水平位置还原，鼠标可能落在窗口外面，
  于是永远等不到「拖到顶部收起」，看起来就是再也展不开；
  ③ 收起态关掉了「可调整大小」（免得双击标题栏把 120px 宽的窗口放大到整屏），
  展开时必须记得开回来，否则之后拖边改尺寸全部失效。

## [0.8.21] — 2026-10-27

### Changed

- **速览提示条只亮 1 秒就收掉。** 收成顶部一条后那行带快捷键的提示以前要停留 2.6 秒，
  而且鼠标路过时偶尔会一直挂着不收（「靠近展开」被冷却或没解锁，收起的定时器就没再排上）。
  现在每次露出来都只亮 1 秒；鼠标路过没展开的话照样准时收成横线，不再赖在屏幕上。

### Added

- **速览界面失焦即收起。** 速览还展开着、贴在屏幕顶部时，鼠标点到别的软件（窗口失去焦点）
  会立刻收成顶部一条，不再一直摊在那里挡着别的窗口。鼠标移回来照常弹开，不用先点一下。
- **默认示例文本改为 `Hello IIEOzo`。** 老版本写进设置的旧默认句会在启动时自动换成新默认，
  自己改过的内容不受影响。
- **关于面板底部新增一行小字：IIEOzo 定制版 GitHub 地址**，点击跳转到
  <https://github.com/706972745/ZFontManager>。

## [0.8.20] — 2026-10-27

### Added

- **版权信息改动会同步回字族文件夹。** 在详情面板里把某个字族的版权状态改成
  免费 / 收费 / 有时间限制（或改回自动识别）时，字体库里对应的字族目录名后缀会跟着
  改名（`Lora（免费字体）` / `（收费字体）` / 新增的 `（限时字体）` / `（未知版权）`）。
  改回「自动识别」时按「版权信息文件 > 文件夹备注 > 字体自带信息」重新判定。
  目录里已启用的字体会先停用、改完名再用新路径重新启用——Windows 的字体注册指向
  原路径，带着注册改名会让字体失效。
- **导入时按权重判定版权：版权信息文件 > 文件夹备注的版权信息 > 字体自带版权信息。**
  以前只看字体 name 表里极少填写的 license 字段，绝大多数字族都被归成「未知版权」。
  现在先看同目录的 LICENSE / OFL / 版权说明文件正文，再看文件夹名里备注的版权
  （如 `某某字体（免费字体）`、压缩包名），都认不出来才用字体自带的版权信息。

### Changed

- 扫描字体库时会把「文件夹备注 / 版权信息文件」判定的版权一并带出来，界面上的版权
  徽标、版权筛选都能用上，而不只是字体自带的那点信息。
- 手动把版权设成「未知」现在真的显示为未知（以前会被字体自带的版权信息盖掉）。

### Fixed

- 版本号统一：设置页与「关于」里显示的版本改为直接读取 `package.json`，不再手写字面量
  （之前一直停在 0.8.1 Beta 1）；README 的徽章、下载文件名、版本说明同步到 0.8.20。

## [0.8.19] — 2026-10-26

### Fixed

- **进入速览时旧界面被「挤进」小窗再瞬间跳变。** 点速览按钮后，完整界面的内容还挂在
  界面上，窗口一边收成顶部一条、旧内容一边被压窄重排（顶栏 / 搜索框挤成一团），等
  速览内容挂载完成又啪地整块换掉，观感非常卡顿。现在改为三段过渡：旧界面先 150ms
  渐隐（合成器线程的 CSS 动画，主线程渲染速览内容也卡不住它）→ 窗口再收起 → 速览
  内容随窗口淡入，全程看不到内容被挤压和跳变。
- **速览内容在收拢中段提前亮出又被收走。** 进入速览的形变期间速览面板内容原来会立即
  淡入，结果在还在收拢的窗口里"啪地出现又突然收走"。现在收拢全程内容保持透明，窗口
  收成顶部一条之后提示条才淡入（`qb-birth` 动画，只在进入速览的挂载时刻生效，不影响
  收起态展开与退出速览）。

## [0.8.18] — 2026-10-26

### Changed
- 进入速览不再「先摊成完整面板」：窗口一次形变直接收到屏幕顶端的一条，带快捷键提示行，随后收成横线；靠近 / 点一下 / `Alt` + `` ` `` 展开成完整速览面板。
- 退出速览改成「收走 → 变换 → 显示」：先把窗口隐藏，换界面与还原几何全部在不可见时完成，再显示出来并让内容淡入——来回切换不再有大跨度的形变过程。
- 刚收进来的那一条会锁住「鼠标靠近就展开」（点完按钮鼠标往往就压在上面，否则一动立刻弹开），点一下或指针离开一次后解锁。

## [0.8.17] — 2026-10-26

### Changed
- 速览 ↔ 完整界面切换动画对齐 Windows 窗口动画的观感：
  - 窗口形变曲线从纯缓出（起步满速、观感「猛地一冲」）换成 Windows 标准加速-减速曲线 `cubic-bezier(0.4, 0, 0.2, 1)`——起步平顺、中段最快、收尾极缓；
  - 时长 260ms → 300ms，与 Windows 最大化 / 还原 / 贴靠动画同一档；
  - 内容不再瞬间整块换掉，改为随窗口一起淡入浮现（CSS 合成器动画，不受主线程渲染阻塞影响）；
  - 原生插值按 deadline 排帧，消除每帧调用开销累积导致的收尾拖沓。

## [0.8.16] — 2026-10-26

### Fixed

- **速览 ↔ 完整界面切换的动效冲突（Conflicting animations during the Quick View
  morph).** The 260ms window morph used to run while the incoming view was also
  playing its own entrance animations — the whole view fading in, sidebar
  sections sliding in from the left, the top bar dropping in from above, the
  detail panel sliding in from the right, and the first two dozen cards
  floating up one by one. Window geometry and content motion fighting each
  other made the transition feel jittery in both directions. A new
  `useIntro()` hook now suppresses every entrance animation mounted during the
  morph (initial=false, zero-duration), so the window resize/position tween is
  the *only* motion on screen and the content appears pinned, revealed by the
  window as it moves. Regular first-launch and in-view animations are
  unaffected (the flag is latched at mount time per component).

### Added

- **快捷键面板收录速览快捷键（Quick View shortcuts in the shortcuts panel).**
  The shortcuts overlay (`?`) gains a "速览界面 / Quick View" section listing
  `Alt + `` ` `` (collapse to a bar / expand again), `Esc` (leave Quick View,
  clearing the search field first), and "拖到顶部" (dock the whole panel by
  dragging the window to the top of the screen). Locales updated for all nine
  languages.

## [0.8.15] — 2026-10-26

### Fixed

- **速览切换动画中的白色竖条（White sliver during the Quick View morph).**
  While the window tweens between the full interface and Quick View, the
  incoming view is pinned to its target size and the window clips down to it;
  the area the window has not grown/shrunk into yet was painted with the
  browser's default canvas colour (pure white), which showed up as a bright
  vertical strip along the window edge — most visibly when collapsing the
  wide library into the narrow Quick View. `html`/`body` now carry the app
  canvas colour (`var(--canvas)`), so the not-yet-covered region blends into
  the window content instead of flashing white.

### Changed

- **抓手线更纤细（Thinner grabber line).** The drag-handle line at the top of
  Quick View is now 1px tall (was 3px), with its base opacity raised
  proportionately (0.26) so it stays discoverable in the expanded view; the
  brighter 0.32 rule used while the panel is docked is unchanged.

## [0.8.14] — 2026-10-26

### Changed

- **速览 ↔ 完整界面的切换改为窗口形变（Morphing transition between Quick View
  and the full interface).** Switching views used to snap the window to a new
  size instantly, which felt disjointed. A new `src/lib/windowMorph.ts` tweens
  size and position together over 260ms with the same easing curve the rest of
  the UI uses (`easeTop`), while the incoming view is pinned to its target size
  and clipped — so the window appears to grow/shrink around already-correct
  content instead of reflowing it frame by frame. Content fades in with the
  existing `easeTop` transition. Honours the reduced-motion preference (no
  tween when motion is set to reduced). The interpolation itself runs on a
  native thread (`src-tauri/src/window_morph.rs`) instead of
  `requestAnimationFrame`: entering Quick View renders hundreds of font cards,
  which used to block the main thread long enough for the animation to visibly
  stall and then jump. With the native driver the window starts moving within
  ~30ms of the click and completes smoothly.
- **速览列表渲染减负（Cheaper Quick View rendering).** Three changes keep the
  main thread free so the window morph stays smooth: entries outside the
  viewport skip layout and paint via `content-visibility: auto`; only the
  first ~24 cards (the visible ones) carry a motion entrance animation, the
  rest use plain elements with CSS hover/press feedback that looks the same;
  and each entry's `FontFace` is only loaded once it scrolls near the viewport
  (`useInView`), so a thousand-font library no longer fires a thousand font
  loads the instant Quick View opens.
- **收起条分两段，最后只剩一条横线（Collapsed bar shrinks to a hairline).**
  After rolling up, the quick view stays at 34px for 2.6s showing the hint line
  (so the `Alt + \`` shortcut stays discoverable), then eases down to a 16px
  strip that is nothing but the top grip line. Hovering the hairline grows it
  back to the hint size first — the shortcut is shown again — before rolling it
  open.
- **鼠标移开后自动收回（Auto re-collapse when the pointer leaves).** Expanding
  by hovering and then moving the mouse away without doing anything used to
  leave the panel open until the window was dragged again. The panel now
  re-collapses on its own 900ms after the pointer leaves the window — but only
  if it was opened by hovering and you have not clicked, typed or pressed a key
  since, so it never rolls up while you are actually using it.

### Fixed

- **窗口每次进出速览都会变大一圈（Window drifted bigger on every view
  switch).** Exit geometry was captured with `outerSize()` (frame included) but
  restored with `setSize()` (client area), adding the border width each round
  trip. Capture and restore now both use the client area.

## [0.8.13] — 2026-10-26

### Changed

- **速览拖到屏幕顶部改为「整个窗口收起」（Quick view now rolls up as a whole
  when docked to the screen top).** The previous version only folded the header
  and toolbar; dragging the window to the monitor's work-area top edge (within
  5px) now shrinks the whole window to a 34px bar that keeps just the drag grip
  and a one-line hint. Hovering that bar (100ms settle) or pressing `Alt + \``
  rolls it back down to the size it had before. The 0.2s ease now animates the
  window height itself, and the content height is pinned during the animation so
  the panel looks rolled up rather than squashed. A 350ms cooldown keeps the
  drag from immediately re-opening it.
- **速览不再被系统最大化（No more maximize-on-drop).** Because the title bar is
  custom-drawn, Windows treated dragging it to the screen top as a Snap request
  and blew the quick view up to full screen. A new `set_quickbar_mode` command
  (`src-tauri/src/window_dock.rs`) subclasses the window while the quick view is
  active and swallows the `SC_MAXIMIZE` system command and double-click-to-
  maximize; everything else is forwarded untouched, and the full interface keeps
  the normal behaviour.

## [0.8.12] — 2026-10-26

### Added

- **速览界面顶部自动隐藏栏（Quick view top-bar auto-hide).** Drag the quick
  view window to the screen top (within 5px of the monitor's work area) and the
  header + toolbar slide away with a 0.2s ease (`easeTop`, `design/springs.ts`),
  leaving only the 12px drag grip so the window stays movable. It stays hidden
  when the mouse leaves; hovering the top 10px of the window or pressing
  `Alt + \`` brings it back. Both mouse triggers settle for 100ms before acting,
  and a 350ms cooldown after collapsing keeps a drag from re-opening the bar
  instantly. Fullscreen / maximized windows are ignored, and the dock test uses
  the work area of the monitor the window currently lives on (falling back to the
  primary monitor), so multi-monitor setups and a top-docked taskbar behave.
  Controlled by the pin button in the quick view (on by default); the full
  interface is untouched. Replaces the old “slide the whole window off screen”
  behaviour.

## [0.8.11] — 2026-10-26

### Changed

- **速览界面右键菜单不再提供新建分组 / 新建快照（No “new group / new snapshot”
  in the quick view menu).** The quick view is for applying existing groups and
  snapshots, so those two entries are dropped there; creating them stays in the
  full window. Empty group / snapshot sections (no existing entries) are hidden
  instead of leaving a heading with nothing under it.

## [0.8.10] — 2026-10-26

### Added

- **速览界面显示版权 / 分组 / 快照信息（Quick view shows copyright, groups and
  snapshots).** Every quick-view row now carries the same metadata as the full
  UI: a copyright chip (免费 / 收费 / 有时间限制 / 未知, manual override first,
  expiry turns it red), the copyright text below the specimen (clamped to three
  lines, full text in the hover tooltip), plus the family's tags, snapshot chips
  and collection (分组) chips rendered with the shared `member-chip` styles.

### Changed

- **速览最小高度提高 50%（Quick view minimum height +50%).** The floor derived
  from the context menu is now `menu height × 1.5 + 16px` (was `menu height +
  16px`), so the menu always has scroll room around it instead of exactly
  fitting.

## [0.8.9] — 2026-10-26

### Changed

- **速览界面再高一倍（Quick view twice as tall).** The quick view panel went
  from 400 × 496 to **400 × 992** logical pixels, clamped to the usable screen
  height so it never runs under the taskbar. More families are visible before
  scrolling.

### Fixed

- **速览界面的最小尺寸不够放右键菜单（Quick view could shrink below the
  context menu).** The window minimum size is now derived from the context
  menu's measured size — width ≥ menu width × 1.5, height ≥ menu height, plus a
  16px allowance for the window frame. `MenuPanel` records its real
  `offsetWidth` / `offsetHeight` after every render (`lib/menuMetrics.ts`) and
  pushes the new floor to the window while the quick view is open, so the menu
  can never be clipped by a resized panel.

## [0.8.8] — 2026-10-26

### Fixed

- **速览界面右键菜单底部被裁（Quick view context menu clipped at the bottom).**
  The menu's viewport clamping measured its size with `getBoundingClientRect`
  while the entrance scale animation was still at 0.96, so the measured height
  was ~4% short and the clamped position left the last menu items hanging past
  the window edge. Measurement now uses the layout size (`offsetWidth` /
  `offsetHeight`), and the menu got a visible scrollbar (same style as the
  language menu) so extra items scroll instead of looking cut off.

### Changed

- **速览界面置顶（Quick view is always on top).** Switching to the quick view
  now sets the window always-on-top until returning to the full view (requires
  the newly granted `core:window:allow-set-always-on-top` capability). The
  flag is cleared on exit even if geometry restore fails.

## [0.8.7] — 2026-10-26

### Added

- **速览界面保留完整界面的预览控制（Quick view now keeps the preview controls).**
  Three top-bar controls from the main view are now available in the quick
  view as a second toolbar row:
  - Sample-text input (Type field) shared with the main view.
  - Preview size slider (same 8–96 px steps, with fill indicator and px readout).
  - The sort menu (name / styles / size / glyphs / added), reused directly from
    the top bar component. Sorting is extracted into a shared `sortFamilies`
    helper so the quick view list orders exactly like the main list.
  - Each quick-view card's preview line now renders the shared sample text
    (falling back to the family name) at the shared preview size, matching the
    main list's card preview including its fade-in animation.

## [0.8.6] — 2026-10-26

### Changed

- **速览界面重新设计（Quick view redesign).** The quick view panel was too wide
  and too flat for its purpose:
  - Window geometry is now a narrow vertical panel — 400 px wide (roughly a
    third of the previous 720–1240 px band) and 496 px tall (double the
    previous 248 px).
  - Entries switched from horizontal chips to a vertical card list. Each card
    mirrors the full view's detail panel specimen: a large gradient "Aa",
    the family name rendered in its own font, and a character specimen strip
    with a fading right edge (same masking as `.specimen-strip`).
  - Animations now match the detail panel: staggered spring entrance
    (`staggerDelay` + `spring`), hover lift and press-down scale on each card.

## [0.8.5] — 2026-10-26

### Fixed

- **速览界面打不开（Quick view failed to open).** Clicking the quick-view
  button showed "无法切换速览界面 — Command plugin:window|set_size not allowed
  by ACL". Three problems stacked on top of each other:
  - The window capability file never granted the geometry commands the quick
    view needs. `core:window:allow-set-size`, `allow-set-position`,
    `allow-set-min-size`, `allow-maximize` and `allow-unmaximize` are now
    granted.
  - The main window declares a 900×600 minimum size, but the quick view is
    248 px tall — even with the permission granted, `setSize` would have been
    clamped back to 600. Entering the quick view now lifts the minimum size
    and it is restored when returning to the main view.
  - Window-geometry failures no longer abort the switch: the interface now
    always switches (worst case the quick view fills the old window size)
    instead of dying with a toast.

## [0.8.1-beta.1] — 2026-10-25

### Added

- **字体快照（Font snapshots）.** Save the set of currently activated fonts as a
  named snapshot and restore the whole environment later with one click.
  - Up to 5 snapshots; the oldest is evicted automatically.
  - Two apply modes: **切换到此快照** (deactivate everything else, keep only the
    snapshot's fonts) and **合并到当前启用** (activate the snapshot's fonts on
    top of what is already active).
  - System-installed fonts are recorded into snapshots and clearly annotated
    (a "N 个系统字体" badge); applying a snapshot never deactivates system
    fonts.
  - Fine-grained control: an "加入快照" toggle per snapshot in the detail
    panel, per-family check items in context menus (multi-select supported),
    and a "清除快照内所有字体" entry in the snapshot context menu that empties
    a snapshot while keeping it.
  - Import / export: exports are named
    `ZFontManager_<快照名>_<导出时间>.json`; importing offers 仅导入 /
    导入并切换 / 导入并合并; both v1 and v2 export formats are accepted.
- **启动自动恢复（Restore on launch）.** The app re-activates on startup the
  fonts that were active in the previous session. Off-switch in Settings,
  on by default.

### Changed

- **Monochrome (black-white-gray) theme completed.** All 53 icon assets —
  application icon, tray icon, installer icons, in-app images — were
  desaturated from purple to grayscale with luminance preserved; the two
  remaining accent colors in the UI (system badge blue, warning amber) are now
  neutral gray as well.
- Version bumped to 0.8.1 (shown as *0.8.1 Beta 1* in About and Settings).

### Fixed

- The snapshot sidebar count counts font files while the "System fonts" view
  counts families; both are now documented to avoid confusion.

[0.8.1-beta.1]: https://github.com/TheHolyOneZ/ZFontManager/compare/v0.8.0...HEAD

## [0.8.0] — 2026-10-23

### Fixed

- **Affinity only got one style of a family.** When a document used a font,
  the Affinity integration switched on that one file and nothing else, so a
  document set in Regular left the other eleven styles of a twelve-style family
  asleep and Affinity's font menu offered Regular alone. A matched font now
  wakes its whole family, the way Affinity lists it. Only styles that were off
  are switched on, so quitting Affinity no longer turns off styles you had
  activated yourself.

- **A family looked active when only one of its styles was.** The family switch
  was on as soon as any single style was active, which hid the problem above:
  there was no reason to click it. Families now have a third state. A partly
  active family shows a centred switch and "Partly active · 1 of 12 styles" in
  the detail panel, and one click activates the styles that are missing. It
  appears under both **Activated** and **Deactivated** in the sidebar.

- **Affinity font names with spaces in the family were never matched by
  family.** PostScript names drop the spaces ("SourceSerif4-Semibold"), and the
  fallback compared them against the spaced family name, so it found nothing.
  Names are now compared with spaces and hyphens ignored. A name that matches
  no family in the library is skipped instead of being guessed.

- **Windows: a font Windows refused to load still counted as active.** The
  result of loading the file was never checked, so a font could be registered,
  shown as active and still be missing from every other app. The file is now
  loaded first and only registered once that worked; if registering fails, it
  is unloaded again. Either way the toggle reports the error.

- **Turning on part of a batch reported only the first error.** Activating a
  family or a selection now says how many files failed ("3 of 12 fonts
  failed: ..."), and the library reloads its real state instead of flipping
  every switch back as if nothing had changed.

- **macOS: activating a font that was already active failed** with "no parked
  copy recorded", which would have broken activating the rest of a partly
  active family. It is now a no-op. A failed move back out of the parking
  folder also no longer forgets where the file was parked.

- **Activate until close could turn off styles that were already on.** It sent
  every file of the family, so closing the app deactivated styles you had
  switched on permanently. It now only sends the ones that were off.

Reported by zeusextremachine on Windows with Affinity by Canva, with an
unusually thorough investigation. (#18)

### Added

- **An activation log.** Every activation and deactivation is written to
  `activation.log` in the app data folder, with the result for each file and
  the names inside it (family, style, full and PostScript name). On Windows it
  also records how many fonts Windows loaded from the file and which registry
  entry was written. When a file claims the same name as one already
  activated, or shares its PostScript name with another file the library scan
  found (system fonts included), the log warns about it: apps then show only
  one of the two, which looks exactly like a missing style. Fonts Windows refuses to load at startup
  are logged too. The log stays under 1 MB.

### Changed

- All nine languages gained the string for partly active families.
- `pnpm test` runs tests for the Affinity matching and family states, and the
  Rust side has tests for the log.

## [0.7.2] — 2026-10-15

### Fixed

- **The Affinity connection status in Settings did not refresh while the panel
  was open.** It showed whatever it found the moment you opened Settings, so
  during the startup grace period added in 0.7.1 it could sit on
  "Offline · Affinity link failed..." long after Affinity had connected. That
  wording is identical to one of the errors from #16, which made a working
  installation look like a failed one. The panel now follows the link live.

- **Opening Settings could connect to Affinity during its startup.** The status
  check ran a full connection of its own, outside the grace period that keeps
  the watcher away from Affinity while it starts — so opening Settings at the
  wrong moment could trigger the very crash 0.7.1 fixes. The watcher now
  publishes what it already knows, and the panel reads that instead of opening
  a connection. The *Test connection* button still probes on demand, as before.

  Found while testing 0.7.1 on Windows.

## [0.7.1] — 2026-10-15

### Fixed

- **Affinity could be taken down at startup by the font activation
  integration.** Affinity's MCP server starts accepting connections before the
  application has finished initialising, and ZFontManager connected to it the
  instant the process appeared — often while Affinity was still on
  "Initializing...". The request landing in that window could close Affinity
  with no error dialog, and left ZFontManager showing
  "preamble read failed: error decoding response body" or a failed link to
  `localhost:6767/sse`.

  ZFontManager now leaves Affinity alone for the first 20 seconds after it
  appears, and if the link still fails it retries with a widening gap (10s,
  20s, 40s, up to two minutes) instead of reconnecting on every pass. A failed
  link is only reported after three consecutive attempts, so a slow start no
  longer raises an error you need to dismiss.

  One consequence worth knowing: fonts for a document open at launch are now
  activated a short time after Affinity starts rather than immediately.

  Reported by zeusextremachine on Windows 11 with Affinity 3.3.1. (#16)

- **The Affinity link is far less demanding in general.** Reviewing the above
  turned up three further problems in the same code:

  - Every poll reopened a session from scratch, retrying all three loopback
    spellings and up to three protocol versions each time. The working address
    and protocol are now remembered after the first success and tried first,
    so a healthy link is one connection rather than up to nine attempts. Both
    are forgotten again on failure, so a changed setup is still found.
  - Documents were re-queried every 10 seconds, each time with a complete
    handshake. That is now every 30 seconds.
  - A server that accepted the connection but did not report its own version
    string was treated as having refused every protocol version, and the link
    failed for no reason. Acceptance and the reported version are now tracked
    separately.

## [0.7.0] — 2026-10-12

### Added

- **Copy a font's name with one click.** Click the family name in the detail
  panel to copy it, or the PostScript name in the metadata list to copy that
  instead. Useful when an application has no font picker and expects you to
  type the name into a config file by hand. (#14)

- **System tray.** ZFontManager can now live in the tray. Three new settings
  under *System*:

  - **Close to tray** — the close button hides the window instead of quitting.
  - **Start with system** — launch at sign-in.
  - **Start minimised** — start in the tray without opening the window.

  All three are off by default, so nothing changes unless you turn them on.

  On Windows, left-click the tray icon to bring the window back and right-click
  for the menu. On macOS and Linux the menu opens on click, following each
  platform's convention — Linux desktops do not deliver tray click events to
  the application at all, so the menu is the way back. If the tray cannot be
  created, *Close to tray* stays inactive rather than leaving you with no way
  to reach the window. (#15)

### Changed

- Tauri updated from 2.11.5 to 2.12.3, which the autostart integration
  requires. This also moves the underlying webview layer (wry) from 0.55 to
  0.57.

## [0.6.1] — 2026-09-22

### Added

- **Show only your own fonts.** A new *Show* filter at the top of the filter
  menu switches between all fonts, system fonts, and the fonts you installed
  yourself. On a machine with several hundred system faces, finding the ones
  you added by hand no longer means scrolling past everything the OS shipped.
  It composes with the other filters, so you can narrow to your own fonts and
  then filter those by format, feature or character.

  Requested by a user who found their own fonts hard to pick out of the list.

## [0.6.0] — 2026-09-21

Everything here comes from one report by a tester running Fedora on a 1366x768
ThinkPad. 

### Added

- **Interface scale.** ZFontManager now measures the usable area of your screen
  at startup and picks a scale that fits the whole interface into it, so a
  small or low-resolution display shows the entire layout instead of a cropped
  one. Settings → Appearance → *Interface scale* overrides it: **Auto**, or a
  fixed 80–125% if you would rather decide, which also serves anyone on a large
  display who simply wants the interface bigger.
- **Reduce transparency.** A new Appearance setting that replaces the frosted
  glass with solid panels. It is easier to read, it is the accessible choice,
  and it removes the most expensive thing the app draws — which makes a real
  difference on older integrated graphics.
- **Filter by file format.** OpenType, TrueType, WOFF and WOFF2, in the filter
  menu alongside classification and language support.
- **Filter by typographic feature.** Swashes, stylistic alternates,
  discretionary ligatures, small caps, oldstyle figures and fractions. The
  feature list is now read while the library is indexed rather than only when a
  font is selected, so it can be filtered on. If you are hunting for faces with
  alternate letterforms, this is the fastest way to find them.
- **Find fonts containing a specific character.** Type any character into the
  filter menu and the library narrows to the fonts whose character map covers
  it. The search reads every font file, so it runs on demand rather than
  continuously, and it reports the codepoint it resolved your character to.
- **Glyph count.** Shown in the inspector, and available as a sort order.
- **Collapsible sidebar sections.** Browse, Collections and Tags each fold away,
  and stay folded between launches.
- **Sort by glyph count**, next to name, styles and size.

### Fixed

- **The window could open taller than the screen.** The default size is right
  for the displays the app was designed against, but nothing checked whether it
  fitted. On a 1366x768 screen roughly a hundred pixels of the app sat below
  the bottom edge once the desktop panel was counted, which among other things
  hid the inspector's Tags section. The window is now measured against the
  monitor's usable area — panels, docks and taskbars excluded — and clamped and
  centred to fit. The configured default is unchanged, so nothing moves on a
  display that was already big enough.
- **The context menu could not be scrolled.** It had no height limit, so with
  enough tags the "Tag all" menu grew past the screen and lost its top. It now
  scrolls, and can no longer be positioned off the top or left edge.
- **Panels turned unreadable when the compositor could not blur.** Every
  overlay — the context menu, Compare, Settings, the selection bar — was a
  ten-percent-white surface that relied entirely on a backdrop blur to become
  legible. Where that blur silently does nothing, the panel was a haze. The new
  *Reduce transparency* setting makes them solid.
- **No resize handles.** ZFontManager draws its own title bar, and drawing your
  own means the window has no resize border unless you provide one. There was
  none, so the edges were a one-pixel guessing game. All four edges and corners
  are now grabbable, with the right cursor on each. This affected Windows and
  macOS too.
- **The online font browser ignored the preview size slider**, rendering every
  preview at a fixed size while the rest of the library followed the control.

### Notes

- The tiny flickering squares reported on Intel HD 4000 with the crocus driver
  are not drawn by the app and were not reproducible away from that hardware.
  *Reduce transparency* removes the most likely trigger; if you see them, please
  try it and say whether it helps.

## [0.5.1] — 2026-09-19

### Fixed

- **The sidebar now scrolls.** It had no scroll region at all, so once Browse,
  Collections and Tags together grew taller than the window, everything past
  the bottom edge was silently cut off — the Tags section first, then Trash,
  About and Shortcuts. 0.4.0 made this easy to hit by adding four rows to
  Browse. Browse, Collections and Tags now scroll; Trash, About and Shortcuts
  stay pinned at the bottom. Affected every platform.
- The onboarding tour scrolls its target into view before drawing the
  spotlight, so a step can no longer point at something below the window edge.

## [0.5.0] — 2026-09-17

### Added

- **Online font browser.** Search nearly two thousand open-licence families —
  the whole Google Fonts catalogue — and add any of them to the library with
  one click, from a new *Online* section in the sidebar. Filter by category,
  licence and variable-only. Each family shows its designer, licence, a link to
  the full licence text and its Reserved Font Name before you download; the
  licence text is stored alongside the font. Downloaded families are tagged
  *Online* automatically and marked *In library* in the browser afterwards.

  This is the first feature that contacts a real server, so the rules are
  strict and enforced in one place. Off by default. Switching it on sends
  nothing — a request goes out only when you open the section and search or
  download; there is no background refresh and no probe on startup. The
  catalogue is fetched once from `api.fontsource.org` and cached for seven
  days; search runs locally against that cache, debounced, so the provider
  sees one request a week rather than one per keystroke. Font files and
  licences come from the `google/fonts` repository via
  `raw.githubusercontent.com` — the canonical source, and the only one that
  serves complete fonts rather than per-script web subsets. Both hosts are
  named under the toggle. Every request passes through a single client that
  refuses if the setting is off, rejects any host not on that two-entry list,
  follows no redirects, and identifies itself as ZFontManager.

  The licence shown is read from the repository directory the files are
  actually fetched from, so it is by construction the licence that ships beside
  the font; the catalogue's licence field only decides which directory to try
  first.

  Opening a family shows a live preview of your current sample text in that
  font. One face — the Regular — is fetched for the preview through the same
  gated client, and if you then add the family the download reuses that file
  rather than fetching it again. Closing the family without adding it removes
  the preview file.

  Bunny Fonts and Fontsource's own CDN were evaluated and rejected as download
  sources: both serve only WOFF/WOFF2 or per-script subsets, which Windows
  cannot install and which would put a dozen partial copies of each style in
  the OS. Fontshare was rejected because the ITF Free Font Licence forbids
  redistribution.

- **System fonts now say why they can't be turned off.** On Windows and macOS
  the operating system owns its own fonts, and until now a system font showed
  a dimmed activation toggle that looked switched on but did nothing. It now
  shows a small lock badge reading *OS*, with the full explanation on hover:
  managed by the operating system, can't be turned off. On Linux, where
  fontconfig can exclude any font, the toggle is unchanged.
- **Hide them entirely.** The filter menu gains *Hide fonts the OS won't let
  you turn off*, so the library can show only what you can actually act on.
  It counts toward the filter badge and clears with the other filters.

### Changed

- `reqwest` now carries a TLS backend (`rustls`, using the OS trust store). It
  was built without one, which was fine for the Affinity integration's loopback
  HTTP but would have failed on any `https://` request.

## [0.4.0] — 2026-09-16

### Added

- **Import modes.** Dropping fonts in now offers *Add to library* (the file
  stays where it is and is registered from there) or *Copy to system folder*
  (copied into the library folder, original removed). On Linux and macOS a
  linked font is linked into the font folder so the rest of the system can see
  it — the original is never moved or deleted.
- **Custom library folder** under Settings, for deciding where copied imports
  are stored.
- **Auto-activate for Affinity by Canva** (Windows and macOS). While Affinity
  runs, fonts its open documents ask for are switched on, and switched back
  off when it quits. Needs Affinity 3.2+ with *Model Context Protocol* enabled.
  Off by default. Talks only to `localhost:6767` — nothing leaves the machine.
- **Auto-activate imported fonts**, an opt-in Settings toggle for batches
  under 64 fonts.
- Sidebar filters for **Activated**, **Activated until close**, **Deactivated**,
  **Last imported** and **System fonts**, each reachable from the command
  palette.
- Duplicate detection on import: fonts already in the library are reported and
  skipped instead of being added twice.
- Per-file actions in the name-conflict panel.
- **Select every font in view** with <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>A</kbd>,
  or *Select all* in the command palette, so a whole library — or whatever the
  current filters and search have narrowed it to — can be activated or
  deactivated in one action, with undo.

### Fixed

- Imported fonts were reported to the interface as inactive even when
  *auto-activate imports* was on and they had in fact been activated, so the
  library showed the wrong state until the next rescan.
- The Affinity watcher enumerated every running process every two seconds even
  when the feature was switched off, which was the default. It now does that
  only while the feature is enabled, and never starts at all on Linux, where
  Affinity does not exist.
- Deactivating a font that had been added with *Add to library* moved the
  original file out of its folder on macOS. Linked fonts are now linked and
  unlinked instead, leaving the original untouched.
- Fonts added with *Add to library* were invisible to other applications on
  Linux and macOS, because they sat outside the directories those systems
  scan.
- Removing a font added with *Add to library* only unregistered it on Windows.
  On Linux and macOS the font stayed available to other applications after it
  had been removed from the library.
- Opening Settings probed for Affinity even when Affinity auto-activation was
  switched off. Nothing is contacted now unless the feature is on, and the
  panel says *Disabled* instead of reporting it as offline.
- The source badge in the name-conflict panel showed *Managed* and *User* in
  English in every language.

### Changed

- The Privacy section of the README now lists, in a table, every feature that
  can open a connection, what it contacts and whether anything leaves your
  machine. Today that is one row, it is off by default, and it is loopback.
- **`CONTRIBUTING.md`** now sets out what a contribution has to satisfy: it must
  work on Linux, Windows and macOS; a genuinely platform-bound feature has to be
  declared, gated, hidden on platforms it cannot serve, and written up in the
  README; and any new interface text has to land in all nine languages with the
  plural forms each one requires.
- README documents the new import modes, the Affinity integration, the
  state filters in the sidebar and the name-conflict panel, and the Privacy
  section now states the local-loopback exception instead of claiming no
  network activity at all.
- All eight translations are complete again: German, Spanish, French,
  Japanese, Portuguese (Brazil), Russian, Simplified and Traditional Chinese
  each cover every string, with the plural forms their language requires.

## [0.3.0] — 2026-09-11

### Added

- **Apply a font in Photoshop or Illustrator** (Windows and macOS). Right-click a
  family → *Apply in Photoshop…* / *Apply in Illustrator…*, or use the command
  palette with a family selected. ZFontManager talks to the *running* app
  (COM on Windows, AppleScript on macOS) and switches every selected text
  layer or text frame to the font; with nothing selected it adds a new text
  layer using the family name as sample text. A sleeping font is woken "until
  close" first, so auditioning never installs anything permanently. Every
  outcome is reported in a toast (applied with layer count, layer created,
  app not running, no open document, app hasn't refreshed its font list yet).
  **Not yet verified against a real Photoshop/Illustrator** — the app-side
  plumbing and scripts are tested up to the Adobe boundary only. Feedback
  welcome.
- Adding or removing a watched folder now indexes the library immediately,
  shows the progress inline in Settings, and reports what changed
  ("3 new fonts found", "4 fonts removed", or that no font files were found).
- Linux bundles (AppImage, .deb, .rpm) are now built by the GitHub Actions
  workflow alongside the Windows and macOS installers, and
  `prepare-release.mjs` refreshes the website download page and checksums.

### Fixed

- **Watched folders on Windows.** Fonts in a folder added in Settings were
  shown as active, could not be deactivated ("font not found in per-user
  registry"), and every card said "This format can't be previewed yet".
  - Activation is now driven by what Windows itself lists in the font
    registry (read through the Win32 API instead of scraping `reg.exe`
    output). Fonts from a watched folder start *inactive*; switching one on
    registers it for your user account right where it is — external drives
    included — and switching it off unregisters it, without errors when there
    was nothing to unregister. Original registry names are remembered so a
    round trip leaves the registry exactly as it was.
  - Fonts registered from outside the per-user font folder are loaded again
    at app start so they are available to other apps immediately.
  - Bulk activation keeps going past a failing file and always persists what
    was applied.
- **Previews for fonts outside the standard folders.** Watched folders (and
  on Linux `/usr/local/share/fonts`) were never allowed through the preview
  asset scope, so their fonts could not render. Every scanned folder is now
  allowed at startup and whenever the folder list changes.
- **Constant GPU load.** A perpetual background-gradient animation kept the
  compositor busy on every frame and forced the blurred sidebar and detail
  panel to re-blur continuously — up to ~50 % GPU on large displays and
  integrated GPUs. The gradient is now static; idle GPU use drops to zero.
- The in-app "Reduce motion" setting now also disables CSS animations
  (skeleton shimmer, toast flashes), not only the interface springs.
- macOS: a deactivated (parked) font lost its preview, glyph map and
  OpenType feature list because those were read from the original path.
- Registry entries ZFontManager writes on Windows now use the names Windows
  itself would use: `(OpenType)` for CFF files, every face named for
  collections, and a numbered suffix when a name is already taken.

### Changed

- All nine languages gained the strings for the features above.

## [0.2.0] and earlier

Earlier releases predate this changelog. Their installers remain available on
the [download page](https://zsync.eu/zfontmanager/).

[0.3.0]: https://github.com/TheHolyOneZ/ZFontManager/releases/tag/v0.3.0
[0.5.1]: https://github.com/TheHolyOneZ/ZFontManager/releases/tag/v0.5.1
[0.6.0]: https://github.com/TheHolyOneZ/ZFontManager/releases/tag/v0.6.0
