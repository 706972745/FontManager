use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// 软件最多保存的快照数量（超出后滚动淘汰最旧的）
pub const MAX_SNAPSHOTS: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntry {
    pub path: String,
    pub family: String,
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

    pub prefs: serde_json::Value,

    pub parked: HashMap<String, String>,

    pub registry_backup: HashMap<String, String>,

    pub library_dir: Option<String>,

    pub library_dir_enabled: bool,

    pub linked: HashSet<String>,

    pub affinity_enabled: bool,

    #[serde(default = "default_true")]
    pub affinity_deactivate_on_quit: bool,

    pub online_fonts_enabled: bool,
}

pub struct Store(pub Mutex<AppState>);

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
                        path,
                        family: String::new(),
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

    /// 保存（插入或覆盖）一个快照，并执行"最多 5 个、淘汰最旧"的滚动淘汰。
    /// 覆盖同名快照时保留原 created_at；新建时若已达上限，则淘汰 created_at 最小的快照。
    pub fn save_snapshot(&mut self, snapshot: Snapshot) {
        if let Some(existing) = self.snapshots.iter_mut().find(|s| s.name == snapshot.name) {
            existing.entries = snapshot.entries;
        } else {
            if self.snapshots.len() >= MAX_SNAPSHOTS {
                if let Some(oldest_idx) = self
                    .snapshots
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, s)| (s.created_at, s.name.clone()))
                    .map(|(i, _)| i)
                {
                    self.snapshots.remove(oldest_idx);
                }
            }
            self.snapshots.push(snapshot);
        }
        self.snapshots
            .sort_by_key(|s| (s.created_at, s.name.clone()));
    }

    pub fn snapshot(&self, name: &str) -> Option<&Snapshot> {
        self.snapshots.iter().find(|s| s.name == name)
    }
}

fn state_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ZFontManager")
        .join("state.json")
}

pub fn app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ZFontManager")
}

pub fn trash_dir() -> PathBuf {
    app_data_dir().join("Trash")
}

pub fn load() -> AppState {
    fs::read(state_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
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
