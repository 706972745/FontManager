use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

/// 软件最多保存的快照数量（超出后滚动淘汰最旧的）
pub const MAX_SNAPSHOTS: usize = 5;

/// 最多保存几个字体库地址（用户 2026-11-05 定的上限）
pub const MAX_LIBRARY_DIRS: usize = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntry {
    /// 跨设备可移植的字体标识（postScriptName 优先，回退 字族+样式+字重），
    /// 不含任何目录信息，因此换电脑、改字体库路径后仍能对上号
    #[serde(default)]
    pub key: String,
    /// 旧版快照数据中的绝对路径，仅用于升级/导入时反查，新数据不再写入
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub family: String,
    /// 字体样式名（Regular、Bold……），作为 key 失效时的兜底匹配项
    #[serde(default)]
    pub style: String,
    /// 该条目是否为系统安装的字体（应用快照时系统字体不受影响）
    #[serde(default)]
    pub system: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub name: String,
    /// 创建时间（毫秒时间戳），用于"超出 5 个时淘汰最旧"
    #[serde(default)]
    pub created_at: u64,
    pub entries: Vec<SnapshotEntry>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppState {
    pub deactivated: HashSet<String>,

    /// 持久激活台账（2.1.4）：**用户意图**的快照，不是扫描结果的派生值。
    ///
    /// 为什么存「原始路径」而不是归一化后的小写路径：前端拿它跟 `FontFace.path` 直接
    /// 对号（`restoreLastActivation`），归一化会引入一次口径转换，两边一旦不同步
    /// 就会出现「台账里有、界面上匹配不到」。归一化只在比较时临时做（条目量级几百，成本可忽略）。
    ///
    /// 反例（不记账）：每次启动都只能靠注册表现算「上次启用了什么」，而注册表里还混着
    /// 「启用至关闭」的会话级残留 —— 用户一重启就被反向启用（1.2.x 的实测事故）。
    /// 系统字体路径一律不落账（写入时过滤 + `store::load` 兜底清理）。
    #[serde(default)]
    pub activated: HashSet<String>,

    pub tags: HashMap<String, Vec<String>>,

    pub collections: HashMap<String, Vec<String>>,

    #[serde(default, deserialize_with = "de_snapshots")]
    pub snapshots: Vec<Snapshot>,

    pub favorites: HashSet<String>,

    pub extra_dirs: Vec<String>,

    pub watch_enabled: bool,

    pub auto_activate_imports: bool,

    pub notes: HashMap<String, String>,

    /// 已经自动写过「授权原文」备注的字族：写过一次就不再写
    /// （用户改过备注不该被覆盖；用户主动删掉也不该下次启动又复活）
    #[serde(default)]
    pub note_seeded: HashSet<String>,

    /// 自动备注是按哪一版判定口径写的（口径变了要重写，见 copyright::NOTE_RULES_VERSION）
    #[serde(default)]
    pub note_rules: u32,

    pub prefs: serde_json::Value,

    pub parked: HashMap<String, String>,

    pub registry_backup: HashMap<String, String>,

    pub library_dir: Option<String>,

    /// 用户保存过的字体库地址（最多 [`MAX_LIBRARY_DIRS`] 个，含当前生效的那个）。
    /// 设置页可以一键在这些库之间切换；`library_dir` 始终指向列表里的某一个。
    #[serde(default)]
    pub library_dirs: Vec<String>,

    pub library_dir_enabled: bool,

    pub linked: HashSet<String>,

    /// 字体入库时间：路径 → Unix 秒，用于"按入库时间排序"
    #[serde(default)]
    pub added: HashMap<String, u64>,

    pub affinity_enabled: bool,

    #[serde(default = "default_true")]
    pub affinity_deactivate_on_quit: bool,

    pub online_fonts_enabled: bool,

    /// 运行时判定的「软件里预览不出来」的字面（face id = `路径#序号`）。
    ///
    /// 用户 2026-10-30：只要预览区是「这种格式暂时无法预览」，就归到「无法预览 / 损坏」那一类。
    /// 这一类**只标记、不搬文件** —— 浏览器拒收可能是 WebView2 的瞬时问题（内存、解码器），
    /// 不该据此移动用户的文件。两档修复都失败才写入，能正常加载时会自动摘掉。
    #[serde(default)]
    pub unpreviewable: std::collections::HashSet<String>,

    /// raw.githubusercontent.com 在本机是否探明不可达。
    /// 记住它是为了跳过每次启动后的第一轮 10 秒超时（用户会以为「点了没反应」）；
    /// 镜像全部失败时还会回头再试原始地址，网络恢复后这个标记会被清掉。
    #[serde(default)]
    pub raw_unreachable: bool,

    /// E2（2026-11-01）：批量启停的断点。
    ///
    /// 4000+ 族批量启用要 35~45 分钟（逐字面注册表 + GDI，0.3~0.4 s/个），
    /// 中途进程退出的话清单就丢了。这里持久化「还剩哪些没做」，下次启动问用户要不要续。
    /// 前端编排（runBatches）每 30 秒更新一次 —— 一次落盘 2.4 MB，不能每批都写。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_batch: Option<PendingBatch>,
}

/// 批量启停断点。`remaining` 保持原清单顺序（分批切片的顺序就是 paths 的顺序），
/// 续做时按它重新分组跑批。
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingBatch {
    /// 还没做启停的字体路径（有序）
    pub remaining: Vec<String>,
    /// 已完成的字面数（只用于展示「x / y」）
    pub done: usize,
    pub total: usize,
    /// true = 启用，false = 停用
    pub active: bool,
}

/// 包一层 Arc：批量启停要丢到后台线程（`spawn_blocking`）跑，得能拿出一份 'static 的共享状态
#[derive(Clone)]
pub struct Store(pub std::sync::Arc<Mutex<AppState>>);

/// 兼容旧版 state.json 中 `snapshots` 为 HashMap<String, Vec<String>> 的格式：
/// 旧数据迁移为 Vec<Snapshot>（family 置空、system=false、created_at=0）。
fn de_snapshots<'de, D>(d: D) -> Result<Vec<Snapshot>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum SnapRaw {
        New(Vec<Snapshot>),
        Legacy(HashMap<String, Vec<String>>),
    }
    match SnapRaw::deserialize(d)? {
        SnapRaw::New(v) => Ok(v),
        SnapRaw::Legacy(map) => Ok(map
            .into_iter()
            .map(|(name, paths)| Snapshot {
                name,
                created_at: 0,
                entries: paths
                    .into_iter()
                    .map(|path| SnapshotEntry {
                        key: String::new(),
                        path: Some(path),
                        family: String::new(),
                        style: String::new(),
                        system: false,
                    })
                    .collect(),
            })
            .collect()),
    }
}

fn default_true() -> bool {
    true
}

impl AppState {
    pub fn active_library_dir(&self) -> Option<&str> {
        if self.library_dir_enabled {
            self.library_dir.as_deref()
        } else {
            None
        }
    }

    /// 记 / 撤一条台账，返回是否真的改了（调用方据此决定要不要落盘）。
    ///
    /// 三条硬规则：
    /// ① 系统字体路径直接拒绝 —— 它改不动，记进来只会在每次启动时白算一次种子
    ///   （PRD §6「记录目标为系统字体路径 → 忽略」）；
    /// ② 写入前清掉同一路径的其它大小写 / 斜杠变体 —— 同一文件在 `linked` / `added` /
    ///   注册表里写法可能不同，不清就会攒出 N 份「同一个字体」的台账，体积随时间线性
    ///   膨胀（PRD R-18 的隐患）；
    /// ③ `on=false` 且本来就没有 → 不算改动，避免一次无意义的整份 state 落盘。
    ///
    /// 注意 `is_system_font` 必须在最前面：上游有些调用点（批量启停）拿到的是混合清单，
    /// 不能指望它们自己过滤。
    pub fn record_activated(&mut self, path: &str, on: bool) -> bool {
        if crate::activation::is_system_font(path) {
            return false;
        }
        let norm = crate::activation::norm_path(path);
        let had_variant = self
            .activated
            .iter()
            .any(|p| p != path && crate::activation::norm_path(p) == norm);
        let existed = self.activated.contains(path);
        if on {
            if had_variant {
                self.activated
                    .retain(|p| crate::activation::norm_path(p) != norm);
            }
            self.activated.insert(path.to_string())
        } else {
            if !existed && !had_variant {
                return false;
            }
            self.activated
                .retain(|p| p != path && crate::activation::norm_path(p) != norm);
            true
        }
    }

    /// 按「本轮扫描真实见到的路径集合」裁剪台账，返回剔掉几条（D10）。
    ///
    /// 为什么用扫描结果而不是逐条 `is_file`：几千条 stat 在机械盘上是几百毫秒，
    /// 而扫描本来就把每个文件摸过一遍了 —— 结果就在手边，没必要再问一次磁盘。
    /// `alive` 是**归一化**后的集合，比较也要归一化（台账里存的是原始写法）。
    ///
    /// 反例（不裁剪）：删掉的字体永远留在台账里，每次启动都为它们各算一次种子、
    /// 各查一次缓存，`state.json` 只涨不落（PRD R-18）。
    pub fn retain_activated(&mut self, alive_normalized: &HashSet<String>) -> usize {
        let before = self.activated.len();
        self.activated
            .retain(|p| alive_normalized.contains(&crate::activation::norm_path(p)));
        before - self.activated.len()
    }

    /// 保存（插入或覆盖）一个快照。上限 [`MAX_SNAPSHOTS`] 个：
    /// 覆盖同名快照随时可以；**新建**时若已达上限则返回 Err —— 用户 2026-10-30 定：
    /// 第 6 个不能挤掉最旧的（原来会悄悄淘汰），要让「创建 / 导入」失败并提醒。
    pub fn save_snapshot(&mut self, snapshot: Snapshot) -> Result<(), String> {
        if let Some(existing) = self.snapshots.iter_mut().find(|s| s.name == snapshot.name) {
            existing.entries = snapshot.entries;
        } else {
            if self.snapshots.len() >= MAX_SNAPSHOTS {
                return Err(format!(
                    "snapshot limit reached ({})",
                    MAX_SNAPSHOTS
                ));
            }
            self.snapshots.push(snapshot);
        }
        self.snapshots
            .sort_by_key(|s| (s.created_at, s.name.clone()));
        Ok(())
    }

    pub fn snapshot(&self, name: &str) -> Option<&Snapshot> {
        self.snapshots.iter().find(|s| s.name == name)
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 数据根（2.1.5）
//
// 需求原话：「除了必须留在 C 盘的系统级物，缓存 / 数据 / 产物 / 日志 / 插件都放到
// 安装地址下面」。于是 2.1.5 起 `<安装目录>\data` 是全部运行时数据的家，
// `%APPDATA%\FontManager` 退化成「老位置」+「最后兜底」。
//
// 这一段的代码密度高、事故面也高（老用户的标签/分组/收藏/台账/快照都在里面），
// 所以每一处都写清了「不这么做会出什么事故」。改之前先读 ADR-D3/D4（docs/架构设计-2.1.5）。
// ══════════════════════════════════════════════════════════════════════════

/// 产品目录名。必须与 `tauri.conf.json` 的 `productName` 保持一致 ——
/// 它同时是 `%APPDATA%\FontManager` 里的那个目录名（1.2.4 至今的老位置）。
pub const PRODUCT: &str = "FontManager";

/// 安装器在 `<安装目录>\data\.zfm-data-root` 写下的标记文件。
///
/// ⚠️ 它只表示「这个安装根启用了 data 布局」，**不代表迁移已经完成**。
/// 迁移是否完成只认 `state.json` 是否存在（见 [`migrate_to_data_root`]）：
/// 标记由安装器写、迁移由程序做，两者的时间点差着一次启动，混用必然出错。
pub const DATA_ROOT_MARKER: &str = ".zfm-data-root";

/// 「上次迁移搬了一半」的标记（内容：时间戳 + 源路径）。
///
/// 它挡的是本设计里最致命的一条事故链：
/// 迁移中途失败 → data 目录里只有半个 `state.json.tmp` → 下次启动看到空目录 →
/// 当成全新安装 → 把默认 state 写进去 → **用户几年的账本被一份空账本盖掉**。
/// 只要这个文件在，`load()` 就绝不会以「空账本」启动。
const MIGRATE_MARKER: &str = ".zfm-migrate-in-progress";

/// 写探针用的文件名（建完立刻删，绝不留下来）。
const PROBE_FILE: &str = ".zfm-probe";

/// `data_root` 是怎么定下来的。只用于日志与排障，**不参与任何业务判断**
/// （一旦有人拿它做 `if`，路径就又会分叉出第二种真相）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DataRootSource {
    /// 环境变量 `ZFM_DATA_DIR` 显式指定（排障 / QA 自动化，不写进用户文档）
    EnvOverride,
    /// `<exe 所在目录>\data` —— 正常路径
    InstallDir,
    /// `%LOCALAPPDATA%\FontManager\data` —— 装到 Program Files 时的回退
    LocalAppData,
    /// `%APPDATA%\FontManager` —— 最后兜底，保证软件永远不会因「没地方写」而崩
    RoamingFallback,
    /// macOS / Linux：与 2.1.4 完全一致，不做任何改道
    NotWindows,
}

impl DataRootSource {
    /// 日志里用的短标签。`grep source=install` 就知道这台机器的数据在哪。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EnvOverride => "env",
            Self::InstallDir => "install",
            Self::LocalAppData => "localappdata",
            Self::RoamingFallback => "roaming(fallback)",
            Self::NotWindows => "legacy",
        }
    }
}

/// 解析结果：路径 + 它是怎么来的
#[derive(Clone, Debug)]
pub struct DataRoot {
    pub path: PathBuf,
    pub source: DataRootSource,
}

/// 应用数据根目录 —— **全软件唯一入口**。
///
/// 名字故意**不**从 `app_data_dir` 改成更准确的名字：全仓十几个调用点靠这个
/// 语义变化自动跟随；改名得到的是「更准确的名字」，付的代价是十几处 diff ——
/// 而漏改一处，就会有一部分数据顽固地留在 C 盘，且只在「装到 D 盘」的机器上才暴露。
pub fn data_root() -> PathBuf {
    effective_data_root().path
}

/// 数据根 + 判定来源（只给启动日志与排障用）
pub fn data_root_info() -> (PathBuf, DataRootSource) {
    let root = effective_data_root();
    (root.path, root.source)
}

/// 2.1.4 及更早的位置：`%APPDATA%\FontManager`。
///
/// 只给三件事用，**不要再往业务代码里扩散**：
///   1. 迁移的源目录；
///   2. `plugins` 的老位置判定（`plugins::legacy_plugins_dir()` 的「老用户不搬家」规则
///      依赖这个确切路径，改错的表现是「老用户几十个插件在界面上全部消失」）；
///   3. 卸载白名单里的整删目标。
pub fn legacy_app_data_dir() -> PathBuf {
    // Windows 上 data_dir() 与 config_dir() 指向同一个目录（%APPDATA%），所以 2.1.4 的
    // app_data_dir()（走 data_dir）与 state_path()（走 config_dir）从来没有分开过。
    // 但 Linux 上两者不是同一个目录（~/.local/share vs ~/.config），而**账本一直写在
    // config_dir 那一侧**（老的 state_path 就是这么写的）。这里必须跟着账本走：
    // 选错那个，Linux 用户升个级就会「标签、分组、收藏全空」。
    #[cfg(target_os = "windows")]
    let base = dirs::data_dir();
    #[cfg(not(target_os = "windows"))]
    let base = dirs::config_dir();
    base.unwrap_or_else(|| PathBuf::from(".")).join(PRODUCT)
}

/// 程序自己所在的目录。调试构建返回 `None`。
///
/// 为什么调试构建不认：`cargo run` / `cargo test` 跑在 `rust-target\{debug,release}` 下，
/// 往那里写 1.7 MB 账本，下一次 `cargo clean` 就顺手把用户数据删了。
fn install_dir() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.to_path_buf())
}

/// 写探针：建目录 → 写一个空文件 → 立刻删。
///
/// 为什么用「真的写一遍」而不是读 ACL：ACL 要自己推演「当前用户 / 管理员组 / 继承的
/// 拒绝项」算出来的 effective rights，代码量与出错面都远大于写一个 0 字节文件；
/// 而探针是**结果导向**的，Windows 怎么算权限都对。口径与 `scanner::is_writable_dir()`
/// 一致（那边已经跑了一个大版本，坑都踩过了：探针文件必须删掉、别写带 BOM 的内容）。
fn probe_writable(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(PROBE_FILE);
    match fs::write(&probe, b"") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 「本次进程已经把数据根钉回老位置」。
///
/// 只在迁移失败时置位（见 [`effective_data_root`]）。迁移成功 / 无需迁移时永远是 false。
static MIGRATION_FAILED: AtomicBool = AtomicBool::new(false);

/// 只在进程生命周期内解析一次（`OnceLock`）。
fn data_root_cached() -> &'static DataRoot {
    static CELL: OnceLock<DataRoot> = OnceLock::new();
    // 为什么必须缓存：`diag::log()` **每次写日志**都会问一次路径，而探针要
    // create_dir_all + 写文件 + 删文件。更关键的是「锚定一次」的语义 ——
    // 启动后路径不允许再变，否则同一进程里 state.json 会写到两个地方。
    CELL.get_or_init(resolve_data_root)
}

/// 本次进程**实际**使用的数据根（迁移失败时会被钉回老位置）。
///
/// 为什么不直接改 `DATA_ROOT` 里那份缓存：`OnceLock` 天生不能再写，
/// 而「迁移失败 → 本次继续用老位置」是设计里明确要求的行为（§5.2 失败矩阵）。
/// 用两个静态量分工：`DATA_ROOT` 记「本来想去哪」，这个函数给出「最终落在哪」。
fn effective_data_root() -> DataRoot {
    let base = data_root_cached();
    if MIGRATION_FAILED.load(Ordering::Relaxed) && base.source != DataRootSource::NotWindows {
        return DataRoot {
            path: legacy_app_data_dir(),
            source: DataRootSource::RoamingFallback,
        };
    }
    base.clone()
}

/// 四级判定（顺序不能变，见 ADR-D3）
fn resolve_data_root() -> DataRoot {
    // ── 非 Windows：一行都不能变 ──
    //
    // macOS 的安装单位是 .app 包，签名后 `Contents/MacOS/data` 不可写（Gatekeeper /
    // App Translocation 会把它变只读或变副本），数据写进去 = 用户数据凭空消失；
    // Linux 走 deb/AppImage，`/usr/lib/...` 同样不可写。而这次的改道需求本身
    // 就来自「Windows 安装包 + 装到 D 盘」，只有 Windows 有 `$INSTDIR` 这个概念。
    #[cfg(not(target_os = "windows"))]
    {
        return DataRoot {
            path: legacy_app_data_dir(),
            source: DataRootSource::NotWindows,
        };
    }

    #[cfg(target_os = "windows")]
    {
        // 0. 显式覆盖：排障 / QA 自动化。必须是绝对路径，且真的可写，否则忽略。
        if let Some(dir) = std::env::var_os("ZFM_DATA_DIR")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
        {
            if probe_writable(&dir) {
                return DataRoot {
                    path: dir,
                    source: DataRootSource::EnvOverride,
                };
            }
        }

        // 调试构建不进安装目录（会污染 rust-target\debug）→ 直接走老位置
        let Some(base) = install_dir() else {
            return DataRoot {
                path: legacy_app_data_dir(),
                source: DataRootSource::RoamingFallback,
            };
        };

        let dir = base.join("data");

        // 1. 已存在即锚定 —— 绝不因为一次探针抖动就在两个位置之间横跳。
        //
        //    反例（每次重新探测）：用户今天以管理员身份跑了一次（Program Files 可写），
        //    明天普通权限跑（不可写）→ 数据一半在新位置一半在 LOCALAPPDATA，
        //    用户看到的是「我的标签怎么少了一半」，而我们连查都没法查。
        //
        //    判据里为什么还认 `.zfm-migrate-in-progress`：那是「上次搬到一半」的现场，
        //    必须继续锚在这里重试，否则会留下一个半搬的空目录、下次又跑到别处去。
        if dir.is_dir()
            && (dir.join("state.json").is_file()
                || dir.join(DATA_ROOT_MARKER).is_file()
                || dir.join(MIGRATE_MARKER).is_file())
        {
            return DataRoot {
                path: dir,
                source: DataRootSource::InstallDir,
            };
        }
        // 2. 可写 → 直接建（首次安装 / 首次以可写权限运行）
        if probe_writable(&dir) {
            return DataRoot {
                path: dir,
                source: DataRootSource::InstallDir,
            };
        }
        // 3. 回退：默认安装目录就是 %LOCALAPPDATA%\FontManager，所以**对默认安装的用户，
        //    这一条与第 2 条指向同一个目录** —— 不可能出现「回退后到处是第二份数据」。
        //    这是特意选的，不是巧合。
        if let Some(local) = dirs::data_local_dir() {
            let dir = local.join(PRODUCT).join("data");
            if probe_writable(&dir) {
                return DataRoot {
                    path: dir,
                    source: DataRootSource::LocalAppData,
                };
            }
        }
        // 4. 兜底：2.1.4 的老位置。宁可留在 C 盘，也不能让软件因为「没地方写数据」而崩。
        DataRoot {
            path: legacy_app_data_dir(),
            source: DataRootSource::RoamingFallback,
        }
    }
}

fn state_path() -> PathBuf {
    data_root().join("state.json")
}

/// 偏好的独立小文件（1.8.1 审查项 P3）。
///
/// 为什么拆：`state.json` 实测 1.77 MB，其中 1.58 MB 是 `added` / `linked` / `notes`
/// 这些**字体库数据**，偏好本身只有约 20 KB。改一个「界面音效」开关也要整份重写，
/// 磁盘写放大近 90 倍。纯偏好写入改走 [`save_prefs`]，只碰这个小文件。
fn prefs_path() -> PathBuf {
    state_path().with_file_name("prefs.json")
}

/// 原子写一个 JSON 文件：先写 .tmp 再 rename，写一半断电也不会留下半份文件。
fn write_json_atomic<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    write_bytes_atomic(path, &json)
}

fn write_bytes_atomic(path: &Path, json: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// 读主文件的三种结局。**「读不出来」和「没有文件」必须分开**：
/// 前者是事故（文件被截断 / 字段不认识 / 磁盘坏道），后者才是全新安装。
enum ReadOutcome {
    Ok(AppState),
    Missing,
    Broken(String),
}

fn read_state_file(path: &Path) -> ReadOutcome {
    match fs::read(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ReadOutcome::Missing,
        Err(e) => ReadOutcome::Broken(format!("读不出来：{e}")),
        // 0 字节 / 只剩空白：典型的中途断电或磁盘满，serde 只会报个含糊的 EOF
        Ok(b) if b.iter().all(|c| c.is_ascii_whitespace()) => {
            ReadOutcome::Broken("文件是空的（0 字节或只剩空白）".into())
        }
        Ok(b) => match serde_json::from_slice::<AppState>(&b) {
            Ok(s) => ReadOutcome::Ok(s),
            Err(e) => ReadOutcome::Broken(format!("解析失败：{e}")),
        },
    }
}

/// 坏文件**绝不原地丢弃**：改名留证（`state.corrupt-<unix 秒>.json`），再试滚动备份。
///
/// 2026-11-11 真机事故：`state.json` 从 1.7 MB 被写成 16 KB，备注 / 标签 / 库配置全空，
/// 界面上只剩 324 个系统字体。旧代码把「解析失败」当成「全新安装」，接着任何一次保存
/// 都把那份默认状态写回磁盘 —— 用户几年的数据就这么无声无息地没了，日志里一个字都没有。
/// 现在的顺序是「先留证 → 再回滚 → 最后才认命」，每一步都写日志。
fn recover_broken_state(path: &Path, why: &str) -> AppState {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let keep = path.with_file_name(format!("state.corrupt-{stamp}.json"));
    match fs::rename(path, &keep) {
        Ok(()) => crate::diag::log(&format!(
            "store: state.json {why}；坏文件已留证 → {}",
            keep.display()
        )),
        Err(e) => crate::diag::log(&format!(
            "store: state.json {why}；而且留证改名也失败了（{e}），继续尝试从备份恢复"
        )),
    }
    let bak = path.with_file_name("state.json.bak");
    match fs::read(&bak)
        .ok()
        .and_then(|b| serde_json::from_slice::<AppState>(&b).ok())
    {
        Some(s) => {
            crate::diag::log(&format!(
                "store: 已从 {} 恢复（{} 条备注 / {} 个入库记录）",
                bak.display(),
                s.notes.len(),
                s.added.len()
            ));
            s
        }
        None => {
            crate::diag::log("store: 没有可用的 state.json.bak，只能按全新安装启动");
            AppState::default()
        }
    }
}

fn load_state_file(path: &Path) -> AppState {
    match read_state_file(path) {
        ReadOutcome::Ok(s) => s,
        ReadOutcome::Missing => AppState::default(),
        ReadOutcome::Broken(why) => recover_broken_state(path, &why),
    }
}

/// 覆盖前留一份滚动备份（`state.json.bak`）。
///
/// 备份点放在**覆盖之前**，所以「将要毁掉数据的那一次保存」正好是留下好文件的那一次。
/// 节流（默认 10 分钟最多一次）是为了不让每次启停字体都拷 1.7 MB；
/// 任何失败都只记日志 —— 备份不该反过来挡住正常保存。
fn backup_before_overwrite(path: &Path, min_gap: std::time::Duration) -> Option<PathBuf> {
    fs::metadata(path).ok()?; // 首次落盘，没有旧文件可备份
    let bak = path.with_file_name("state.json.bak");
    if let Ok(bmeta) = fs::metadata(&bak) {
        let fresh = bmeta
            .modified()
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|d| d < min_gap)
            .unwrap_or(false);
        if fresh {
            return None;
        }
    }
    match fs::copy(path, &bak) {
        Ok(_) => Some(bak),
        Err(e) => {
            crate::diag::log(&format!("store: 滚动备份失败（继续保存）：{e}"));
            None
        }
    }
}

/// 两份文件体积差得离谱 = 数据要丢了的强信号（正常增删不会差 4 倍）。
/// 只记日志、不拦保存：拦下来会让用户的操作直接失败，而 .bak 已经留好了。
fn warn_size_cliff(old: u64, new: usize, bak: Option<&Path>) {
    if old >= 200 * 1024 && (new as u64) * 4 < old {
        crate::diag::log(&format!(
            "store: ⚠️ 体积断崖 {old} → {new} 字节，疑似数据丢失（旧文件已备份到 {}）",
            bak.map(|p| p.display().to_string())
                .unwrap_or_else(|| "<备份失败>".into())
        ));
    }
}

/// **只**保存偏好（约 20 KB）。调用前提：这次改动确实只动了 `state.prefs`。
pub fn save_prefs(state: &AppState) -> Result<(), String> {
    write_json_atomic(&prefs_path(), &state.prefs)
}

/// 2.1.5 起只是 [`data_root`] 的转发 —— 名字保留是为了不动那十几个调用点
/// （改名 = 十几处 diff，漏一处的后果是「一部分数据顽固地留在 C 盘」，
/// 且只在装到 D 盘的机器上才暴露）。
pub fn app_data_dir() -> PathBuf {
    data_root()
}

pub fn trash_dir() -> PathBuf {
    data_root().join("Trash")
}

/// 1.2.4 改名后数据目录也跟着换了名字。
///
/// 升级上来的用户 `state.json`（4211 个族的标签/分组/收藏/启停状态）全在旧目录里，
/// 不搬过来就等于「升个级库全空了」。规则：
/// - 新目录已存在就什么都不做（用户已经在新目录里干过活，别拿旧的盖掉）；
/// - 只复制小文件与 Trash，**跳过两个缓存目录**（preview-cache 384 MB、thumb-cache），
///   它们能重新生成，搬一遍纯属浪费时间和磁盘；
/// - 旧目录保留不删 —— 万一搬错还能回头拿。
///
/// 旧目录名拆成两段拼接：源码里不再出现旧品牌名，但这段迁移**绝不能删** ——
/// 删了等于让 1.2.3 及以前的用户升级后收藏、标签、评分全部消失。
///
/// 2.1.5：日志改成「先收集、后统一写」。原因见 [`migrate_to_data_root`]：
/// 这一步跑的时候数据根还没定下来，直接 `diag::log` 会把日志写进一个随后不再使用的位置。
fn migrate_legacy_dirs(notes: &mut Vec<String>) {
    const SKIP: [&str; 2] = ["preview-cache", "thumb-cache"];
    const LEGACY_DIR: [&str; 2] = ["Z", "FontManager"];
    let legacy_name = LEGACY_DIR.concat();
    let bases = [dirs::data_dir(), dirs::config_dir()];
    for base in bases.into_iter().flatten() {
        let old = base.join(&legacy_name);
        let new = base.join("FontManager");
        if new.exists() || !old.exists() {
            continue;
        }
        if let Err(e) = copy_dir_filtered(&old, &new, &SKIP) {
            notes.push(format!("store: legacy data migration failed: {e}"));
        } else {
            notes.push(format!(
                "store: migrated legacy data {} -> {}",
                old.display(),
                new.display()
            ));
        }
    }
}

fn copy_dir_filtered(src: &Path, dst: &Path, skip: &[&str]) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        if skip.iter().any(|s| name.to_string_lossy() == *s) {
            continue;
        }
        let to = dst.join(&name);
        if entry.file_type()?.is_dir() {
            copy_dir_filtered(&entry.path(), &to, skip)?;
        } else {
            fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// 迁移的结局。`Fallback` 与 `Fatal` 的区别只有一条：**还有没有救**。
enum MigrationOutcome {
    /// 迁移成功 / 无需迁移（全新安装、已经搬过、非 Windows）
    Done,
    /// 搬不动，但老位置完好 → 本次继续用老位置，下次启动重试
    Fallback,
    /// 老位置也没有可用账本，且现场显示「上次搬了一半」→ 绝不能用空账本启动
    Fatal(String),
}

/// 必须搬的白名单（除此之外一律不搬）。
///
/// 为什么精确列举而不是「整个目录 copy 一遍」：老位置里躺着 `preview-cache`
/// （实测 385 MB）和 `thumb-cache`（上限 256 MB），两者都是纯生成物，
/// 搬一遍要读 640 MB 写 640 MB（机械盘上是分钟级），而用户感受是「升级卡住了」。
const MIGRATE_DIRS: [&str; 3] = ["Trash", "online", "Deactivated"];
const MIGRATE_FILES: [&str; 5] = [
    "font-cache.json",
    "system-ps.json",
    "api.json",
    "activation.log",
    "activation.log.old.log",
];
/// 前缀匹配：`state.json` / `state.json.bak` / `state.json.bak-*` / `prefs.json.bak-*` 都要带上。
/// 账本的滚动备份是 `read_state_file` 的救命绳，漏掉它等于迁移时把保险丝一起扔了。
const MIGRATE_PREFIXES: [&str; 2] = ["state.json", "prefs.json"];

/// 把 2.1.4 的 `%APPDATA%\FontManager` 搬到 `<安装目录>\data`。
///
/// 三条铁律（§ADR-D4）：
/// 1. **copy 不 move**：move 到一半失败（磁盘满 / 权限 / 被杀软拦）时源文件已经没了，
///    用户是真丢数据；而且用户回退到 2.1.4 时还能接着用旧位置（回退是真实发生的场景）。
/// 2. **先账本后缓存**：`state.json` 是唯一「丢了就不可逆」的东西，它先落地。
/// 3. **失败就原地不动**：任何一步失败都不许让软件以空账本启动 —— 宁可这次不改道。
///
/// 日志全部收集到 `notes` 里由调用方统一写：这一步跑的时候 `data_root` 可能还会被回退，
/// 现在写日志会分裂到两个文件，而且会在 data 目录里先建一个 activation.log 再被 copy 覆盖。
fn migrate_to_data_root(notes: &mut Vec<String>) -> MigrationOutcome {
    let target = data_root_cached().path.clone();
    let source = legacy_app_data_dir();
    if target == source {
        // 非 Windows（data_root 就等于老位置），或用户把软件装在了 %APPDATA%\FontManager。
        return MigrationOutcome::Done;
    }

    let in_progress = target.join(MIGRATE_MARKER);
    let target_state = target.join("state.json");
    let source_state = source.join("state.json");

    // ① 幂等出口：唯一判据是**目标账本存不存在**，不用标记文件。
    //    标记文件和「实际有没有数据」可能不一致（标记写了但 copy 失败），
    //    而 state.json 的存在性本身就是最强的证据。
    if target_state.is_file() {
        if in_progress.exists() {
            // 上次在「删标记」和「写账本」之间被打断：账本已经在了，补删标记即可。
            let _ = fs::remove_file(&in_progress);
            notes.push(format!(
                "store: 数据已在 {}，清掉残留的 in-progress 标记",
                target.display()
            ));
        }
        return MigrationOutcome::Done;
    }

    // ② 老位置没有账本 = 全新安装（或用户自己清空了 %APPDATA%），没什么可搬。
    if !source_state.is_file() {
        if in_progress.is_file() {
            // 「标记在 + 两边都没有账本」：上次搬到一半、源又被删了。
            // 这种情况没有任何一份可信的账本，只能用空账本 —— 但空账本一旦落盘就会
            // 覆盖掉可能还存在的 state.json.bak，所以宁可让用户看见一个明确的报错。
            return MigrationOutcome::Fatal(format!(
                "数据位置异常：\n{} 里没有可用的 state.json，而 {} 显示上次数据搬迁未完成。\n\n\
                 请把 {} 整个复制出来备份后再启动；\n\
                 如需重来，删掉 {} 后重新启动软件。",
                source.display(),
                in_progress.display(),
                source.display(),
                in_progress.display()
            ));
        }
        return MigrationOutcome::Done;
    }

    // ③ 打标记。写不进去就整段放弃 —— 写不进标记说明目标盘本身有问题，
    //    硬搬下去只会在下次启动留下一个「看起来像全新安装」的 data 目录。
    if let Err(e) = write_migrate_marker(&in_progress, &source) {
        notes.push(format!(
            "store: 写迁移标记失败，放弃本次数据搬迁（继续用 {}）：{e}",
            source.display()
        ));
        return MigrationOutcome::Fallback;
    }
    notes.push(format!(
        "store: 开始把数据搬到 {}（源 {}）",
        target.display(),
        source.display()
    ));

    // ④ 账本：写 .tmp → 校验能解析 → rename 生效。
    //
    //    为什么不能直接 copy 到 state.json：copy 被打断会在目标留下半份文件，
    //    而 `load_state_file` 会把它当「坏文件」留证 + 回滚 .bak，
    //    用户看到的就是「标签少了一半」而且原因完全看不出来。
    //    为什么还要校验源文件：源本身坏了（1.7 MB 被写成 16 KB 那种真机事故）时
    //    留在原地走现有的 recover_broken_state 更安全，别把坏文件搬进新家。
    if let Err(e) = copy_state_verified(&source_state, &target_state) {
        notes.push(format!(
            "store: 账本搬迁失败，本次继续使用 {}（下次启动重试）：{e}",
            source.display()
        ));
        // 标记**故意保留**：它保证下次启动不会把半搬的 data 目录当成全新安装。
        return MigrationOutcome::Fallback;
    }

    // ⑤ 其余白名单小文件 / 目录：单个失败只记日志继续（它们都可重建或有默认值），
    //    **但会记进 failures** —— 因为「删旧缓存」的条件之一就是「全都搬成功」。
    let mut failures: Vec<String> = Vec::new();
    copy_whitelist(&source, &target, &mut failures, notes);

    // ⑥ 插件：只在 `<安装目录>\plugins` 还不存在时搬。
    //    为什么用「先 copy 到临时目录再改名」：直接往 `<install>\plugins` 里拷，
    //    拷一半失败会留下一个内容不全的 plugins 目录，而 `plugins::resolve_plugins_dir()`
    //    的规则是「新位置有插件就不用老位置」—— 用户会在界面上看到「插件忽然少了一半」，
    //    文件其实一个没丢。改成改名之后，要么整份都在，要么完全没出现过。
    copy_plugins_once(&source, &target, &mut failures, notes);

    // ⑦ 收尾：先记账再删标记（顺序反了会留下「标记没了但 migrated 也没写」的窗口）。
    append_marker_line(
        &target.join(DATA_ROOT_MARKER),
        &format!(
            "migrated=1 version={} from={}",
            env!("CARGO_PKG_VERSION"),
            source.display()
        ),
        notes,
    );
    if let Err(e) = fs::remove_file(&in_progress) {
        notes.push(format!("store: 删除迁移标记失败（不影响数据）：{e}"));
    }

    // ⑧ **唯一**会删东西的地方：删掉老位置的两个纯缓存目录。
    //    三个条件必须同时成立，任一不满足就一个字节都不删（R-03）：
    //      1. 目标账本已写入且真的能反序列化（证明不是搬了个空文件）；
    //      2. 白名单全部搬成功（不是「中途报错退出」）；
    //      3. 目标不是老位置本身（真的改道了）。
    let state_ok = fs::read(&target_state)
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .is_some();
    if state_ok && failures.is_empty() {
        for cache in ["preview-cache", "thumb-cache"] {
            let dir = source.join(cache);
            if !dir.is_dir() {
                continue;
            }
            match fs::remove_dir_all(&dir) {
                Ok(()) => notes.push(format!(
                    "store: 已清理旧缓存目录 {}（纯生成物，会自动重建）",
                    dir.display()
                )),
                // 文件被占用是常态（预览/缩略图还在被读），不重试也不影响功能。
                Err(e) => notes.push(format!(
                    "store: 旧缓存目录 {} 删不掉（不影响功能，用户可手动删）：{e}",
                    dir.display()
                )),
            }
        }
    } else if !failures.is_empty() {
        notes.push(format!(
            "store: 有 {} 项没能搬过去，旧缓存目录保留不删：{}",
            failures.len(),
            failures.join("；")
        ));
    }

    notes.push(format!(
        "store: 数据搬迁完成 → {}（旧位置保留一份副本，回退到 2.1.4 仍可用）",
        target.display()
    ));
    MigrationOutcome::Done
}

/// 写「搬家进行中」标记。内容只有时间戳与源路径，方便事后对着日志还原现场。
fn write_migrate_marker(path: &Path, source: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    fs::write(
        path,
        format!("started={stamp}\r\nsource={}\r\n", source.display()),
    )
    .map_err(|e| e.to_string())
}

/// 往 `.zfm-data-root` **追加**一行（不是覆盖）：安装器写的是 `v=1`，
/// 这里追加 `migrated=1`，两个信息要能同时在。
fn append_marker_line(path: &Path, line: &str, notes: &mut Vec<String>) {
    use std::io::Write;
    match fs::OpenOptions::new().create(true).append(true).open(path) {
        Ok(mut f) => {
            if let Err(e) = writeln!(f, "{line}") {
                notes.push(format!("store: 写 {} 失败（不影响数据）：{e}", path.display()));
            }
        }
        Err(e) => notes.push(format!(
            "store: 打不开 {}（不影响数据）：{e}",
            path.display()
        )),
    }
}

/// copy 账本到目标：读源 → 校验源可解析 → 写 `.tmp` → 回读校验 → rename。
fn copy_state_verified(src: &Path, dst: &Path) -> Result<(), String> {
    let bytes = fs::read(src).map_err(|e| format!("读源账本失败：{e}"))?;
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .map_err(|e| format!("源账本本身解析不了（留给原地的坏文件流程处理）：{e}"))?;
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = dst.with_extension("json.tmp");
    fs::write(&tmp, &bytes).map_err(|e| format!("写临时文件失败：{e}"))?;
    // 回读校验：磁盘满时 fs::write 可能已经「成功」但内容不完整。
    let back = fs::read(&tmp).map_err(|e| format!("回读临时文件失败：{e}"))?;
    if back != bytes {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "回读内容与源不一致（{} vs {} 字节），多半是磁盘满",
            back.len(),
            bytes.len()
        ));
    }
    fs::rename(&tmp, dst).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("改名生效失败：{e}")
    })
}

/// 白名单里的文件与目录。
fn copy_whitelist(source: &Path, target: &Path, failures: &mut Vec<String>, notes: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(source) else {
        failures.push(format!("读不了源目录 {}", source.display()));
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // 半成品一律不搬：`.tmp` 是上一次写一半留下的，搬过去只会误导下一个人。
        // `state.json` 由 ④ 用「校验 + rename」单独搬过，这里跳过免得绕开那道闸。
        if name.ends_with(".tmp") || name == "state.json" {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let wanted = if is_dir {
            MIGRATE_DIRS.contains(&name.as_str())
        } else {
            MIGRATE_FILES.contains(&name.as_str())
                || MIGRATE_PREFIXES.iter().any(|p| name.starts_with(p))
        };
        if !wanted {
            continue;
        }
        let to = target.join(&name);
        let result = if is_dir {
            copy_dir_filtered(&entry.path(), &to, &[])
        } else {
            fs::copy(entry.path(), &to).map(|_| ())
        };
        match result {
            Ok(()) => {}
            Err(e) => {
                // 单个文件失败不影响账本迁移：用户最多丢一个可重建的缓存。
                // 但 Trash 里可能有用户还要恢复的字体，要说清楚「旧的那份还在」。
                let tail = if name == "Trash" {
                    "（旧目录里的原件还在，用户没丢东西）"
                } else {
                    ""
                };
                notes.push(format!("store: 搬 {name} 失败（跳过，继续）{tail}：{e}"));
                failures.push(name);
            }
        }
    }
}

/// 老位置的插件目录 → `<安装目录>\plugins`，**仅当后者不存在**。
fn copy_plugins_once(
    source: &Path,
    target: &Path,
    failures: &mut Vec<String>,
    notes: &mut Vec<String>,
) {
    let Some(install_root) = target.parent() else {
        return;
    };
    let legacy = source.join("plugins");
    let dest = install_root.join("plugins");
    if dest.exists() || !legacy.is_dir() {
        return;
    }
    let staging = install_root.join(".zfm-plugins-copying");
    let _ = fs::remove_dir_all(&staging);
    match copy_dir_filtered(&legacy, &staging, &[]) {
        Ok(()) => match fs::rename(&staging, &dest) {
            Ok(()) => notes.push(format!(
                "store: 插件已复制到 {}（老位置的副本保留）",
                dest.display()
            )),
            Err(e) => {
                let _ = fs::remove_dir_all(&staging);
                notes.push(format!("store: 插件目录改名失败（跳过）：{e}"));
                failures.push("plugins".into());
            }
        },
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            notes.push(format!("store: 插件目录复制失败（跳过）：{e}"));
            failures.push("plugins".into());
        }
    }
}

/// 把收集到的日志一次性写出去。
///
/// 统一在 `data_root` 定下来之后调用：迁移期间写日志会分裂到两个文件，
/// 还会在 data 目录里先建一个 activation.log 再被 copy 覆盖（丢掉会话头）。
fn flush_notes(notes: &[String]) {
    for line in notes {
        crate::diag::log(line);
    }
}

/// 真的没救了才走这里：`%APPDATA%` 与 data 目录里都没有可用账本，
/// 而现场显示「上次搬了一半」。这时候**绝不能**落一份默认 state ——
/// 用户几年的标签、分组、收藏会在一瞬间被覆盖，且不可逆。
fn fatal_state_dir_error(detail: &str) {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
        let text = wide(detail);
        let caption = wide("FontManager");
        // SAFETY: 两个字符串都以 NUL 结尾、生命周期覆盖调用过程；窗口句柄传空表示无父窗口。
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                caption.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        eprintln!("FontManager: {detail}");
    }
    std::process::exit(1);
}

pub fn load() -> AppState {
    let mut notes: Vec<String> = Vec::new();
    migrate_legacy_dirs(&mut notes);
    // 数据根改道必须发生在**读 state 之前**：它决定 `state_path()` 指向哪里，
    // 也可能因为搬不动而把数据根回退到老位置（见 effective_data_root）。
    match migrate_to_data_root(&mut notes) {
        MigrationOutcome::Done => {}
        MigrationOutcome::Fallback => {
            MIGRATION_FAILED.store(true, Ordering::Relaxed);
            notes.push(format!(
                "store: 本次数据根回退到 {}（迁移未完成，还没完成的那部分下次启动重试）",
                legacy_app_data_dir().display()
            ));
        }
        MigrationOutcome::Fatal(why) => {
            notes.push(format!("store: 数据位置异常，已停止启动：{why}"));
            flush_notes(&notes);
            fatal_state_dir_error(&why);
        }
    }
    flush_notes(&notes);

    let path = state_path();
    let mut state = load_state_file(&path);
    // 偏好以 prefs.json 为准（1.8.1 拆分）。老用户没有这个文件 → 用 state.json 里的
    // 那份并当场补写一份，之后纯偏好改动就再也不用重写 1.7 MB 的主文件了。
    let pf = prefs_path();
    match fs::read(&pf)
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
    {
        Some(v) if v.is_object() => state.prefs = v,
        _ => {
            if let Err(e) = write_json_atomic(&pf, &state.prefs) {
                crate::diag::log(&format!("store: 生成 prefs.json 失败，继续用 state.json：{e}"));
            }
        }
    }
    // 历史遗留清理（C4）：早期版本把系统字体也记进了 deactivated，那些条目永远改不动，
    // 每次 reconcile 都重试一遍、失败一遍，右上角反复弹「无法卸载系统字体」。
    // 只可能是我们自己写进去的（用户无从手动编辑 state.json），直接剔掉并立刻落盘。
    let before = state.deactivated.len();
    state.deactivated.retain(|p| !crate::activation::is_system_font(p));
    if state.deactivated.len() != before {
        crate::diag::log(&format!(
            "store: dropped {} protected system-font entries from deactivated",
            before - state.deactivated.len()
        ));
        if let Err(e) = save(&state) {
            crate::diag::log(&format!("store: failed to persist deactivated cleanup: {e}"));
        }
    }
    // 台账的同类清理（2.1.4）：系统字体路径不该出现在台账里。写入侧已经挡过一道
    // （`record_activated`），这里兜住历史脏数据与手工改过的 state.json ——
    // 留着的唯一后果是每次启动都为这几条白算一次种子，但它会让「台账 = 用户意图」这个
    // 前提失效，排查时非常迷惑，所以宁可当场剔掉并落盘一次。
    let before_activated = state.activated.len();
    state
        .activated
        .retain(|p| !crate::activation::is_system_font(p));
    if state.activated.len() != before_activated {
        crate::diag::log(&format!(
            "store: dropped {} protected system-font entries from activated ledger",
            before_activated - state.activated.len()
        ));
        if let Err(e) = save(&state) {
            crate::diag::log(&format!("store: failed to persist activated cleanup: {e}"));
        }
    }
    // 1.2.6：默认库从「Windows 用户字体目录」搬到了安装目录。
    // 老用户（没开自定义文件夹、但确实往旧默认库导入过字体）必须把地址**钉死在旧目录**上：
    // 否则升级后库一下子变空，几千个字体全变成「用户字体」，停用也停不掉。
    let pinned_before = state.library_dir.clone();
    if pin_legacy_library(&mut state) {
        crate::diag::log(&format!(
            "store: pinned legacy library {} -> {}",
            pinned_before.unwrap_or_else(|| "<default>".into()),
            state.library_dir.clone().unwrap_or_default()
        ));
        if let Err(e) = save(&state) {
            crate::diag::log(&format!("store: failed to persist legacy library pin: {e}"));
        }
    }
    state
}

/// 老默认库（`%LOCALAPPDATA%\Microsoft\Windows\Fonts`）里还有我们导入过的字体时，
/// 把库地址显式钉在它上面。返回是否真的改了状态。
#[cfg(target_os = "windows")]
fn pin_legacy_library(state: &mut AppState) -> bool {
    if state.library_dir.is_some() || !state.library_dirs.is_empty() {
        return false;
    }
    let legacy = crate::scanner::legacy_managed_font_dir();
    let legacy_str = legacy.to_string_lossy().to_lowercase();
    let used = state
        .added
        .keys()
        .chain(state.linked.iter())
        .any(|p| p.to_lowercase().starts_with(&legacy_str));
    if !used {
        return false;
    }
    let dir = legacy.to_string_lossy().into_owned();
    state.library_dir = Some(dir.clone());
    state.library_dirs = vec![dir];
    state.library_dir_enabled = true;
    true
}

#[cfg(not(target_os = "windows"))]
fn pin_legacy_library(_state: &mut AppState) -> bool {
    false
}

pub fn save(state: &AppState) -> Result<(), String> {
    let path = state_path();
    let json = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    // 先备份旧文件，再覆盖：见 backup_before_overwrite 的注释
    let old = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let bak = backup_before_overwrite(&path, std::time::Duration::from_secs(600));
    warn_size_cliff(old, json.len(), bak.as_deref());
    write_bytes_atomic(&path, &json)?;
    // 两份必须同步：万一 prefs.json 被删/损坏，load() 回退到 state.json 时
    // 不能读到一个几周前的旧偏好。写失败只记日志，主文件已经落盘了。
    if let Err(e) = save_prefs(state) {
        crate::diag::log(&format!("store: prefs.json 同步失败（不影响 state.json）：{e}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 新版快照：只存可移植标识，序列化后不能出现绝对路径
    #[test]
    fn portable_snapshot_has_no_path() {
        let snap = Snapshot {
            name: "work".into(),
            created_at: 1,
            entries: vec![SnapshotEntry {
                key: "ps:inter-regular".into(),
                path: None,
                family: "Inter".into(),
                style: "Regular".into(),
                system: false,
            }],
        };
        let json = serde_json::to_string(&snap).unwrap();
        assert!(json.contains("\"key\":\"ps:inter-regular\""));
        assert!(!json.contains("path"));
        // 往返一致
        let back: Snapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(back.entries[0].key, "ps:inter-regular");
        assert!(back.entries[0].path.is_none());
    }

    /// 旧版快照（绝对路径）仍能读入，路径保留下来供前端迁移
    #[test]
    fn legacy_path_snapshot_still_loads() {
        let json = r#"{
            "snapshots": [{
                "name": "old",
                "createdAt": 0,
                "entries": [{"path": "D:\\Fonts\\Inter-Regular.ttf", "family": "Inter", "system": false}]
            }]
        }"#;
        let state: AppState = serde_json::from_str(json).unwrap();
        let entry = &state.snapshots[0].entries[0];
        assert_eq!(entry.key, "");
        assert_eq!(entry.path.as_deref(), Some("D:\\Fonts\\Inter-Regular.ttf"));
    }

    /// 更旧的 HashMap<String, Vec<String>> 格式也能迁移
    #[test]
    fn hashmap_snapshot_still_loads() {
        let json = r#"{"snapshots": {"old": ["C:\\Windows\\Fonts\\arial.ttf"]}}"#;
        let state: AppState = serde_json::from_str(json).unwrap();
        assert_eq!(state.snapshots.len(), 1);
        assert_eq!(
            state.snapshots[0].entries[0].path.as_deref(),
            Some("C:\\Windows\\Fonts\\arial.ttf")
        );
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zfm-store-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// 主文件不存在 = 全新安装：默认状态，不制造任何 .corrupt 文件
    #[test]
    fn missing_state_is_fresh_install() {
        let d = tmp_dir("missing");
        let p = d.join("state.json");
        let s = load_state_file(&p);
        assert!(s.notes.is_empty() && s.added.is_empty());
        let corrupt: Vec<_> = fs::read_dir(&d)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("corrupt"))
            .collect();
        assert!(corrupt.is_empty(), "没有坏文件就别造一个出来");
        let _ = fs::remove_dir_all(&d);
    }

    /// 2026-11-11 事故的复现：主文件坏了，但 .bak 好 → 必须自动回滚，且坏文件留证
    #[test]
    fn broken_state_rolls_back_to_backup() {
        let d = tmp_dir("rollback");
        let p = d.join("state.json");
        let bak = d.join("state.json.bak");

        let mut good = AppState::default();
        good.notes.insert("思源黑体".into(), "这是用户写的备注".into());
        good.library_dir = Some(r"E:\字体库".into());
        fs::write(&bak, serde_json::to_vec(&good).unwrap()).unwrap();

        fs::write(&p, b"{\"notes\": {\"broken").unwrap(); // 截断的 JSON

        let s = load_state_file(&p);
        assert_eq!(s.notes.len(), 1, "必须从备份里把备注捞回来");
        assert_eq!(s.library_dir.as_deref(), Some(r"E:\字体库"));
        assert!(!p.exists(), "坏文件不该留在原位（否则下次还会被它挡住）");

        let kept: Vec<_> = fs::read_dir(&d)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("state.corrupt-"))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(kept.len(), 1, "坏文件必须留证，方便事后查是怎么坏的");
        let _ = fs::remove_dir_all(&d);
    }

    /// 坏文件 + 没有备份：留证后按全新安装走（总比原地丢弃强，至少证据还在）
    #[test]
    fn broken_state_without_backup_keeps_evidence() {
        let d = tmp_dir("nobak");
        let p = d.join("state.json");
        fs::write(&p, b"").unwrap(); // 0 字节：断电 / 磁盘满的典型形态

        let s = load_state_file(&p);
        assert!(s.notes.is_empty());
        assert!(!p.exists());
        assert_eq!(
            fs::read_dir(&d)
                .unwrap()
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with("state.corrupt-"))
                .count(),
            1
        );
        let _ = fs::remove_dir_all(&d);
    }

    /// 覆盖前备份：min_gap=0 时每次都留；节流期内不再重复拷
    #[test]
    fn overwrite_backs_up_once_per_window() {
        let d = tmp_dir("bak");
        let p = d.join("state.json");
        let bak = d.join("state.json.bak");

        assert!(backup_before_overwrite(&p, std::time::Duration::ZERO).is_none(), "没有旧文件就没什么可备份");

        fs::write(&p, b"v1").unwrap();
        let got = backup_before_overwrite(&p, std::time::Duration::ZERO).expect("应当留下备份");
        assert_eq!(got, bak);
        assert_eq!(fs::read(&bak).unwrap(), b"v1");

        fs::write(&p, b"v2-longer").unwrap();
        assert!(
            backup_before_overwrite(&p, std::time::Duration::from_secs(600)).is_none(),
            "10 分钟窗口内不重复拷 1.7 MB"
        );
        assert_eq!(fs::read(&bak).unwrap(), b"v1", "窗口内备份内容保持不变");
        let _ = fs::remove_dir_all(&d);
    }

    /// 1.2.6：默认库搬到安装目录后，以前往旧默认库导入过字体的用户
    /// 必须把库地址钉回旧目录，否则升级后库会「变空」。
    #[cfg(target_os = "windows")]
    #[test]
    fn legacy_default_library_gets_pinned() {
        let legacy = crate::scanner::legacy_managed_font_dir();
        let inside = legacy.join("SomeFont-Regular.ttf").to_string_lossy().into_owned();

        let mut used = AppState::default();
        used.added.insert(inside.clone(), 0);
        assert!(pin_legacy_library(&mut used), "用过旧默认库要钉住");
        assert!(used.library_dir_enabled);
        assert_eq!(used.library_dirs.len(), 1);
        assert_eq!(
            used.library_dir.as_deref().map(str::to_lowercase),
            Some(legacy.to_string_lossy().to_lowercase()),
            "库地址应指向旧默认目录"
        );

        // 没往旧库导过东西（只往自定义库导过）→ 不该钉，走新默认位置
        let mut clean = AppState::default();
        clean
            .added
            .insert(r"E:\Fonts\Inter-Regular.ttf".into(), 0);
        assert!(!pin_legacy_library(&mut clean));
        assert!(clean.library_dir.is_none());

        // 已经有库地址的用户一律不动
        let mut custom = AppState::default();
        custom.library_dir = Some(r"E:\Fonts".into());
        custom.library_dirs = vec![r"E:\Fonts".into()];
        custom.added.insert(inside, 0);
        assert!(!pin_legacy_library(&mut custom));
        assert_eq!(custom.library_dir.as_deref(), Some(r"E:\Fonts"));
    }

    /// 偏好快路径写的是独立小文件，而且必须是原子替换（不能读出半份 JSON）
    #[test]
    fn prefs_file_is_atomic_and_independent() {
        let dir = std::env::temp_dir().join(format!("zfm-prefs-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("prefs.json");
        write_json_atomic(&path, &serde_json::json!({ "soundPref": "off" })).unwrap();
        let first: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(first["soundPref"], "off");
        // 重复写不留下 .tmp；内容完整覆盖而不是追加
        write_json_atomic(&path, &serde_json::json!({ "soundPref": "on" })).unwrap();
        let second: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(second["soundPref"], "on");
        assert!(!path.with_extension("json.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── 数据根判定（2.1.5） ────────────────────────────────────────

    /// 判定链里只有 `ZFM_DATA_DIR` 是可从测试里驱动的开关，而环境变量是**进程级**的，
    /// cargo test 默认多线程 → 这几条必须串行跑，否则互相把对方的覆盖清掉。
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 判定顺序 #0：显式覆盖（绝对路径 + 真的可写）优先级最高，压过安装目录。
    #[test]
    fn data_root_env_override_wins() {
        let _g = env_lock();
        let d = tmp_dir("root-env");
        std::env::set_var("ZFM_DATA_DIR", &d);
        let root = resolve_data_root();
        std::env::remove_var("ZFM_DATA_DIR");
        assert_eq!(root.source, DataRootSource::EnvOverride);
        assert_eq!(root.path, d);
        let _ = fs::remove_dir_all(&d);
    }

    /// 判定顺序 #0 的护栏之一：相对路径一律忽略 —— 相对什么？当前工作目录？
    /// 那会让「从资源管理器双击」和「从命令行启动」落到两个不同目录。
    #[test]
    fn data_root_env_ignores_relative_path() {
        let _g = env_lock();
        std::env::set_var("ZFM_DATA_DIR", "relative/not-allowed");
        let root = resolve_data_root();
        std::env::remove_var("ZFM_DATA_DIR");
        assert_ne!(root.source, DataRootSource::EnvOverride);
    }

    /// 判定顺序 #0 的护栏之二：绝对路径但写不进去（父级是文件）→ 忽略，
    /// 否则一个手滑的排障变量就能让软件启动即失效。
    #[test]
    fn data_root_env_ignores_unwritable_path() {
        let _g = env_lock();
        let d = tmp_dir("root-env-bad");
        let blocker = d.join("blocker");
        fs::write(&blocker, b"not a dir").unwrap();
        std::env::set_var("ZFM_DATA_DIR", blocker.join("data"));
        let root = resolve_data_root();
        std::env::remove_var("ZFM_DATA_DIR");
        assert_ne!(root.source, DataRootSource::EnvOverride);
        let _ = fs::remove_dir_all(&d);
    }

    /// 调试/测试构建里 `install_dir()` 故意返回 None（不许往 rust-target 下写账本），
    /// 于是一定落回老位置 —— 这条同时守住「cargo test 不会碰到真实用户数据目录」。
    #[test]
    fn data_root_falls_back_to_legacy_in_debug_build() {
        let _g = env_lock();
        std::env::remove_var("ZFM_DATA_DIR");
        let root = resolve_data_root();
        assert_eq!(root.path, legacy_app_data_dir());
        assert!(matches!(
            root.source,
            DataRootSource::RoamingFallback | DataRootSource::NotWindows
        ));
        assert!(root.path.ends_with(PRODUCT));
    }

    /// 探针：可写的目录返回 true 且**不留垃圾文件**；父级是文件的路径返回 false。
    #[test]
    fn probe_writable_cleans_up_after_itself() {
        let d = tmp_dir("probe");
        assert!(probe_writable(&d.join("nested")));
        assert!(!d.join("nested").join(PROBE_FILE).exists(), "探针文件必须删掉");
        let blocker = d.join("blocker");
        fs::write(&blocker, b"x").unwrap();
        assert!(!probe_writable(&blocker.join("sub")));
        let _ = fs::remove_dir_all(&d);
    }

    /// 账本搬迁必须是「校验 + rename」：源坏了就一个字节都别写进目标，
    /// 让坏文件留在原地走现有的 recover_broken_state 流程。
    #[test]
    fn copy_state_verified_rejects_broken_source() {
        let d = tmp_dir("state-copy");
        let src = d.join("src.json");
        let dst = d.join("data").join("state.json");
        fs::write(&src, b"{\"notes\": {\"broken").unwrap();
        assert!(copy_state_verified(&src, &dst).is_err());
        assert!(!dst.exists(), "坏源不该在目标留下 state.json");
        assert!(!dst.with_extension("json.tmp").exists(), "临时文件必须清掉");

        fs::write(&src, b"{\"notes\": {}}").unwrap();
        assert!(copy_state_verified(&src, &dst).is_ok());
        assert!(dst.is_file());
        assert!(src.exists(), "copy 不是 move：源必须原样保留");
        let _ = fs::remove_dir_all(&d);
    }

    // ── 激活台账（2.1.4） ──────────────────────────────────────────

    /// U13/U14：重复 add / 重复 remove 都是幂等的，返回值恰好表示「这次真的改了没有」。
    /// 返回值直接决定要不要落盘（一次整份 state.json），改错的代价是每次点开关都多写 2MB。
    #[test]
    fn record_activated_is_idempotent() {
        let mut state = AppState::default();
        let path = r"E:\Fonts\幂等.ttf";
        assert!(state.record_activated(path, true), "第一次 add 应该算改动");
        assert!(!state.record_activated(path, true), "重复 add 不该再算改动");
        assert_eq!(state.activated.len(), 1);
        assert!(state.record_activated(path, false));
        assert!(!state.record_activated(path, false), "重复 remove 不该再算改动");
        assert!(state.activated.is_empty());
    }

    /// U13：同一文件的大小写 / 斜杠变体只留一条。
    /// 反例（不清变体）：`D:\a.ttf` 与 `d:\A.TTF` 同时存在，台账随会话线性膨胀，
    /// 而且下一次启动会为「同一个字体」算两条种子。
    #[test]
    fn record_activated_collapses_case_variants() {
        let mut state = AppState::default();
        assert!(state.record_activated(r"D:\a.ttf", true));
        assert!(state.record_activated("d:/A.TTF", true));
        assert_eq!(state.activated.len(), 1, "大小写变体必须被清掉");
        // 撤一条时也要把变体一起撤掉，否则「停用了却还在台账里」
        assert!(state.record_activated(r"D:\a.ttf", false));
        assert!(state.activated.is_empty());
    }

    /// U12：系统字体路径不落账（PRD §6：台账里出现系统路径即视为脏数据）
    #[cfg(target_os = "windows")]
    #[test]
    fn record_activated_ignores_system_fonts() {
        let mut state = AppState::default();
        assert!(!state.record_activated(r"C:\Windows\Fonts\arial.ttf", true));
        assert!(!state.record_activated("c:/windows/fonts/Arial.TTF", true));
        assert!(state.activated.is_empty());
    }

    /// 撤一条台账时，写法与台账里那条**不同**（大小写 / 斜杠）也必须撤掉。
    ///
    /// 反例：只用 `p != path` 判存在性 → `existed == false` → 提前 return，
    /// 于是「用文件夹里的大小写点停用」永远撤不掉台账，下次启动又被种子拉回来 ——
    /// 用户会觉得「这个字体停用不掉」。`had_variant` 这一支必须参与判断。
    #[test]
    fn record_activated_remove_matches_variant_spelling() {
        let mut state = AppState::default();
        assert!(state.record_activated(r"E:\Fonts\V.ttf", true));
        // 只有变体、没有逐字相同的那条
        assert!(
            state.record_activated("e:/fonts/v.TTF", false),
            "变体写法撤账也必须算改动（否则不会落盘）"
        );
        assert!(state.activated.is_empty());
    }

    /// D10：台账按「本轮扫到的路径」裁剪 —— 但**不能**误删仍然存在的路径
    /// （大小写 / 斜杠与台账里的写法不同也一样要留住）。
    #[test]
    fn retain_activated_keeps_live_paths() {
        let mut state = AppState::default();
        state.activated.insert(r"E:\Fonts\live.ttf".into());
        state.activated.insert(r"E:\Fonts\gone.ttf".into());
        let alive: HashSet<String> = [crate::activation::norm_path("e:/fonts/LIVE.ttf")]
            .into_iter()
            .collect();
        assert_eq!(state.retain_activated(&alive), 1);
        assert_eq!(state.activated.len(), 1);
        assert!(state.activated.contains(r"E:\Fonts\live.ttf"), "活着的路径被误删了");
    }
}
