//! 整理数据：标签 / 分组 / 收藏 / 评分 / 备注 / 版权状态。
//!
//! 读写口径与界面完全一致：标签、分组、收藏、备注都在 `state.json`，
//! 评分在 `prefs.ratings`（家族名 → 1~5）。外部入口改完之后界面刷新即可看到，
//! 不会出现「API 改的和界面看到的不是一份数据」。

use crate::store::{self, Store};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Curation {
    pub tags: HashMap<String, Vec<String>>,
    pub collections: HashMap<String, Vec<String>>,
    pub favorites: Vec<String>,
    /// 家族 → 1~5 星
    pub ratings: HashMap<String, u8>,
    pub notes: HashMap<String, String>,
}

fn ratings_of(state: &crate::store::AppState) -> HashMap<String, u8> {
    state
        .prefs
        .get("ratings")
        .and_then(|v| serde_json::from_value::<HashMap<String, u8>>(v.clone()).ok())
        .unwrap_or_default()
}

pub fn get(store: &Store) -> Result<Curation, String> {
    let state = store.0.lock().map_err(|e| e.to_string())?;
    let mut favorites: Vec<String> = state.favorites.iter().cloned().collect();
    favorites.sort();
    Ok(Curation {
        tags: state.tags.clone(),
        collections: state.collections.clone(),
        favorites,
        ratings: ratings_of(&state),
        notes: state.notes.clone(),
    })
}

/// 评分：1~5 星；传 0 或越界 = 清除评分。顺手补上收藏（与界面一致：有星级就在收藏里）。
pub fn set_rating(store: &Store, family: &str, stars: u8) -> Result<u8, String> {
    let family = family.trim();
    if family.is_empty() {
        return Err("family 不能为空".into());
    }
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    let mut map = ratings_of(&state);
    if (1..=5).contains(&stars) {
        map.insert(family.to_string(), stars);
        state.favorites.insert(family.to_string());
    } else {
        map.remove(family);
    }
    let mut obj = serde_json::Map::new();
    for (k, v) in &map {
        obj.insert(k.clone(), serde_json::json!(v));
    }
    if let Some(p) = state.prefs.as_object_mut() {
        p.insert("ratings".into(), serde_json::Value::Object(obj));
    } else {
        state.prefs = serde_json::json!({ "ratings": obj });
    }
    store::save(&state)?;
    Ok(if (1..=5).contains(&stars) { stars } else { 0 })
}

pub fn set_favorite(store: &Store, family: &str, favorite: bool) -> Result<(), String> {
    let family = family.trim();
    if family.is_empty() {
        return Err("family 不能为空".into());
    }
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    if favorite {
        state.favorites.insert(family.to_string());
    } else {
        state.favorites.remove(family);
    }
    store::save(&state)
}

/// 覆盖某个家族的标签列表（空列表 = 清空标签）
pub fn set_tags(store: &Store, family: &str, tags: &[String]) -> Result<(), String> {
    let family = family.trim();
    if family.is_empty() {
        return Err("family 不能为空".into());
    }
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    let cleaned: Vec<String> = tags
        .iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if cleaned.is_empty() {
        state.tags.remove(family);
    } else {
        state.tags.insert(family.to_string(), cleaned);
    }
    store::save(&state)
}

/// 覆盖某个分组的字体名单（空名单 = 删掉这个分组；分组名不存在则新建）
pub fn set_collection(store: &Store, name: &str, families: &[String]) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("分组名不能为空".into());
    }
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    if families.is_empty() {
        state.collections.remove(name);
    } else {
        let list: Vec<String> = families
            .iter()
            .map(|f| f.trim().to_string())
            .filter(|f| !f.is_empty())
            .collect();
        state.collections.insert(name.to_string(), list);
    }
    store::save(&state)
}

pub fn delete_collection(store: &Store, name: &str) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    if state.collections.remove(name).is_none() {
        return Err(format!("没有名为「{name}」的分组"));
    }
    store::save(&state)
}

/// 备注：空字符串 = 删除备注
pub fn set_note(store: &Store, family: &str, note: &str) -> Result<(), String> {
    let family = family.trim();
    if family.is_empty() {
        return Err("family 不能为空".into());
    }
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    if note.trim().is_empty() {
        state.notes.remove(family);
    } else {
        state.notes.insert(family.to_string(), note.to_string());
    }
    store::save(&state)
}

/// 按版权分类筛字族（API / Agent 常用：「把版权过期的全部停用」）
pub fn families_by_license(class: &str) -> Vec<String> {
    let want = class.trim().to_lowercase();
    let mut out: Vec<String> = super::fonts::snapshot_faces()
        .into_iter()
        .filter(|f| {
            f.copyright_class
                .as_deref()
                .map(str::to_lowercase)
                .as_deref()
                == Some(want.as_str())
        })
        .map(|f| f.family)
        .collect();
    out.sort();
    out.dedup();
    out
}
