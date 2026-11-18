//! 业务数据按字体库存储（2.4.0）：每个库的标签 / 分组 / 快照 / 收藏 / 备注 / 入库时间
//! 都存在**这个库自己的** `<库根>/.FontManager/library.json` 里，而不是应用账本里。
//!
//! 为什么（用户 2026-11-19）：单账本时换库会看到别的库的标签、切几次库数据越切越少、
//! 清库后重新导入同一个库数据就没了 —— 数据的生命周期必须绑在库目录上。
//!
//! 纪律：
//! - **只写 `<库根>/.FontManager/`**，库根下其它文件一个都不碰（`.zfm-folder.ico` 另有主人）；
//! - 写盘必须原子（tmp + rename），覆盖前滚一份 `.bak`，解析失败改名 `corrupt-<ts>` 再退 `.bak`
//!   —— 与 `store::save/load` 同一条链，不许另造一套；
//! - 库不可写（只读盘 / U 盘拔出 / 权限不足）**不许静默失败**：落到 `data_root()/library-scope/`
//!   并在返回值里说明是降级，调用方负责让用户知道（Q3 的结论：降级而不是拒绝切库）。
//!
//! 不在这里存的东西：`activated` / `deactivated` / `registry_backup` / `parked` 是**机器级**状态
//! （这台机器上哪些字体启用着），`prefs` / `library_*` 是应用级配置 —— 换库不该带走它们（Q1）。

use crate::store::{AppState, Snapshot, TagGroup, TagMeta};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

/// 库内唯一允许我们创建的目录名
pub const SCOPE_DIR: &str = ".FontManager";
/// 库内唯一允许我们写的文件名（其余是它自己的 `.bak` / `corrupt-*`）
pub const SCOPE_FILE: &str = "library.json";

/// 一个库的业务数据。字段与 `AppState` 一一对应，序列化后就是 `library.json`。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LibraryScope {
    /// 版本号：以后加字段时用来判断要不要迁移（当前 1）
    #[serde(default = "scope_version")]
    pub schema: u32,
    #[serde(default)]
    pub tags: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub tag_meta: HashMap<String, TagMeta>,
    #[serde(default)]
    pub tag_groups: Vec<TagGroup>,
    #[serde(default)]
    pub collections: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub snapshots: Vec<Snapshot>,
    #[serde(default)]
    pub favorites: HashSet<String>,
    #[serde(default)]
    pub notes: HashMap<String, String>,
    #[serde(default)]
    pub note_seeded: HashSet<String>,
    #[serde(default)]
    pub note_rules: u32,
    #[serde(default)]
    pub added: HashMap<String, u64>,
}

fn scope_version() -> u32 {
    1
}

/// 写到了哪里 —— 调用方据此决定要不要提示用户
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SavePlace {
    /// 写进了库自己的 `.FontManager/library.json`
    Library,
    /// 库不可写，降级写到应用目录
    Degraded(PathBuf),
}

/// 载入结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadOutcome {
    /// 没开自定义库（默认库模式）→ 沿用 global 账本里的数据
    Skipped,
    /// 读到了库自己的数据
    Loaded,
    /// 库里没有 → 把当前内存里的（来自 global 的）数据迁移写进去（Q2：复制，不搬家）
    Migrated,
    /// 主文件坏了 → 用了 `.bak`
    Recovered,
    /// 库不可写 → 用应用目录里的降级副本
    Degraded(PathBuf),
}

/// 当前「数据该放哪个库」。
///
/// **默认库也要算一个库**（用户 2026-11-19 的诉求是「数据跟着字体库走」，不是「只有自定义库才跟」）：
/// 没开自定义库时，库就是我们管理的默认目录（安装目录下的 `字体库`）。少了这条，
/// 默认库的用户一旦重装/账本损坏，数据照样丢 —— 那正是这次要修的病灶。
pub fn effective_library_dir(state: &AppState) -> PathBuf {
    // 单测里绝不去碰真实安装目录下的字体库（否则跑一次 cargo test 就往用户库里写文件）
    if cfg!(test) {
        return PathBuf::new();
    }
    match state.active_library_dir() {
        Some(d) => PathBuf::from(d),
        None => crate::scanner::managed_font_dir(),
    }
}

/// 启动 / 换库时的入口：按「当前生效的库」灌数据。
pub fn load_for_state(state: &mut AppState) -> LoadOutcome {
    let dir = effective_library_dir(state);
    load_into(state, Some(dir.to_string_lossy().as_ref()))
}

/// 落盘入口：按「当前生效的库」写数据。
pub fn save_for_state(state: &AppState) -> Result<SavePlace, String> {
    let dir = effective_library_dir(state);
    save_from(state, Some(dir.to_string_lossy().as_ref()))
}

/// `<库根>/.FontManager`
pub fn scope_dir(lib: &Path) -> PathBuf {
    lib.join(SCOPE_DIR)
}

/// `<库根>/.FontManager/library.json`
pub fn scope_file(lib: &Path) -> PathBuf {
    scope_dir(lib).join(SCOPE_FILE)
}

/// 从内存状态摘出「属于库」的那一半
pub fn capture(state: &AppState) -> LibraryScope {
    LibraryScope {
        schema: scope_version(),
        tags: state.tags.clone(),
        tag_meta: state.tag_meta.clone(),
        tag_groups: state.tag_groups.clone(),
        collections: state.collections.clone(),
        snapshots: state.snapshots.clone(),
        favorites: state.favorites.clone(),
        notes: state.notes.clone(),
        note_seeded: state.note_seeded.clone(),
        note_rules: state.note_rules,
        added: state.added.clone(),
    }
}

/// 把库数据灌回内存状态（覆盖那一半字段，机器级字段一概不动）
pub fn apply_to(state: &mut AppState, s: LibraryScope) {
    state.tags = s.tags;
    state.tag_meta = s.tag_meta;
    state.tag_groups = s.tag_groups;
    state.collections = s.collections;
    state.snapshots = s.snapshots;
    state.favorites = s.favorites;
    state.notes = s.notes;
    state.note_seeded = s.note_seeded;
    state.note_rules = s.note_rules;
    state.added = s.added;
}

/// 换库瞬间把「属于库」的那一半清空。
///
/// 为什么必须清：新库如果没有自己的 `library.json`，绝不能沿用上一个库的标签 ——
/// 那正是用户报的「数据混在一起」。
pub fn clear(state: &mut AppState) {
    apply_to(state, LibraryScope::default());
}

/// 降级落点：`data_root()/library-scope/<把路径压成一个安全文件名>.json`
fn fallback_file(lib: &Path) -> PathBuf {
    crate::store::data_root()
        .join("library-scope")
        .join(format!("{}.json", file_key(lib)))
}

/// 把库路径压成文件名：保留盘符与字母数字，其余折成 `_`，末尾带长度防撞。
fn file_key(lib: &Path) -> String {
    let raw = lib.to_string_lossy().to_lowercase();
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    let tail: String = trimmed.chars().rev().take(40).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{tail}_{}", raw.len())
}

/// 原子写：tmp → rename；覆盖前把旧文件滚成 `.bak`。
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("建目录失败 {}：{e}", parent.display()))?;
    }
    if path.exists() {
        let bak = path.with_extension("json.bak");
        let _ = fs::copy(path, &bak);
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("写临时文件失败 {}：{e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("替换失败 {}：{e}", path.display())
    })
}

/// 把当前内存状态写回库。
///
/// 失败时**不抛给上层业务**（业务已经改完内存了），而是降级写应用目录并返回
/// `SavePlace::Degraded`，由调用方决定怎么提示。
pub fn save_from(state: &AppState, lib: Option<&str>) -> Result<SavePlace, String> {
    let Some(dir) = lib.map(PathBuf::from) else {
        return Ok(SavePlace::Library); // 默认库模式：数据仍在 global 账本里
    };
    // 库目录不存在（用户刚填了路径还没建、或盘没插）→ 一个目录都不许替用户建：
    // 这条一旦漏了，就会在用户磁盘上凭空长出一串空目录。
    if !dir.is_dir() {
        return Ok(SavePlace::Library);
    }
    let bytes = serde_json::to_vec_pretty(&capture(state)).map_err(|e| e.to_string())?;
    match write_atomic(&scope_file(&dir), &bytes) {
        Ok(()) => Ok(SavePlace::Library),
        Err(primary) => {
            let fb = fallback_file(&dir);
            write_atomic(&fb, &bytes).map_err(|e| format!("{primary}；降级也失败：{e}"))?;
            crate::diag::log(&format!(
                "library_scope: 库不可写，降级到 {}（{primary}）",
                fb.display()
            ));
            Ok(SavePlace::Degraded(fb))
        }
    }
}

/// 启动 / 换库时把库数据灌进内存。
pub fn load_into(state: &mut AppState, lib: Option<&str>) -> LoadOutcome {
    let Some(dir) = lib.map(PathBuf::from) else {
        return LoadOutcome::Skipped;
    };
    // 库目录不存在 → 谈不上「这个库的数据」，也别替用户建目录
    if !dir.is_dir() {
        return LoadOutcome::Skipped;
    }
    let file = scope_file(&dir);
    if !file.exists() {
        // 库不可写时上一次可能落在降级目录：先认它，别把用户数据当成「没有」
        let fb = fallback_file(&dir);
        if fb.exists() {
            if let Ok(bytes) = fs::read(&fb) {
                if let Ok(scope) = serde_json::from_slice::<LibraryScope>(&bytes) {
                    apply_to(state, scope);
                    return LoadOutcome::Degraded(fb);
                }
            }
        }
        // 库里没有 → 迁移：把当前（来自 global 的）数据复制进库，global 原样保留
        let dir_str = dir.to_string_lossy().into_owned();
        match save_from(state, Some(dir_str.as_str())) {
            Ok(_) => LoadOutcome::Migrated,
            Err(e) => {
                crate::diag::log(&format!("library_scope: 迁移写入失败：{e}"));
                LoadOutcome::Skipped
            }
        }
    } else {
        match fs::read(&file).map_err(|e| e.to_string()).and_then(|b| {
            serde_json::from_slice::<LibraryScope>(&b).map_err(|e| e.to_string())
        }) {
            Ok(scope) => {
                apply_to(state, scope);
                LoadOutcome::Loaded
            }
            Err(e) => {
                // 留证 → 退 .bak（与 store::load 同一条链）
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let corrupt = scope_dir(&dir).join(format!("library.corrupt-{stamp}.json"));
                let _ = fs::rename(&file, &corrupt);
                crate::diag::log(&format!(
                    "library_scope: library.json 解析失败（{e}），已改名 {}",
                    corrupt.display()
                ));
                let bak = file.with_extension("json.bak");
                if let Ok(bytes) = fs::read(&bak) {
                    if let Ok(scope) = serde_json::from_slice::<LibraryScope>(&bytes) {
                        apply_to(state, scope);
                        return LoadOutcome::Recovered;
                    }
                }
                LoadOutcome::Skipped
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_lib(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "zfm-scope-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn seeded() -> AppState {
        let mut st = AppState::default();
        st.tags.insert("A".into(), vec!["客户".into()]);
        st.collections.insert("常用".into(), vec!["A".into()]);
        st.favorites.insert("A".into());
        st.notes.insert("A".into(), "备注".into());
        st.tag_meta.insert(
            "客户".into(),
            TagMeta { color: Some("blue".into()), group: Some("组1".into()) },
        );
        st.tag_groups.push(TagGroup { name: "组1".into(), color: None });
        st
    }

    /// 写出去再读回来，属于库的那一半必须一模一样
    #[test]
    fn round_trip_keeps_library_half() {
        let lib = tmp_lib("roundtrip");
        let st = seeded();
        assert_eq!(save_from(&st, Some(lib.to_str().unwrap())).unwrap(), SavePlace::Library);
        assert!(scope_file(&lib).exists());

        let mut back = AppState::default();
        assert_eq!(load_into(&mut back, Some(lib.to_str().unwrap())), LoadOutcome::Loaded);
        assert_eq!(back.tags, st.tags);
        assert_eq!(back.collections, st.collections);
        assert_eq!(back.tag_meta["客户"].color.as_deref(), Some("blue"));
        assert_eq!(back.tag_groups.len(), 1);
        assert_eq!(back.notes["A"], "备注");
    }

    /// 库里没有文件 → 迁移写进去，且 global（内存）那份不动
    #[test]
    fn missing_file_migrates_without_moving() {
        let lib = tmp_lib("migrate");
        let mut st = seeded();
        let outcome = load_into(&mut st, Some(lib.to_str().unwrap()));
        assert_eq!(outcome, LoadOutcome::Migrated);
        assert!(scope_file(&lib).exists());
        // 迁移是「复制」：内存里的数据一条都没少
        assert_eq!(st.tags["A"], vec!["客户".to_string()]);
    }

    /// 主文件坏了 → 留证 + 退 .bak
    #[test]
    fn corrupt_file_falls_back_to_backup() {
        let lib = tmp_lib("corrupt");
        let st = seeded();
        // 第一次写：建文件；第二次写：覆盖前才滚 .bak（这是备份链的正常口径）
        save_from(&st, Some(lib.to_str().unwrap())).unwrap();
        save_from(&st, Some(lib.to_str().unwrap())).unwrap();
        let f = scope_file(&lib);
        let bak = f.with_extension("json.bak");
        assert!(bak.exists(), "第二次写盘应留下 .bak");
        fs::write(&f, b"{ this is not json").unwrap();

        let mut back = AppState::default();
        assert_eq!(load_into(&mut back, Some(lib.to_str().unwrap())), LoadOutcome::Recovered);
        assert_eq!(back.tags["A"], vec!["客户".to_string()]);
        // 坏文件留了证
        let has_corrupt = fs::read_dir(scope_dir(&lib))
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().starts_with("library.corrupt-"));
        assert!(has_corrupt, "坏文件应改名留证");
    }

    /// A → B → A：两个库的数据各归各位，互不串味
    #[test]
    fn switching_libraries_keeps_them_separate() {
        let a = tmp_lib("switch-a");
        let b = tmp_lib("switch-b");

        let mut st = seeded();
        save_from(&st, Some(a.to_str().unwrap())).unwrap();

        // 切到 B：清空 → 读 B（没有文件 → 迁移空集）
        clear(&mut st);
        assert_eq!(load_into(&mut st, Some(b.to_str().unwrap())), LoadOutcome::Migrated);
        assert!(st.tags.is_empty(), "B 库不许继承 A 库的标签");

        // 在 B 里写点自己的
        st.tags.insert("B".into(), vec!["自己的".into()]);
        save_from(&st, Some(b.to_str().unwrap())).unwrap();

        // 切回 A
        clear(&mut st);
        assert_eq!(load_into(&mut st, Some(a.to_str().unwrap())), LoadOutcome::Loaded);
        assert_eq!(st.tags["A"], vec!["客户".to_string()]);
        assert!(!st.tags.contains_key("B"));
    }

    /// 删掉整个库目录后重新导入到同一路径：只要 `.FontManager` 跟着回来，数据就回来
    #[test]
    fn reimport_same_path_restores_data() {
        let lib = tmp_lib("reimport");
        let st = seeded();
        save_from(&st, Some(lib.to_str().unwrap())).unwrap();

        // 模拟「清库」：只删字体文件，保留 .FontManager（用户删库时我们不动这个目录）
        let kept = scope_file(&lib);
        assert!(kept.exists());

        let mut back = AppState::default();
        assert_eq!(load_into(&mut back, Some(lib.to_str().unwrap())), LoadOutcome::Loaded);
        assert_eq!(back.collections["常用"], vec!["A".to_string()]);
    }

    /// 默认库模式（没开自定义库）→ 不写库、不改数据
    #[test]
    fn default_library_mode_is_skipped() {
        let mut st = seeded();
        let before = st.tags.clone();
        assert_eq!(load_into(&mut st, None), LoadOutcome::Skipped);
        assert_eq!(st.tags, before);
        assert_eq!(save_from(&st, None).unwrap(), SavePlace::Library);
    }

    /// 库目录不存在 → 一个目录都不许建（凭空长空目录是很脏的行为）
    #[test]
    fn missing_library_dir_creates_nothing() {
        let ghost = std::env::temp_dir().join(format!("zfm-ghost-{}", std::process::id()));
        let _ = fs::remove_dir_all(&ghost);
        let mut st = seeded();
        assert_eq!(load_into(&mut st, Some(ghost.to_str().unwrap())), LoadOutcome::Skipped);
        assert_eq!(save_from(&st, Some(ghost.to_str().unwrap())).unwrap(), SavePlace::Library);
        assert!(!ghost.exists(), "库目录不存在时不许替用户创建");
    }
}
