//! 字体查询与启停。
//!
//! 数据来源是 [`publish`] 收到的「最近一次扫描结果」——扫描本身要几秒到几分钟，
//! API / 插件不能每次都重扫，所以扫描结束时（`scan_fonts` 命令、`services::scan`）
//! 把结果投进这里，其他入口读内存快照。
//!
//! 启停走的仍是 `activation::sync` / `sync_batch`（注册表 + GDI），登记口径与界面完全一致 ——
//! 不另写一套，避免「界面一套逻辑、API 另一套逻辑」。

use crate::activation;
use crate::font_types::FontFace;
use crate::store::{self, Store};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

// ───────────────────────────── 最近一次扫描结果 ─────────────────────────────

/// 检索键：扫描结束时算一次，查询时直接比。
///
/// 为什么不在 `query()` 里现算 `to_lowercase()`：5 千多个字面 × 每次查询 4 个字段
/// = 单次请求两万多个临时字符串。插件面板一秒钟轮询一次 `/health` 时，
/// 这些分配全都白扔（2026-11-10 审查发现）。
struct Keys {
    family: String,
    style: String,
    path: String,
    postscript: Option<String>,
}

/// 内存快照 = 字面 + 检索键 + 去重排序好的字族名。
#[derive(Default)]
struct Snapshot {
    faces: Vec<FontFace>,
    keys: Vec<Keys>,
    families: Vec<String>,
}

fn cache() -> &'static Mutex<Snapshot> {
    static FACES: OnceLock<Mutex<Snapshot>> = OnceLock::new();
    FACES.get_or_init(|| Mutex::new(Snapshot::default()))
}

/// 扫描结束后投喂一次（幂等覆盖）。派生数据（检索键 / 字族名）在这里算，
/// 只在扫描结束时算一次，别放到每次查询里。
pub fn publish(faces: Vec<FontFace>) {
    let keys: Vec<Keys> = faces
        .iter()
        .map(|f| Keys {
            family: norm(&f.family),
            style: norm(&f.style),
            path: norm(&f.path),
            postscript: f.postscript_name.as_deref().map(norm),
        })
        .collect();
    let mut families: Vec<String> = faces.iter().map(|f| f.family.clone()).collect();
    families.sort();
    families.dedup();
    if let Ok(mut c) = cache().lock() {
        *c = Snapshot {
            faces,
            keys,
            families,
        };
    }
}

/// 复制一份当前快照（6000 个字面的克隆大约几十毫秒，调用方别在热循环里反复调）
pub fn snapshot_faces() -> Vec<FontFace> {
    cache().lock().map(|c| c.faces.clone()).unwrap_or_default()
}

pub fn face_count() -> usize {
    cache().lock().map(|c| c.faces.len()).unwrap_or(0)
}

/// 库里有几个字族。`/health` 每次轮询都要，不能现算（见 [`Snapshot`]）。
pub fn family_count() -> usize {
    cache().lock().map(|c| c.families.len()).unwrap_or(0)
}

fn norm(s: &str) -> String {
    s.trim().to_lowercase()
}

/// 与前端 `snapshotKey.ts::faceKey` 同口径：postScriptName 优先，缺失时回退
/// 字族|样式|字重|斜体|面序号。快照靠它对上号，两边算法必须一致。
pub fn face_key(f: &FontFace) -> String {
    if let Some(ps) = f.postscript_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        return format!("ps:{}", norm(ps));
    }
    format!(
        "fam:{}|{}|{}|{}|{}",
        norm(&f.family),
        norm(&f.style),
        f.weight,
        if f.italic { 1 } else { 0 },
        f.face_index
    )
}

/// 查询：`q` 匹配字族 / 样式 / 文件名（大小写不敏感），`family` 精确匹配字族。
///
/// 只复制命中的那一页（`offset..offset+limit`），不再把整个 6000 条快照 clone 一遍。
pub fn query(q: Option<&str>, family: Option<&str>, limit: Option<usize>, offset: usize) -> Vec<FontFace> {
    let needle = q.map(norm).filter(|s| !s.is_empty());
    let fam = family.map(norm).filter(|s| !s.is_empty());
    let take = limit.unwrap_or(usize::MAX);
    let Ok(snap) = cache().lock() else {
        return Vec::new();
    };
    let mut out: Vec<FontFace> = Vec::new();
    if take == 0 {
        return out;
    }
    let mut skipped = 0usize;
    for (i, k) in snap.keys.iter().enumerate() {
        if let Some(want) = &fam {
            if k.family != *want {
                continue;
            }
        }
        if let Some(want) = &needle {
            let hit = k.family.contains(want.as_str())
                || k.style.contains(want.as_str())
                || k.path.contains(want.as_str())
                || k.postscript
                    .as_deref()
                    .is_some_and(|p| p.contains(want.as_str()));
            if !hit {
                continue;
            }
        }
        if skipped < offset {
            skipped += 1;
            continue;
        }
        out.push(snap.faces[i].clone());
        if out.len() >= take {
            break;
        }
    }
    out
}

/// 某个字族的所有字面路径（大小写不敏感）
pub fn paths_of_family(family: &str) -> Vec<String> {
    let want = norm(family);
    cache()
        .lock()
        .map(|c| {
            c.keys
                .iter()
                .enumerate()
                .filter(|(_, k)| k.family == want)
                .map(|(i, _)| c.faces[i].path.clone())
                .collect::<HashSet<_>>()
                .into_iter()
                .collect()
        })
        .unwrap_or_default()
}

/// 库里所有字族名（去重、已排序）
pub fn families() -> Vec<String> {
    cache().lock().map(|c| c.families.clone()).unwrap_or_default()
}

// ───────────────────────────── 启停 ─────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivateReport {
    /// 实际处理了几个字面
    pub faces: usize,
    /// 跳过的系统字体数（改不动，不报错）
    pub skipped_system: usize,
}

fn count_system(paths: &[String]) -> usize {
    paths.iter().filter(|p| activation::is_system_font(p)).count()
}

/// 按字面路径批量启用 / 停用（登记口径与界面一致）。会落盘 state.json。
pub fn set_paths_active(store: &Store, paths: &[String], active: bool) -> Result<ActivateReport, String> {
    if paths.is_empty() {
        return Err("没有指定任何字体路径".into());
    }
    let skipped = count_system(paths);
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    let failed = activation::sync_batch(&mut state, paths, active);
    store::save(&state)?;
    drop(state);
    activation::batch_error(&failed, paths.len())?;
    Ok(ActivateReport {
        faces: paths.len() - skipped,
        skipped_system: skipped,
    })
}

/// 按字族批量启用 / 停用。找不到这个字族时给的是人话错误。
pub fn set_family_active(store: &Store, family: &str, active: bool) -> Result<ActivateReport, String> {
    let paths = paths_of_family(family);
    if paths.is_empty() {
        return Err(format!(
            "字体库里没有「{family}」这个字族；先用 GET /api/v1/fonts?q= 查一下准确名字"
        ));
    }
    set_paths_active(store, &paths, active)
}

/// 本会话临时启用（不写注册表之外的持久状态，退出时由 `revert_session` 撤销）
pub fn activate_session(store: &Store, paths: &[String]) -> Result<ActivateReport, String> {
    if paths.is_empty() {
        return Err("没有指定任何字体路径".into());
    }
    let skipped = count_system(paths);
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    let mut failed = Vec::new();
    let mut activated = Vec::with_capacity(paths.len());
    for path in paths {
        match activation::sync(&mut state, path, true) {
            Ok(()) => activated.push(path.clone()),
            Err(e) => failed.push(e),
        }
    }
    store::save(&state)?;
    drop(state);
    if let Ok(mut session) = session_activated().lock() {
        session.extend(activated);
    }
    activation::batch_error(&failed, paths.len())?;
    Ok(ActivateReport {
        faces: paths.len() - skipped,
        skipped_system: skipped,
    })
}

fn session_activated() -> &'static Mutex<HashSet<String>> {
    static SESSION: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SESSION.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 退出前把会话级启用撤销掉，返回撤销了几个
pub fn revert_session(store: &Store) -> usize {
    let paths: Vec<String> = match session_activated().lock() {
        Ok(mut s) => std::mem::take(&mut *s).into_iter().collect(),
        Err(_) => return 0,
    };
    if paths.is_empty() {
        return 0;
    }
    let Ok(mut state) = store.0.lock() else {
        return 0;
    };
    for p in &paths {
        let _ = activation::sync(&mut state, p, false);
    }
    let _ = store::save(&state);
    paths.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::font_types::{Classification, FontFace, FontFormat, FontSource};

    fn face(family: &str, style: &str, ps: Option<&str>, path: &str) -> FontFace {
        FontFace {
            id: format!("{path}#0"),
            path: path.into(),
            preview_path: None,
            face_index: 0,
            family: family.into(),
            style: style.into(),
            postscript_name: ps.map(str::to_string),
            localized_names: vec![],
            foundry: None,
            license: None,
            license_url: None,
            copyright: None,
            copyright_class: Some("free".into()),
            license_note: None,
            format: FontFormat::Ttf,
            is_variable: false,
            axes: vec![],
            weight: 400,
            italic: false,
            monospaced: false,
            classification: Classification::Sans,
            scripts: vec![],
            features: vec![],
            glyph_count: 100,
            incomplete: None,
            name_fallback: false,
            file_size: 1024,
            source: FontSource::Managed,
            deactivatable: true,
            active: false,
            added_at: None,
        }
    }

    /// 快照 key 必须与前端 `snapshotKey.ts::faceKey` 同口径，否则 API 建的快照前端应用不上
    #[test]
    fn face_key_matches_frontend_scheme() {
        let with_ps = face("Source Han Sans", "Regular", Some("SourceHanSans-Regular"), "/a.ttf");
        assert_eq!(face_key(&with_ps), "ps:sourcehansans-regular");

        let without = face("思源黑体 CN", "Bold", None, "/b.otf");
        assert_eq!(face_key(&without), "fam:思源黑体 cn|bold|400|0|0");
    }

    /// 查询：字族精确匹配 + 关键词模糊匹配（大小写不敏感）
    #[test]
    fn query_filters_by_family_and_keyword() {
        publish(vec![
            face("Source Han Sans", "Regular", Some("SHSans-R"), "/lib/shans-r.ttf"),
            face("Source Han Serif", "Bold", Some("SHSerif-B"), "/lib/shs-b.otf"),
            face("思源黑体", "Regular", None, "/lib/syht.ttf"),
        ]);

        assert_eq!(query(None, Some("source han sans"), None, 0).len(), 1);
        assert_eq!(query(Some("serif"), None, None, 0).len(), 1);
        assert_eq!(query(Some("shs-b"), None, None, 0).len(), 1);
        assert_eq!(query(Some("思源"), None, None, 0).len(), 1);
        assert_eq!(query(None, None, Some(2), 0).len(), 2);
        assert_eq!(query(None, None, Some(2), 2).len(), 1);
    }
}
