use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

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
            false
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

fn state_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("FontManager")
        .join("state.json")
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

pub fn app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("FontManager")
}

pub fn trash_dir() -> PathBuf {
    app_data_dir().join("Trash")
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
fn migrate_legacy_dirs() {
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
            crate::diag::log(&format!("store: legacy data migration failed: {e}"));
        } else {
            crate::diag::log(&format!(
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

pub fn load() -> AppState {
    migrate_legacy_dirs();
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
}
