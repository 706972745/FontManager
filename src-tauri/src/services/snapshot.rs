//! 快照：列 / 建 / 删 / 改名 / 应用。
//!
//! 数据落在 `state.json` 的 `snapshots`（上限 [`crate::store::MAX_SNAPSHOTS`] 个）。
//! 快照条目只记**可移植标识**（postScriptName 优先），不记绝对路径 —— 换电脑、改库路径后仍能对上号。
//! 应用快照的判定与前端同一口径：库内字面「该启的启、该停的停」，系统字体一律不碰。

use crate::store;
use crate::store::{Snapshot, SnapshotEntry, Store};
use std::collections::HashSet;

pub fn list(store: &Store) -> Result<Vec<Snapshot>, String> {
    let state = store.0.lock().map_err(|e| e.to_string())?;
    Ok(state.snapshots.clone())
}

pub fn get(store: &Store, name: &str) -> Result<Snapshot, String> {
    let state = store.0.lock().map_err(|e| e.to_string())?;
    state
        .snapshot(name)
        .cloned()
        .ok_or_else(|| format!("没有名为「{name}」的快照；先 GET /api/v1/snapshots 看现有名单"))
}

/// 新建快照。`families` 为空 = 收录当前**已启用**的字体（与界面「新建快照」一致）；
/// 给了字族名单就只收这些族（含它们全部字面）。
pub fn create(store: &Store, name: &str, families: Option<&[String]>) -> Result<Vec<Snapshot>, String> {
    let clean = name.trim();
    if clean.is_empty() {
        return Err("快照名不能为空".into());
    }
    let faces = super::fonts::snapshot_faces();
    if faces.is_empty() {
        return Err("还没有扫描结果：先让软件完成一次扫描（或调用 POST /api/v1/fonts/scan）".into());
    }
    let want_families: Option<HashSet<String>> =
        families.map(|f| f.iter().map(|s| s.trim().to_lowercase()).collect());
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    // 「当前启用」必须问注册表探针：`state.deactivated` 只记用户主动停用的，
    // 系统里本来就没装的字体不在里面 —— 只看它会把全库都当成「已启用」
    // （1.3.0 调试时踩到：API 建快照收了 5942 条，界面明明只有 166 个启用）。
    let probe = crate::activation::probe();
    let active_paths: HashSet<String> = faces
        .iter()
        .filter(|f| crate::activation::is_active(&probe, &state, f))
        .map(|f| f.path.clone())
        .collect();
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for f in &faces {
        let hit = match &want_families {
            Some(want) => want.contains(&f.family.to_lowercase()),
            None => active_paths.contains(&f.path),
        };
        if !hit {
            continue;
        }
        let key = super::fonts::face_key(f);
        if !seen.insert(key.clone()) {
            continue;
        }
        entries.push(SnapshotEntry {
            key,
            path: None,
            family: f.family.clone(),
            style: f.style.clone(),
            system: matches!(f.source, crate::font_types::FontSource::System),
        });
    }
    if entries.is_empty() {
        return Err(match &want_families {
            Some(_) => "这些字族在库里一个字体都没匹配到".into(),
            None => "当前没有已启用的字体，快照会是空的；请先启用几个字体，或指定 families".into(),
        });
    }
    state.save_snapshot(Snapshot {
        name: clean.to_string(),
        created_at: super::now_ms(),
        entries,
    })?;
    store::save(&state)?;
    Ok(state.snapshots.clone())
}

pub fn remove(store: &Store, name: &str) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    let before = state.snapshots.len();
    state.snapshots.retain(|s| s.name != name);
    if state.snapshots.len() == before {
        return Err(format!("没有名为「{name}」的快照"));
    }
    store::save(&state)
}

pub fn rename(store: &Store, from: &str, to: &str) -> Result<Vec<Snapshot>, String> {
    let clean = to.trim();
    if clean.is_empty() {
        return Err("新名字不能为空".into());
    }
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    if state.snapshot(clean).is_some() {
        return Err(format!("已经有叫「{clean}」的快照了"));
    }
    let snap = state
        .snapshot(from)
        .cloned()
        .ok_or_else(|| format!("没有名为「{from}」的快照"))?;
    state.snapshots.retain(|s| s.name != from);
    state.save_snapshot(Snapshot {
        name: clean.to_string(),
        created_at: snap.created_at,
        entries: snap.entries,
    })?;
    store::save(&state)?;
    Ok(state.snapshots.clone())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    pub snapshot: String,
    pub activated: usize,
    pub deactivated: usize,
    /// 快照里有、但这台机器上找不到的字体数（换电脑后常见）
    pub missing: usize,
}

/// 应用快照：库内字面「该启的启、该停的停」，系统字体不动，未在快照里的库内字体停用。
///
/// 判定用的「当前是否启用」= `state.deactivated`（软件自己的登记），
/// 与界面显示的开关状态同源；不用注册表探针，是为了避免「系统里手工装过」这种
/// 软件不知道的情况被当成已启用而误停用。
pub fn apply(store: &Store, name: &str) -> Result<ApplyReport, String> {
    let snap = get(store, name)?;
    let keys: HashSet<String> = snap.entries.iter().map(|e| e.key.clone()).collect();
    let faces = super::fonts::snapshot_faces();
    if faces.is_empty() {
        return Err("还没有扫描结果，无法应用快照：先让软件扫一次".into());
    }
    let mut to_activate: Vec<String> = Vec::new();
    let mut to_deactivate: Vec<String> = Vec::new();
    let mut matched = HashSet::new();
    {
        let state = store.0.lock().map_err(|e| e.to_string())?;
        let probe = crate::activation::probe();
        for f in &faces {
            if matches!(f.source, crate::font_types::FontSource::System) {
                continue;
            }
            let key = super::fonts::face_key(f);
            let in_snap = keys.contains(&key);
            if in_snap {
                matched.insert(key);
            }
            let currently_active = crate::activation::is_active(&probe, &state, f);
            match (in_snap, currently_active) {
                (true, false) => to_activate.push(f.path.clone()),
                (false, true) => to_deactivate.push(f.path.clone()),
                _ => {}
            }
        }
    }
    if !to_activate.is_empty() {
        super::fonts::set_paths_active(store, &to_activate, true)?;
    }
    if !to_deactivate.is_empty() {
        super::fonts::set_paths_active(store, &to_deactivate, false)?;
    }
    // 系统字体不在启停流程里，快照里那部分永远「匹配不上」，不该算成缺失
    let system_keys = snap
        .entries
        .iter()
        .filter(|e| e.system)
        .map(|e| e.key.clone())
        .collect::<HashSet<_>>();
    let missing = keys
        .iter()
        .filter(|k| !matched.contains(*k) && !system_keys.contains(*k))
        .count();
    Ok(ApplyReport {
        snapshot: snap.name,
        activated: to_activate.len(),
        deactivated: to_deactivate.len(),
        missing,
    })
}
