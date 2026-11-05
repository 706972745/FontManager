use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 软件最多保存的快照数量（超出后滚动淘汰最旧的）
pub const MAX_SNAPSHOTS: usize = 5;

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
    let mut state: AppState = fs::read(state_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
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
    state
}

pub fn save(state: &AppState) -> Result<(), String> {
    let path = state_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
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
}
