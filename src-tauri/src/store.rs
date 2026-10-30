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
