mod activation;
mod adobe;
mod affinity;
#[cfg(target_os = "windows")]
mod comhost;
mod copyright;
mod diag;
mod font_types;
mod fontcache;
mod installer;
mod net;
mod online;
mod parser;
mod preview_font;
mod webfonts;
#[cfg(target_os = "windows")]
mod procs;
mod registry;
mod scanner;
mod single_instance;
mod sound;
#[cfg(target_os = "windows")]
mod warm;
mod store;
mod watcher;
mod window_dock;
mod window_morph;
#[cfg(target_os = "windows")]
mod window_round;

use font_types::{CharsetStats, FontFace, FontSource, TrashEntry};
use std::collections::HashMap;
use store::Store;
use tauri::{Emitter, Manager, State};

/// 读取文件时间（Unix 秒）。birth=true 时优先取创建时间（入库时间兜底），否则取修改时间。
fn file_time(path: &str, birth: bool) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    let t = if birth {
        meta.created().or_else(|_| meta.modified()).ok()?
    } else {
        meta.modified().ok()?
    };
    t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs())
}

/// 判定口径升级后，把旧的「自动备注」作废，让下一次扫描按新口径重写。
/// 只删以「判定依据：/授权原文：」开头的（都是我们自己写的），用户手写备注一律不动。
fn migrate_note_rules(app: &tauri::AppHandle) {
    let store: State<Store> = app.state();
    let Ok(mut state) = store.0.lock() else {
        return;
    };
    if state.note_rules == copyright::NOTE_RULES_VERSION {
        return;
    }
    let stale: Vec<String> = state.note_seeded.iter().cloned().collect();
    for fam in stale {
        let auto = state
            .notes
            .get(&fam)
            .is_some_and(|t| t.starts_with("判定依据：") || t.starts_with("授权原文："));
        if auto {
            state.notes.remove(&fam);
        }
    }
    state.note_seeded.clear();
    state.note_rules = copyright::NOTE_RULES_VERSION;
    let _ = store::save(&state);
    crate::diag::log("[copyright] 判定口径升级，自动备注已作废待重写");
}

#[tauri::command]
async fn scan_fonts(app: tauri::AppHandle) -> Result<Vec<FontFace>, String> {
    let (extra, library_dir, linked) = {
        let store: State<Store> = app.state();
        let state = store.0.lock().map_err(|e| e.to_string())?;
        (
            state.extra_dirs.clone(),
            state.active_library_dir().map(|s| s.to_owned()),
            state.linked.clone(),
        )
    };
    let managed = scanner::effective_managed_dir(library_dir.as_deref());
    migrate_note_rules(&app);
    // 字库目录里「直接拖进去、没走导入流程」的字体：刷新按钮原来只扫
    // 「系统目录 + 额外目录 + linked 记录」，手动放进字库的既不在 linked、也没人遍历，
    // 所以永远刷不出来。这里先收编进 linked，后面那条链接字体扫描链就会正常解析
    // （版权判定、备注、启用状态全都走同一套逻辑）。
    let mut linked = linked;
    if library_dir.is_some() {
        let fresh = scanner::discover_managed(&managed, &linked);
        if !fresh.is_empty() {
            crate::diag::log(&format!(
                "[scan] 字库里发现 {} 个未导入的字体，自动收编",
                fresh.len()
            ));
            if let Ok(mut state) = app.state::<Store>().0.lock() {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                for p in &fresh {
                    state.linked.insert(p.clone());
                    state.added.entry(p.clone()).or_insert(now);
                }
                let _ = store::save(&state);
            }
            linked.extend(fresh);
        }
    }
    // 注册表探测（列出系统已注册的所有字体路径）跟扫描互不依赖，没必要排队：
    // 扫描几千个文件要好几秒，探测也要几百毫秒，串行做的话「进度条 100%」到
    // 「字体真正可用」之间就会多出一段干等。这里开一条线程先跑着，扫完再收。
    let probe_handle = std::thread::spawn(activation::probe);
    let t_scan = std::time::Instant::now();
    // 缓存跟着扫描一起在后台线程里创建并带回来：链接字体那一段要继续用它
    let (mut faces, mut cache) = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || {
            let mut cache = crate::fontcache::FontCache::load();
            let faces = scanner::scan_all(&app, &extra, &managed, &mut cache);
            (faces, cache)
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    eprintln!("[scan] 解析耗时 {:?}", t_scan.elapsed());

    // 链接进库的字体（导入时选「链接」而非复制）往往有几千个，而且全部躺在扫描目录之外：
    // 原来这里逐个重新解析，进度条显示 100% 之后还要干等十几秒才轮到它们。
    // 现在同样走解析缓存，并且边解析边推给界面。
    let t_linked = std::time::Instant::now();
    let mut linked_faces = Vec::new();
    let mut linked_batch: Vec<FontFace> = Vec::new();
    // 链接字体的目录也要做版权判定 + 备注留痕。
    // 这里是用户真正在用的库（几千个字面全躺在扫描目录之外），原来只有
    // scan_all 那条路算了 dirClass —— 结果界面上的版权全落到 name 表那点信息，
    // 目录里的授权说明（LICENSE / 授权说明.txt）根本没被看过。
    let mut linked_dirs: std::collections::HashMap<
        std::path::PathBuf,
        crate::copyright::DirCopyright,
    > = std::collections::HashMap::new();
    // 上面那条扫描链可能已经扫过同一批文件（字库目录同时被列进额外目录时），
    // 这里按路径去重，避免同一个字体出现两份卡片。
    let mut scanned: std::collections::HashSet<String> =
        faces.iter().map(|f| f.path.to_lowercase()).collect();
    for path in &linked {
        let p = std::path::Path::new(path);
        if !p.is_file() {
            continue;
        }
        if !scanned.insert(path.to_lowercase()) {
            continue;
        }
        let meta = std::fs::metadata(p).ok();
        let mtime = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let mut parsed = match cache.get(path, mtime, size, FontSource::Managed) {
            Some(hit) => hit,
            None => {
                let fresh = parser::parse_font_file(p, FontSource::Managed);
                cache.put(path, mtime, size, FontSource::Managed, &fresh);
                fresh
            }
        };
        if let Some(dir) = p.parent() {
            let found = linked_dirs
                .entry(dir.to_path_buf())
                .or_insert_with(|| crate::copyright::inspect_dir_files_only(dir))
                .clone();
            for face in &mut parsed {
                // 目录里有授权文件 / 目录名带后缀 → 用目录结论；否则只看这个字族自己的 name 表
                if found.class != crate::copyright::CopyrightClass::Unknown {
                    face.copyright_class = Some(found.class.as_str().to_string());
                    face.license_note = found.note.clone();
                } else {
                    let (cls, note) = crate::copyright::inspect_face(
                        face.license.as_deref(),
                        face.license_url.as_deref(),
                        face.copyright.as_deref(),
                    );
                    face.copyright_class = Some(cls.as_str().to_string());
                    face.license_note = note;
                }
            }
        }
        linked_batch.extend(parsed.iter().cloned());
        linked_faces.extend(parsed);
        if linked_batch.len() >= 240 {
            let _ = app.emit("scan:batch", &linked_batch);
            linked_batch.clear();
        }
    }
    if !linked_batch.is_empty() {
        let _ = app.emit("scan:batch", &linked_batch);
    }
    eprintln!(
        "[scan] 链接字体 {} 个，耗时 {:?}",
        linked.len(),
        t_linked.elapsed()
    );
    // 这一轮没见到的路径（删掉的字体 / 换掉的目录）从缓存里清掉，落盘放后台线程
    cache.finish();
    if !linked_faces.is_empty() {
        let ids: std::collections::HashSet<&str> =
            linked_faces.iter().map(|f| f.id.as_str()).collect();
        faces.retain(|f| !ids.contains(f.id.as_str()));
        faces.extend(linked_faces);
    }

    diag::index_library(&faces);
    let t_probe = std::time::Instant::now();
    // 并行探测的结果在这里收口；线程意外挂了就退回去自己再探一次
    let probe = probe_handle.join().unwrap_or_else(|_| activation::probe());
    eprintln!("[scan] 等注册表探测 {:?}", t_probe.elapsed());
    let store: State<Store> = app.state();
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    let before = state.linked.len();
    state.linked.retain(|p| std::path::Path::new(p).is_file());
    if state.linked.len() != before {
        let _ = store::save(&state);
    }
    let mut faces: Vec<FontFace> = faces
        .into_iter()
        .map(|mut f| {
            f.active = activation::is_active(&probe, &state, &f);
            f.added_at = state
                .added
                .get(&f.path)
                .copied()
                .or_else(|| file_time(&f.path, true));
            f
        })
        .collect();

    eprintln!("[scan] 全部就绪 {:?}（{} 个字面）", t_scan.elapsed(), faces.len());
    for (orig, parked) in &state.parked {
        for mut f in parser::parse_font_file(std::path::Path::new(parked), FontSource::User) {
            f.id = format!("{}#{}", orig, f.face_index);
            f.path = orig.clone();
            f.preview_path = Some(parked.clone());
            f.active = false;
            faces.push(f);
        }
    }
    Ok(faces)
}

#[tauri::command]
fn set_font_active(store: State<Store>, path: String, active: bool) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    activation::sync(&mut state, &path, active)?;
    store::save(&state)
}

#[tauri::command]
/**
 * 批量启停放在后台线程：同步命令跑在主线程上，几千个字体时界面会整个「无响应」
 * （GDI 装载 + 注册表写入，实测 5000 级要二三十分钟）。
 */
async fn set_fonts_active(store: State<'_, Store>, paths: Vec<String>, active: bool) -> Result<(), String> {
    let total = paths.len();
    let store = store.inner().clone();
    let failed = tauri::async_runtime::spawn_blocking(move || {
        let mut state = store.0.lock().map_err(|e| e.to_string())?;
        let failed = activation::sync_batch(&mut state, &paths, active);
        store::save(&state)?;
        Ok::<Vec<String>, String>(failed)
    })
    .await
    .map_err(|e| e.to_string())??;
    diag::batch(active, total, failed.len());
    activation::batch_error(&failed, total)
}

#[tauri::command]
async fn install_fonts(
    app: tauri::AppHandle,
    store: State<'_, Store>,
    paths: Vec<String>,
    existing: Vec<String>,
    mode: String,
) -> Result<installer::InstallResult, String> {
    let mode = installer::InstallMode::parse(&mode)?;
    let library_dir = {
        let state = store.0.lock().map_err(|e| e.to_string())?;
        state.active_library_dir().map(|s| s.to_owned())
    };
    let library = scanner::effective_managed_dir(library_dir.as_deref());
    let library_for_check = library.clone();
    let known: std::collections::HashSet<String> = existing.into_iter().collect();
    let scope_app = app.clone();
    let mut result =
        tauri::async_runtime::spawn_blocking(move || installer::install(&app, paths, &known, mode, &library))
            .await
            .map_err(|e| e.to_string())?;
    let mut auto = false;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut state) = store.0.lock() {
        if mode == installer::InstallMode::Link {
            for face in &result.installed {
                // zip 来源的字体实际已移动进字体库，不属于链接字体
                if !std::path::Path::new(&face.path).starts_with(&library_for_check) {
                    state.linked.insert(face.path.clone());
                }
            }
        }
        auto = state.auto_activate_imports && result.installed.len() < 64;
        for face in &result.installed {
            let _ = activation::sync(&mut state, &face.path, auto);
            state.added.insert(face.path.clone(), now);
        }
        let _ = store::save(&state);
    }
    for face in &result.installed {
        let p = std::path::Path::new(&face.path);
        if let Some(parent) = p.parent() {
            allow_dir(&scope_app, parent);
        }
    }
    for face in &mut result.installed {
        face.active = auto;
        face.added_at = Some(now);
    }
    Ok(result)
}

#[tauri::command]
async fn install_online_family(
    app: tauri::AppHandle,
    store: State<'_, Store>,
    paths: Vec<String>,
    existing: Vec<String>,
    family: String,
    license_path: Option<String>,
    source: String,
    license_dirs: Option<Vec<String>>,
) -> Result<installer::InstallResult, String> {
    let library_dir = {
        let state = store.0.lock().map_err(|e| e.to_string())?;
        state.active_library_dir().map(|s| s.to_owned())
    };
    let library = scanner::effective_managed_dir(library_dir.as_deref());
    let known: std::collections::HashSet<String> = existing.into_iter().collect();
    let scope_app = app.clone();
    let extra_dirs = license_dirs.unwrap_or_default();
    let mut result = tauri::async_runtime::spawn_blocking(move || {
        installer::install_online(
            &app,
            paths,
            &known,
            &family,
            license_path.as_deref(),
            &source,
            &library,
            &extra_dirs,
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    let mut auto = false;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut state) = store.0.lock() {
        auto = state.auto_activate_imports && result.installed.len() < 64;
        for face in &result.installed {
            let _ = activation::sync(&mut state, &face.path, auto);
            state.added.insert(face.path.clone(), now);
        }
        let _ = store::save(&state);
    }
    for face in &result.installed {
        let p = std::path::Path::new(&face.path);
        if let Some(parent) = p.parent() {
            allow_dir(&scope_app, parent);
        }
    }
    for face in &mut result.installed {
        face.active = auto;
        face.added_at = Some(now);
    }
    Ok(result)
}

#[tauri::command]
fn uninstall_font(store: State<Store>, path: String, family: String) -> Result<TrashEntry, String> {
    {
        let mut state = store.0.lock().map_err(|e| e.to_string())?;
        if state.deactivated.contains(&path) {
            activation::sync(&mut state, &path, true)?;
            store::save(&state)?;
        }
        if state.linked.contains(&path) {
            activation::drop_linked_alias(&state, &path);
            let entry = installer::unlink(&path, &family)?;
            state.linked.remove(&path);
            store::save(&state)?;
            return Ok(entry);
        }
    }
    installer::uninstall(&path, &family)
}

#[tauri::command]
fn list_trash() -> Vec<TrashEntry> {
    installer::list_trash()
}

#[tauri::command]
async fn affinity_connection() -> Result<affinity::AffinityConnection, String> {
    Ok(affinity::connection().await)
}

/// 底部预热指示条：三个目标软件各自「现在热不热」。
/// 只读快照，真正的探测在后台线程里做，这里不会被 COM 拖住。
#[tauri::command]
fn app_warm_state() -> Vec<serde_json::Value> {
    #[cfg(target_os = "windows")]
    {
        warm::snapshot()
            .into_iter()
            .filter_map(|w| serde_json::to_value(w).ok())
            .collect()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

#[tauri::command]
fn affinity_link() -> Option<affinity::AffinityConnection> {
    affinity::last_link()
}

#[tauri::command]
fn affinity_session_activate(
    store: State<Store>,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    let total = paths.len();
    let mut failed = Vec::new();
    let mut activated = Vec::with_capacity(total);
    for path in paths {
        match activation::sync(&mut state, &path, true) {
            Ok(()) => activated.push(path),
            Err(e) => failed.push(e),
        }
    }
    store::save(&state)?;
    diag::batch(true, total, failed.len());
    affinity::note_activated(activated.clone());
    activation::batch_error(&failed, total).map(|()| activated)
}

/** 改版权后的结果：成功改了几个目录、哪些目录没改成、哪些字体改名后没能重新启用。 */
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CopyrightSyncResult {
    renamed: usize,
    /// 没改成的目录（人话描述，直接给 toast 用）
    errors: Vec<String>,
    /// 目录改好了但字体没能重新启用（路径列表）：这些字体在界面上会显示为未启用
    reactivate_failed: Vec<String>,
}

/**
 * 把应用里改过的版权状态同步回字体库目录：目录名后缀跟着改（"Lora（商用免费）"）。
 * status 为 auto 时按「版权信息文件 > 文件夹备注 > 字体自带信息」重新判定；
 * 返回实际改名的目录数量。
 *
 * 目录里已启用的字体必须先停用再改名：Windows 的字体注册指向原文件路径，
 * 带着注册改名会让字体失效（注册表里留着一条指向不存在文件的记录）。
 *
 * 改名失败必须回报给前端：以前只写日志，用户看到的是「改了版权，字体全不见了」，
 * 却不知道是改名没成功（原因通常是文件被 Photoshop / 预览缓存占着）。
 */
#[tauri::command]
fn sync_family_copyright(
    store: State<'_, Store>,
    family: String,
    status: String,
) -> Result<CopyrightSyncResult, String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    let library = scanner::effective_managed_dir(state.active_library_dir());
    let dirs = copyright::family_dirs_for(&library, &family);
    let mut renamed = 0usize;
    let mut errors: Vec<String> = Vec::new();
    let mut reactivate_failed: Vec<String> = Vec::new();
    for dir in dirs {
        let class = copyright::class_from_status(&status)
            .unwrap_or_else(|| copyright::classify_dir(&dir));
        let target = dir
            .parent()
            .unwrap_or(library.as_path())
            .join(copyright::family_dir_name(&family, class));
        if target == dir {
            continue;
        }
        match rename_family_dir(&mut state, &dir, &target) {
            Ok(failed) => {
                renamed += 1;
                reactivate_failed.extend(failed);
            }
            Err(e) => {
                crate::diag::log(&format!(
                    "copyright: 改名失败 {} → {}：{e}",
                    dir.display(),
                    target.display()
                ));
                errors.push(e);
            }
        }
    }
    if renamed > 0 {
        installer::refresh_system_font_cache();
        store::save(&state)?;
    }
    Ok(CopyrightSyncResult {
        renamed,
        errors,
        reactivate_failed,
    })
}

/** 一次问一批字面「有没有中文字形」。
 *
 * 用途：字体里没汉字时，应用到 PS / AI / CDR 之后中文会原样不变或变成方块，
 * 用户容易以为是软件坏了。界面在展开字重、打开详情、以及真正应用前会先问一下，
 * 没有汉字就明确提示一句，而不是让用户对着没反应的文档猜。
 *
 * 入参是 (路径, 字面序号) 的数组，返回同序的布尔数组。
 */
#[tauri::command]
async fn font_cjk(
    probes: Vec<(String, u32)>,
) -> Result<Vec<bool>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        probes
            .into_iter()
            .map(|(path, index)| parser::face_has_cjk(std::path::Path::new(&path), index))
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/** 汉字覆盖的三档结论（"none" / "sparse" / "full"）。
 *
 * 比 `font_cjk` 多一档：卡片上要说清「一个汉字都没有」和「只有几百个字、排不了正文」
 * 是两回事。同族版本提示也用它——只有 full 的兄弟版本才值得推荐过去。
 */
#[tauri::command]
async fn font_han_coverage(
    probes: Vec<(String, u32)>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        probes
            .into_iter()
            .map(|(path, index)| {
                parser::face_han_coverage(std::path::Path::new(&path), index)
                    .as_str()
                    .to_string()
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/** 精确统计字符集构成（详情面板用）。
 *
 * 和扫描时用的抽样判定分开：这里要枚举全部码位，单个 8MB 中文字体要 2~5ms，
 * 5000 个字面全做会让启动慢十几秒。只在打开详情面板时对当前这个字面调一次。
 */
#[tauri::command]
async fn font_charset(probes: Vec<(String, u32)>) -> Result<Vec<CharsetStats>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        probes
            .into_iter()
            .map(|(path, index)| parser::face_charset_stats(std::path::Path::new(&path), index))
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/** 备用预览字体：浏览器打不开这个字面时，让后端修一份能加载的副本。
 *
 * 两类字体在 WebView2 里必定加载失败，卡片上就只剩「这种格式暂时无法预览」：
 * `.ttc` 字体集合（OTS 拒收 ttcf 容器）和 cmap 只有旧编码子表的老字体
 * （Big5 / GBK / ShiftJIS，OTS 报 no supported subtables）。详见 preview_font。
 *
 * 返回缓存文件的绝对路径；浏览器本来就能打开、或修不出来时返回 null。
 * 只有加载失败才会调到这儿，正常字体不受影响。
 */
#[tauri::command]
async fn font_preview_file(
    app: tauri::AppHandle,
    path: String,
    face_index: u32,
) -> Result<Option<String>, String> {
    let scope = app.asset_protocol_scope();
    tauri::async_runtime::spawn_blocking(move || {
        preview_font::ensure_preview_font(std::path::Path::new(&path), face_index).map(|p| {
            // 单独放行这一份（目录级放行在启动时做过，这里兜住运行期新建的文件）
            let _ = scope.allow_file(&p);
            p.to_string_lossy().into_owned()
        })
    })
    .await
    .map_err(|e| e.to_string())
}

/** 逐字符查字形覆盖：问一批字面「`chars` 里每个字符有没有字形」。
 *
 * 顶栏示例文字会先判出用到哪些书写系统（汉字 / 假名 / 拉丁 …），把各系统的探针
 * 拼成一条串发过来；返回同序的布尔矩阵，前端据此在卡片和字重行上标
 * 「无中文 / 无日文 …」。
 */
#[tauri::command]
async fn font_coverage(
    probes: Vec<(String, u32)>,
    chars: String,
) -> Result<Vec<Vec<bool>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let list: Vec<char> = chars.chars().collect();
        probes
            .into_iter()
            .map(|(path, index)| parser::face_glyph_hits(std::path::Path::new(&path), index, &list))
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// 把字族目录整体搬到新名字（含所有字体与版权信息文件），返回 旧路径 → 新路径。
///
/// 优先用「整目录改名」：同一分区上这是一步原子操作，要么整个目录换了名字，
/// 要么一个文件都没动。以前的实现是逐个文件 `fs::rename`，只要有一个字体被
/// PS / 预览缓存 / 杀软占着，就会搬到一半报错 —— 字族被劈成「旧目录一半、新目录一半」，
/// 这才是「改完版权之后有些字体找不到」的真正来源。
fn move_dir_contents(
    dir: &std::path::Path,
    target: &std::path::Path,
) -> Result<Vec<(String, String)>, String> {
    use std::fs;

    // 目标不存在时先试整目录改名（最快最安全）
    if !target.exists() && fs::rename(dir, target).is_ok() {
        let mut moved = Vec::new();
        collect_dir_pairs(dir, target, &mut moved);
        return Ok(moved);
    }

    // 目标已存在（同名目录合并）或整目录改不动：退化成逐个文件搬，但失败就整批回滚
    fs::create_dir_all(target).map_err(|e| format!("创建目录失败：{e}"))?;
    let mut moved: Vec<(String, String)> = Vec::new();
    let attempt = (|| -> Result<(), String> {
        let mut stack: Vec<(std::path::PathBuf, std::path::PathBuf)> =
            vec![(dir.to_path_buf(), target.to_path_buf())];
        while let Some((src_dir, dst_dir)) = stack.pop() {
            let entries = fs::read_dir(&src_dir).map_err(|e| e.to_string())?;
            for entry in entries.filter_map(|e| e.ok()) {
                let src = entry.path();
                let name = entry.file_name();
                if src.is_dir() {
                    let sub = dst_dir.join(&name);
                    fs::create_dir_all(&sub).map_err(|e| e.to_string())?;
                    stack.push((src, sub));
                    continue;
                }
                let mut dst = dst_dir.join(&name);
                let mut n = 1;
                while dst.exists() {
                    dst = dst_dir.join(format!("{n}-{}", name.to_string_lossy()));
                    n += 1;
                }
                fs::rename(&src, &dst)
                    .map_err(|e| format!("{}：{e}", src.display()))?;
                moved.push((
                    src.to_string_lossy().into_owned(),
                    dst.to_string_lossy().into_owned(),
                ));
            }
        }
        Ok(())
    })();
    if let Err(e) = attempt {
        // 已经搬过去的搬回来：宁可这次改名不成功（目录名保持旧的样子），
        // 也不要留下一个半新半旧的字族
        for (old, new) in moved.iter().rev() {
            let _ = fs::rename(new, old);
        }
        // 清掉刚建出来、现在已经空了的目录
        let _ = fs::remove_dir(target);
        return Err(e);
    }

    // 目录里已经没有文件了，清掉空壳（有残留文件说明搬漏了，保留不动）
    let leftover = fs::read_dir(dir)
        .map(|r| r.filter_map(|e| e.ok()).count())
        .unwrap_or(0);
    if leftover == 0 {
        let _ = fs::remove_dir_all(dir);
    }
    Ok(moved)
}

/// 整目录改名成功后，把新目录里的文件列成「旧路径 → 新路径」。
/// 目录已经整体搬过去了，旧路径按相同的相对路径从旧根拼出来。
fn collect_dir_pairs(
    old_root: &std::path::Path,
    new_root: &std::path::Path,
    out: &mut Vec<(String, String)>,
) {
    let mut stack = vec![new_root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let Ok(rel) = path.strip_prefix(new_root) else {
                continue;
            };
            out.push((
                old_root.join(rel).to_string_lossy().into_owned(),
                path.to_string_lossy().into_owned(),
            ));
        }
    }
}

/// 这个路径对应的字体当前是不是启用状态。
/// Windows 上启用 = 注册表里有它（字体库里"没被停用"不等于已注册，刚复制进去的字体就没注册），
/// 只有真的注册过才需要在改名前后停用 / 重新启用。
fn is_activated(state: &crate::store::AppState, path: &str) -> bool {
    if state.deactivated.contains(path) || state.parked.contains_key(path) {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        !crate::registry::user_entries_for(path).is_empty()
            || crate::registry::is_machine_registered(path)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = state;
        true
    }
}

/// 改字族目录名：先停用该目录里已启用的字体 → 搬文件 → 用新路径重新启用，
/// 同时把 state 里按路径记录的信息（停用集合 / 入库时间 / 链接集合 / 注册表备份）改到新路径。
///
/// 返回「改好了但没能重新启用」的字体路径：这些字体在界面上是未启用状态，
/// 必须回报给用户，否则又是一次「字体凭空消失」。
fn rename_family_dir(
    state: &mut crate::store::AppState,
    dir: &std::path::Path,
    target: &std::path::Path,
) -> Result<Vec<String>, String> {
    let active: Vec<String> = {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            if let Ok(entries) = std::fs::read_dir(&d) {
                for entry in entries.filter_map(|e| e.ok()) {
                    let p = entry.path();
                    if p.is_dir() {
                        stack.push(p);
                        continue;
                    }
                    if !crate::parser::is_font_file(&p) {
                        continue;
                    }
                    let key = p.to_string_lossy().into_owned();
                    if is_activated(state, &key) {
                        out.push(key);
                    }
                }
            }
        }
        out.sort();
        out
    };
    for p in &active {
        let _ = activation::sync(state, p, false);
    }
    match move_dir_contents(dir, target) {
        Ok(moved) => {
            for (old, new) in &moved {
                if let Some(ts) = state.added.remove(old) {
                    state.added.insert(new.clone(), ts);
                }
                if state.deactivated.remove(old) {
                    state.deactivated.insert(new.clone());
                }
                if let Some(v) = state.parked.remove(old) {
                    state.parked.insert(new.clone(), v);
                }
                // 链接字体（外部目录单独挂进来的）也按路径记着，不跟着改就会变成悬空项
                if state.linked.remove(old) {
                    state.linked.insert(new.clone());
                }
                for (_name, path) in state.registry_backup.iter_mut() {
                    if path == old {
                        *path = new.clone();
                    }
                }
            }
            // 用新路径恢复原来的启用状态
            let renames: std::collections::HashMap<&str, &str> = moved
                .iter()
                .map(|(o, n)| (o.as_str(), n.as_str()))
                .collect();
            let mut failed = Vec::new();
            for old in &active {
                let Some(new) = renames.get(old.as_str()) else {
                    continue;
                };
                // 刚搬完的文件可能还被系统字体缓存放着，重试几次再算失败
                let mut ok = false;
                for attempt in 0..3 {
                    if activation::sync(state, new, true).is_ok() {
                        ok = true;
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(120 * (attempt + 1)));
                }
                if !ok {
                    crate::diag::log(&format!("copyright: 改名后没能重新启用 {new}"));
                    failed.push(new.to_string());
                }
            }
            Ok(failed)
        }
        Err(e) => {
            // 搬失败了就把字体恢复成原来的启用状态，别让用户的字体凭空消失
            for p in &active {
                let _ = activation::sync(state, p, true);
            }
            Err(e)
        }
    }
}

#[tauri::command]
async fn online_catalogue(store: State<'_, Store>, force: bool) -> Result<online::CatalogueResponse, String> {
    let client = {
        let state = store.0.lock().map_err(|e| e.to_string())?;
        net::client(&state)?
    };
    online::fontsource::catalogue(&client, force).await
}

#[tauri::command]
async fn online_family(store: State<'_, Store>, id: String) -> Result<online::FamilyDetail, String> {
    let client = {
        let state = store.0.lock().map_err(|e| e.to_string())?;
        net::client(&state)?
    };
    online::github::detail(&client, &id).await
}

#[tauri::command]
async fn online_download(
    app: tauri::AppHandle,
    store: State<'_, Store>,
    id: String,
    files: Option<Vec<String>>,
    license: Option<bool>,
) -> Result<online::DownloadResult, String> {
    let client = {
        let state = store.0.lock().map_err(|e| e.to_string())?;
        net::client(&state)?
    };
    online::github::download(&app, &client, &id, files.as_deref(), license.unwrap_or(true)).await
}

#[tauri::command]
async fn online_preview(app: tauri::AppHandle, store: State<'_, Store>, id: String) -> Result<String, String> {
    let client = {
        let state = store.0.lock().map_err(|e| e.to_string())?;
        net::client(&state)?
    };
    let path = online::github::preview(&client, &id).await?;
    if let Some(parent) = std::path::Path::new(&path).parent() {
        allow_dir(&app, parent);
    }
    Ok(path)
}

#[tauri::command]
fn online_clear_staging(id: String) {
    online::github::clear_staging(&id);
}

#[tauri::command]
fn online_hosts() -> Vec<String> {
    net::ALLOWED_HOSTS.iter().map(|h| h.to_string()).collect()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LicenseSaved {
    family: String,
    file_name: String,
    license_name: String,
    license_url: String,
    /// 匹配依据（命中的 PostScript 名），让用户能核对为什么算同一款字体
    postscript: String,
    written: Vec<String>,
}

/// 按字体身份（族名 + PostScript 名双严格）到上游反查许可证，命中后写进字体目录。
/// 任何一个条件对不上都返回 None，绝不猜。
#[tauri::command]
async fn font_license_fetch(
    store: State<'_, Store>,
    family: String,
    postscripts: Vec<String>,
    dirs: Vec<String>,
) -> Result<Option<LicenseSaved>, String> {
    let client = {
        let state = store.0.lock().map_err(|e| e.to_string())?;
        net::client(&state)?
    };
    // 先用在线目录做快速否定：目录里压根没有这个族名，就不必去上游挨个试 6 次
    // （商业字体点「搜索」应该立刻得到「没找到」，而不是等半分钟）
    let want = family.trim().to_lowercase();
    let listed = match online::fontsource::read_cache() {
        Some(cat) if !cat.families.is_empty() => Some(cat.families),
        _ => online::fontsource::catalogue(&client, false)
            .await
            .ok()
            .map(|c| c.families),
    };
    if let Some(families) = &listed {
        if !families.iter().any(|f| f.family.trim().to_lowercase() == want) {
            crate::diag::log(&format!("license: {family} 不在在线目录里 → 直接判定没搜到"));
            return Ok(None);
        }
    }
    let Some(hit) = online::github::search_license(&client, &family, &postscripts).await? else {
        return Ok(None);
    };
    let mut written: Vec<String> = Vec::new();
    for dir in &dirs {
        let path = std::path::Path::new(dir);
        if path.is_dir() && std::fs::write(path.join(&hit.file_name), &hit.text).is_ok() {
            written.push(dir.clone());
        }
    }
    if written.is_empty() {
        return Err("no writable font directory".to_string());
    }
    crate::diag::log(&format!(
        "license: {} 命中（族名一致 + PostScript {}），写入 {} 个目录",
        hit.family,
        hit.postscript,
        written.len()
    ));
    Ok(Some(LicenseSaved {
        family: hit.family,
        file_name: hit.file_name,
        license_name: hit.license_name,
        license_url: hit.license_url,
        postscript: hit.postscript,
        written,
    }))
}

/// 列出给定目录里的版权信息类文件（非递归）。
/// 在线栏目判断"字库是否已完整收录"时需要知道字族目录是否带版权文件。
#[tauri::command]
fn info_files(dirs: Vec<String>) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for dir in dirs {
        let path = std::path::Path::new(&dir);
        let Ok(entries) = std::fs::read_dir(path) else {
            continue;
        };
        let mut names: Vec<String> = Vec::new();
        for entry in entries.filter_map(|e| e.ok()) {
            let p = entry.path();
            if !p.is_file() || !installer::is_info_file(&p) {
                continue;
            }
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                names.push(name.to_string());
            }
        }
        if !names.is_empty() {
            names.sort();
            out.insert(dir, names);
        }
    }
    out
}

#[tauri::command]
fn restore_from_trash(store: State<Store>, entry_id: String) -> Result<(), String> {
    match installer::restore(&entry_id)? {
        installer::RestoreOutcome::Moved => Ok(()),
        installer::RestoreOutcome::Relinked(path) => {
            let mut state = store.0.lock().map_err(|e| e.to_string())?;
            state.linked.insert(path);
            store::save(&state)
        }
    }
}

#[tauri::command]
fn delete_trash_entry(entry_id: String) -> Result<(), String> {
    installer::delete_trash_entry(&entry_id)
}

#[tauri::command]
fn empty_trash() -> Result<(), String> {
    installer::empty_trash()
}

#[tauri::command]
fn get_tags(store: State<Store>) -> Result<HashMap<String, Vec<String>>, String> {
    let state = store.0.lock().map_err(|e| e.to_string())?;
    Ok(state.tags.clone())
}

#[tauri::command]
fn set_tags(store: State<Store>, family: String, tags: Vec<String>) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    if tags.is_empty() {
        state.tags.remove(&family);
    } else {
        state.tags.insert(family, tags);
    }
    store::save(&state)
}

#[tauri::command]
fn get_collections(store: State<Store>) -> Result<HashMap<String, Vec<String>>, String> {
    let state = store.0.lock().map_err(|e| e.to_string())?;
    Ok(state.collections.clone())
}

#[tauri::command]
fn set_collection(store: State<Store>, name: String, families: Vec<String>) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    state.collections.insert(name, families);
    store::save(&state)
}

#[tauri::command]
fn delete_collection(store: State<Store>, name: String) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    state.collections.remove(&name);
    store::save(&state)
}

#[tauri::command]
fn rename_collection(store: State<Store>, from: String, to: String) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    if state.collections.contains_key(&to) {
        return Err(format!("a collection named \"{to}\" already exists"));
    }
    let families = state
        .collections
        .remove(&from)
        .ok_or_else(|| format!("collection \"{from}\" not found"))?;
    state.collections.insert(to, families);
    store::save(&state)
}

#[tauri::command]
fn get_snapshots(store: State<Store>) -> Result<Vec<store::Snapshot>, String> {
    let state = store.0.lock().map_err(|e| e.to_string())?;
    Ok(state.snapshots.clone())
}

#[tauri::command]
fn save_snapshot(store: State<Store>, snapshot: store::Snapshot) -> Result<Vec<store::Snapshot>, String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    state.save_snapshot(snapshot);
    store::save(&state)?;
    Ok(state.snapshots.clone())
}

#[tauri::command]
fn delete_snapshot(store: State<Store>, name: String) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    state.snapshots.retain(|s| s.name != name);
    store::save(&state)
}

#[tauri::command]
fn rename_snapshot(store: State<Store>, from: String, to: String) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    if state.snapshot(&to).is_some() {
        return Err(format!("a snapshot named \"{to}\" already exists"));
    }
    let snap = state
        .snapshot(&from)
        .cloned()
        .ok_or_else(|| format!("snapshot \"{from}\" not found"))?;
    state.snapshots.retain(|s| s.name != from);
    state.save_snapshot(store::Snapshot {
        name: to,
        created_at: snap.created_at,
        entries: snap.entries,
    });
    store::save(&state)
}

#[tauri::command]
fn play_sound(kind: String, level: String) {
    sound::play(&kind, &level);
}

#[tauri::command]
fn get_notes(store: State<Store>) -> Result<HashMap<String, String>, String> {
    let state = store.0.lock().map_err(|e| e.to_string())?;
    Ok(state.notes.clone())
}

#[tauri::command]
fn set_note(store: State<Store>, family: String, note: String) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    if note.trim().is_empty() {
        state.notes.remove(&family);
    } else {
        state.notes.insert(family, note);
    }
    store::save(&state)
}

#[derive(serde::Deserialize)]
struct LicenseNoteSeed {
    family: String,
    note: String,
}

/// 把扫描时从授权文档摘出的「哪些渠道能 / 不能商用」原话写进备注。
///
/// 只在「这个字族还没有备注，且从没自动写过」时写一次：
/// 用户改过备注不会被覆盖，用户主动删掉也不会下次启动又冒出来。
#[tauri::command]
fn seed_license_notes(store: State<Store>, items: Vec<LicenseNoteSeed>) -> Result<Vec<String>, String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    let mut seeded = Vec::new();
    for it in items {
        let family = it.family.trim().to_string();
        let note = it.note.trim().to_string();
        if family.is_empty() || note.is_empty() {
            continue;
        }
        if state.notes.contains_key(&family) || state.note_seeded.contains(&family) {
            continue;
        }
        state.notes.insert(family.clone(), note);
        state.note_seeded.insert(family.clone());
        seeded.push(family);
    }
    if !seeded.is_empty() {
        store::save(&state)?;
    }
    Ok(seeded)
}

#[tauri::command]
fn get_favorites(store: State<Store>) -> Result<Vec<String>, String> {
    let state = store.0.lock().map_err(|e| e.to_string())?;
    Ok(state.favorites.iter().cloned().collect())
}

#[tauri::command]
fn set_favorite(store: State<Store>, family: String, favorite: bool) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    if favorite {
        state.favorites.insert(family);
    } else {
        state.favorites.remove(&family);
    }
    store::save(&state)
}

const DESIGN_W: f64 = 1280.0;
const DESIGN_H: f64 = 820.0;
const SCALE_STEPS: [f64; 4] = [0.8, 0.85, 0.9, 1.0];

fn auto_ui_scale(avail_w: f64, avail_h: f64) -> f64 {
    let raw = (avail_w / DESIGN_W).min(avail_h / DESIGN_H);
    let mut chosen = SCALE_STEPS[0];
    for step in SCALE_STEPS {
        if step <= raw + 0.0001 {
            chosen = step;
        }
    }
    chosen
}

fn fit_window(window: &tauri::WebviewWindow, scale_pref: Option<f64>) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        if let Some(scale) = scale_pref {
            let _ = window.set_zoom(scale);
        }
        return;
    };
    let dpi = monitor.scale_factor();
    if !(dpi > 0.0) {
        return;
    }
    let work = monitor.work_area();
    let avail_w = work.size.width as f64 / dpi;
    let avail_h = work.size.height as f64 / dpi;
    if !(avail_w > 0.0) || !(avail_h > 0.0) {
        return;
    }

    if let Ok(size) = window.inner_size() {
        let cur_w = size.width as f64 / dpi;
        let cur_h = size.height as f64 / dpi;
        let w = cur_w.min(avail_w);
        let h = cur_h.min(avail_h);
        if w < cur_w - 0.5 || h < cur_h - 0.5 {
            let _ = window.set_size(tauri::LogicalSize::new(w, h));
        }
        let x = work.position.x as f64 / dpi + (avail_w - w).max(0.0) / 2.0;
        let y = work.position.y as f64 / dpi + (avail_h - h).max(0.0) / 2.0;
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }

    let scale = scale_pref.unwrap_or_else(|| auto_ui_scale(avail_w, avail_h));
    let _ = window.set_zoom(scale);
}

#[tauri::command]
fn set_ui_scale(window: tauri::WebviewWindow, scale: Option<f64>) -> Result<f64, String> {
    let clamped = scale.map(|s| s.clamp(0.5, 2.0));
    fit_window_scale_only(&window, clamped)
}

fn fit_window_scale_only(window: &tauri::WebviewWindow, scale_pref: Option<f64>) -> Result<f64, String> {
    let resolved = match scale_pref {
        Some(s) => s,
        None => {
            let monitor = window
                .current_monitor()
                .map_err(|e| e.to_string())?
                .ok_or("no monitor")?;
            let dpi = monitor.scale_factor();
            let work = monitor.work_area();
            auto_ui_scale(
                work.size.width as f64 / dpi,
                work.size.height as f64 / dpi,
            )
        }
    };
    window.set_zoom(resolved).map_err(|e| e.to_string())?;
    Ok(resolved)
}

#[tauri::command]
async fn fonts_with_char(paths: Vec<String>, codepoint: u32) -> Result<Vec<String>, String> {
    let Some(ch) = char::from_u32(codepoint) else {
        return Err("not a Unicode character".into());
    };
    tauri::async_runtime::spawn_blocking(move || sweep_charset(&paths, ch))
        .await
        .map_err(|e| e.to_string())
}

fn sweep_charset(paths: &[String], ch: char) -> Vec<String> {
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8)
        .max(1);
    let chunk = paths.len().div_ceil(workers).max(1);
    std::thread::scope(|scope| {
        let handles: Vec<_> = paths
            .chunks(chunk)
            .map(|group| {
                scope.spawn(move || {
                    let mut found = Vec::new();
                    for path in group {
                        let Ok(data) = std::fs::read(path) else {
                            continue;
                        };
                        let count = ttf_parser::fonts_in_collection(&data).unwrap_or(1);
                        let covered = (0..count).any(|i| {
                            ttf_parser::Face::parse(&data, i)
                                .map(|f| f.glyph_index(ch).is_some())
                                .unwrap_or(false)
                        });
                        if covered {
                            found.push(path.clone());
                        }
                    }
                    found
                })
            })
            .collect();
        handles
            .into_iter()
            .filter_map(|h| h.join().ok())
            .flatten()
            .collect::<Vec<String>>()
    })
}

#[tauri::command]
fn get_charset(path: String, face_index: u32) -> Result<Vec<u32>, String> {
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let face = ttf_parser::Face::parse(&data, face_index).map_err(|e| e.to_string())?;
    let mut cps: Vec<u32> = Vec::new();
    if let Some(cmap) = face.tables().cmap {
        for sub in cmap.subtables {
            if !sub.is_unicode() {
                continue;
            }
            sub.codepoints(|cp| {
                if cp > 0x20 && cp != 0x7f {
                    cps.push(cp);
                }
            });
        }
    }
    cps.sort_unstable();
    cps.dedup();
    cps.truncate(4096);
    Ok(cps)
}

#[tauri::command]
fn export_font(src: String, dest: String) -> Result<(), String> {
    std::fs::copy(&src, &dest).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 8 * 1024 * 1024 {
        return Err("file is too large to be a library export".into());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

static SESSION_ACTIVATED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

#[tauri::command]
fn set_fonts_active_session(store: State<Store>, paths: Vec<String>) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    let total = paths.len();
    let mut failed = Vec::new();
    let mut activated = Vec::with_capacity(total);
    for path in paths {
        match activation::sync(&mut state, &path, true) {
            Ok(()) => activated.push(path),
            Err(e) => failed.push(e),
        }
    }
    store::save(&state)?;
    diag::batch(true, total, failed.len());
    if let Ok(mut session) = SESSION_ACTIVATED.lock() {
        session.extend(activated);
    }
    activation::batch_error(&failed, total)
}

fn revert_session_activations(app: &tauri::AppHandle) {
    use tauri::Manager;
    let paths: Vec<String> = match SESSION_ACTIVATED.lock() {
        Ok(mut s) => std::mem::take(&mut *s),
        Err(_) => return,
    };
    if paths.is_empty() {
        return;
    }
    let store = app.state::<Store>();
    let mut guard = match store.0.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    for p in &paths {
        let _ = activation::sync(&mut guard, p, false);
    }
    affinity::revert_session(&mut guard);
    let _ = store::save(&guard);
}

#[tauri::command]
fn write_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_features(path: String, face_index: u32) -> Result<Vec<String>, String> {
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let face = ttf_parser::Face::parse(&data, face_index).map_err(|e| e.to_string())?;
    let mut tags: Vec<String> = Vec::new();
    let mut collect = |table: Option<ttf_parser::opentype_layout::LayoutTable>| {
        if let Some(t) = table {
            for f in t.features {
                tags.push(String::from_utf8_lossy(&f.tag.to_bytes()).into_owned());
            }
        }
    };
    collect(face.tables().gsub);
    collect(face.tables().gpos);
    tags.sort_unstable();
    tags.dedup();
    Ok(tags)
}

#[tauri::command]
fn export_fonts(paths: Vec<String>, dest_dir: String) -> Result<u32, String> {
    let dir = std::path::Path::new(&dest_dir);
    if !dir.is_dir() {
        return Err("destination is not a directory".into());
    }
    let mut n = 0;
    for p in paths {
        let src = std::path::Path::new(&p);
        let name = src.file_name().ok_or("invalid font path")?;
        std::fs::copy(src, dir.join(name)).map_err(|e| e.to_string())?;
        n += 1;
    }
    Ok(n)
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    extra_dirs: Vec<String>,
    watch_enabled: bool,
    auto_activate_imports: bool,
    library_dir: Option<String>,
    library_dir_enabled: bool,
    affinity_enabled: bool,
    affinity_deactivate_on_quit: bool,
    online_fonts_enabled: bool,
}

#[tauri::command]
fn get_settings(store: State<Store>) -> Result<Settings, String> {
    let state = store.0.lock().map_err(|e| e.to_string())?;
    Ok(Settings {
        extra_dirs: state.extra_dirs.clone(),
        watch_enabled: state.watch_enabled,
        auto_activate_imports: state.auto_activate_imports,
        library_dir: state.library_dir.clone(),
        library_dir_enabled: state.library_dir_enabled,
        affinity_enabled: state.affinity_enabled,
        affinity_deactivate_on_quit: state.affinity_deactivate_on_quit,
        online_fonts_enabled: state.online_fonts_enabled,
    })
}

#[tauri::command]
fn set_settings(
    app: tauri::AppHandle,
    store: State<Store>,
    settings: Settings,
) -> Result<(), String> {
    {
        let mut state = store.0.lock().map_err(|e| e.to_string())?;
        state.extra_dirs = settings.extra_dirs.clone();
        state.watch_enabled = settings.watch_enabled;
        state.auto_activate_imports = settings.auto_activate_imports;
        state.library_dir = settings.library_dir.clone();
        state.library_dir_enabled = settings.library_dir_enabled;
        state.affinity_enabled = settings.affinity_enabled;
        state.affinity_deactivate_on_quit = settings.affinity_deactivate_on_quit;
        state.online_fonts_enabled = settings.online_fonts_enabled;
        store::save(&state)?;
    }
    allow_dir(
        &app,
        &scanner::effective_managed_dir(
            settings
                .library_dir_enabled
                .then(|| settings.library_dir.as_deref())
                .flatten(),
        ),
    );
    allow_previews(&app, &settings.extra_dirs);
    apply_watch(&app, settings.watch_enabled, &settings.extra_dirs)
}

#[tauri::command]
fn default_library_dir() -> String {
    scanner::managed_font_dir().to_string_lossy().into_owned()
}

fn allow_dir(app: &tauri::AppHandle, dir: &std::path::Path) {
    let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let _ = app.asset_protocol_scope().allow_directory(&dir, true);
}

fn allow_previews(app: &tauri::AppHandle, extra: &[String]) {
    let scope = app.asset_protocol_scope();
    for (dir, _) in scanner::all_dirs(extra) {
        let dir = std::fs::canonicalize(&dir).unwrap_or(dir);
        let _ = scope.allow_directory(&dir, true);
    }
}

fn apply_watch(app: &tauri::AppHandle, enabled: bool, extra: &[String]) -> Result<(), String> {
    let handle: State<watcher::WatchHandle> = app.state();
    let mut slot = handle.0.lock().map_err(|e| e.to_string())?;
    *slot = None;
    if enabled {
        let dirs = scanner::all_dirs(extra).into_iter().map(|(d, _)| d).collect();
        *slot = Some(watcher::start(app.clone(), dirs)?);
    }
    Ok(())
}

fn close_to_tray_enabled(app: &tauri::AppHandle) -> bool {
    app.try_state::<Store>()
        .and_then(|store| {
            store
                .0
                .lock()
                .ok()
                .and_then(|s| s.prefs.get("closeToTray").and_then(|v| v.as_bool()))
        })
        .unwrap_or(false)
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let show = MenuItem::with_id(app, "show", "Show ZFontManager", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let icon = app
        .default_window_icon()
        .ok_or_else(|| tauri::Error::InvalidIcon(std::io::Error::other("no bundled window icon")))?
        .clone();

    let builder = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("ZFontManager")
        .menu(&menu);

    let builder = if cfg!(target_os = "windows") {
        builder.show_menu_on_left_click(false)
    } else {
        builder
    };

    builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())
    } else {
        mgr.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_prefs(store: State<Store>) -> Result<serde_json::Value, String> {
    let state = store.0.lock().map_err(|e| e.to_string())?;
    Ok(state.prefs.clone())
}

#[tauri::command]
fn set_prefs(store: State<Store>, prefs: serde_json::Value) -> Result<(), String> {
    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    state.prefs = prefs;
    store::save(&state)
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(format!("refusing to open non-web URL: {url}"));
    }

    #[cfg(target_os = "linux")]
    let spawned = std::process::Command::new("xdg-open").arg(&url).spawn();

    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(&url).spawn();

    #[cfg(target_os = "windows")]
    let spawned = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
    };

    spawned.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn adobe_available() -> bool {
    adobe::available()
}

#[tauri::command]
async fn apply_font_in_app(
    app: String,
    postscript_name: String,
    label: String,
    family_name: String,
    aliases: Option<Vec<String>>,
) -> Result<String, String> {
    let aliases = aliases.unwrap_or_default();
    let target = adobe::Target::parse(&app)?;
    let warm_id = match target {
        adobe::Target::Photoshop => Some("photoshop"),
        adobe::Target::Illustrator => Some("illustrator"),
        adobe::Target::CorelDraw => None,
    };
    // family_name 是 PostScript 名认不出时的回退名（真正的字族名）；
    // label 只用于提示文案（字重级时是「族名 字重」）。
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        adobe::apply(target, &postscript_name, &label, &family_name, &aliases)
    })
    .await
    .map_err(|e| e.to_string())??;
    // 成功应用之后让预热心跳安静一会儿：否则它紧接着去探测，很容易和应用时的
    // COM 调用撞在一起超时，底部那条预热状态就「刷新」一下甚至变红。
    if let Some(id) = warm_id {
        if outcome.starts_with("applied:") || outcome == "created" {
            warm::note_activity(id);
        }
    }
    Ok(outcome)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 已经有一个实例在跑：把它正开着的那个窗口（哪怕正收在屏幕顶端一根细线里）
    // 叫回完整界面，然后自己退出。没有这一步时从桌面图标再点一次会起第二个进程，
    // 任务栏里出现两个一模一样的图标，用户要的「打开已经开着的软件」却没反应。
    if !single_instance::acquire() {
        return;
    }

    let mut state = store::load();
    diag::session_start();
    activation::reconcile(&mut state);

    let watch_enabled = state.watch_enabled;
    let ui_scale_pref = state
        .prefs
        .get("uiScale")
        .and_then(|v| v.as_f64())
        .map(|s| s.clamp(0.5, 2.0));
    // 速览快捷键：默认 Alt + `，用户可以在设置里改（存 prefs.quickbarHotkey）
    let quickbar_hotkey = state
        .prefs
        .get("quickbarHotkey")
        .and_then(|v| serde_json::from_value::<window_dock::HotkeySpec>(v.clone()).ok())
        .unwrap_or_default();
    let extra_dirs = state.extra_dirs.clone();
    // 「启动时最小化到托盘」：是的话就别急着把窗口亮出来
    let start_minimized = state
        .prefs
        .get("startMinimized")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let library_dir = state.active_library_dir().map(|s| s.to_owned());
    let linked_dirs: Vec<String> = state.linked.iter().cloned().collect();
    // 上次运行学到「raw.githubusercontent.com 在本机不通」的话，这次直接走镜像，
    // 不用让用户在第一次下载/搜索版权时先等 10 秒超时
    net::seed_raw_unreachable(state.raw_unreachable);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(Store(std::sync::Arc::new(std::sync::Mutex::new(state))))
        .manage(watcher::WatchHandle(std::sync::Mutex::new(None)))
        .setup(move |app| {
            // 网络层学到的「原始地址不可达」要跨重启记住：每次翻转才写盘一次，开销可忽略
            {
                let handle = app.handle().clone();
                net::set_persist_hook(Box::new(move |unreachable| {
                    let handle = handle.clone();
                    std::thread::spawn(move || {
                        let Some(store) = handle.try_state::<Store>() else { return };
                        let Ok(mut st) = store.0.lock() else { return };
                        if st.raw_unreachable != unreachable {
                            st.raw_unreachable = unreachable;
                            let _ = store::save(&st);
                        }
                    });
                }));
            }
            // 首实例：等「再点一次图标」的信号，收到就通知前端把完整界面叫出来
            single_instance::watch(app.handle().clone());
            // 系统级 Alt + `：注册成全局热键，任何软件在前台时都能把速览拉下来
            window_dock::start_hotkey_listener(app.handle().clone(), quickbar_hotkey);
            if let Some(window) = app.get_webview_window("main") {
                fit_window(&window, ui_scale_pref);
                // 四角裁成系统窗口那种圆角（Win11 生效；Win10 上无副作用）。
                // 速览收起成一根线时窗口只有十几像素高，会由 watch_height 自动切回直角，
                // 不然 DWM 的固定半径会把抓手线两头切掉。
                #[cfg(target_os = "windows")]
                {
                    if let Ok(hwnd) = window.hwnd() {
                        window_round::round_corners(hwnd.0 as *mut std::ffi::c_void);
                    }
                    window_round::watch_height(window.clone());
                }
                // 立刻把窗口亮出来，再等前端把字库扫完。
                // 原来是「前端 init 全部完成才 show」——几千个字体的扫描要好几秒，
                // 这段时间用户对着空桌面，看不到任何反馈。现在窗口一出来就是骨架屏 +
                // 底部百分比进度条（components/LoadProgress.tsx），扫完自动换成字体库。
                if !start_minimized {
                    let _ = window.show();
                }
            }
            let tray_ok = build_tray(app.handle()).is_ok();
            if let Some(window) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if tray_ok && close_to_tray_enabled(&handle) {
                            api.prevent_close();
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        }
                    }
                });
            }
            allow_previews(app.handle(), &extra_dirs);
            allow_dir(
                app.handle(),
                &scanner::effective_managed_dir(library_dir.as_deref()),
            );
            for path in &linked_dirs {
                if let Some(parent) = std::path::Path::new(path).parent() {
                    allow_dir(app.handle(), parent);
                }
            }
            // 预览修复缓存也要能被 asset 协议读到：它不在字体库目录里，
            // 配置里的 $APPDATA 指向的是带应用标识的目录，覆盖不到这里
            if let Some(dir) = preview_font::cache_root() {
                allow_dir(app.handle(), &dir);
            }
            if watch_enabled {
                let _ = apply_watch(app.handle(), true, &extra_dirs);
            }
            if !cfg!(target_os = "linux") {
                let affinity_app = app.handle().clone();
                std::thread::spawn(move || loop {
                    affinity::tick(&affinity_app);
                    std::thread::sleep(std::time::Duration::from_secs(2));
                });
            }
            // CorelDRAW 的 COM 首次连接要 4~5 秒（详见 comhost.rs），放在后台点火，
            // 这样用户第一次点「在 CorelDRAW 中应用」时只剩几十毫秒的实际操作。
            // CorelDRAW 没开时 Attach 会立刻返回 not-running（宿主进程仍然留着复用），
            // 所以多试几轮几乎没有成本——原来只试 4 分钟，用户 10 分钟后才用就必然冷启动。
            #[cfg(target_os = "windows")]
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                for _ in 0..40 {
                    if matches!(comhost::warm().as_deref(), Ok("ok")) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_secs(15));
                }
            });

            // 底部预热指示器的心跳：只做进程探测（几毫秒），真正连 COM 的探针
            // 由 warm 模块自己在后台线程里发起，这里不会被拖慢。
            #[cfg(target_os = "windows")]
            std::thread::spawn(|| loop {
                warm::tick();
                std::thread::sleep(std::time::Duration::from_millis(400));
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_autostart,
            get_autostart,
            scan_fonts,
            set_font_active,
            set_fonts_active,
            set_fonts_active_session,
            install_fonts,
            install_online_family,
            uninstall_font,
            list_trash,
            affinity_connection,
            app_warm_state,
            affinity_link,
            affinity_session_activate,
            online_catalogue,
            online_family,
            online_download,
            online_preview,
            online_clear_staging,
            online_hosts,
            info_files,
            font_license_fetch,
            restore_from_trash,
            delete_trash_entry,
            empty_trash,
            get_tags,
            set_tags,
            get_collections,
            set_collection,
            delete_collection,
            rename_collection,
            get_snapshots,
            save_snapshot,
            delete_snapshot,
            rename_snapshot,
            export_font,
            export_fonts,
            write_text_file,
            read_text_file,
            write_binary_file,
            get_features,
            sync_family_copyright,
            font_cjk,
            font_han_coverage,
            font_charset,
            font_coverage,
            font_preview_file,
            get_favorites,
            set_favorite,
            get_notes,
            set_note,
            seed_license_notes,
            play_sound,
            get_charset,
            fonts_with_char,
            set_ui_scale,
            get_prefs,
            set_prefs,
            get_settings,
            set_settings,
            default_library_dir,
            open_url,
            adobe_available,
            apply_font_in_app,
            window_dock::set_quickbar_mode,
            window_dock::set_dock_sensor,
            window_dock::set_quickbar_hotkey,
            window_dock::focus_quickbar,
            window_dock::set_window_transitions,
            window_morph::morph_window
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                revert_session_activations(app);
                // 常驻 COM 宿主是独立进程，必须显式收掉，否则会留在后台
                #[cfg(target_os = "windows")]
                comhost::shutdown();
            }
        });
}
