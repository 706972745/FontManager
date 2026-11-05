//! 扫描字体库（业务层版本）。
//!
//! 从 `lib.rs::scan_fonts` 原样搬过来，只把三处 Tauri 依赖换成回调：
//! `app.state::<Store>()` → 传入的 [`Store`]；`app.emit("scan:*")` → [`ScanSink`]。
//! 命令层（WebView）与本地 HTTP API 共用这一份实现 —— 扫描逻辑只有一套。

use crate::font_types::{FontFace, FontSource};
use crate::store::{self, Store};
use crate::{activation, copyright, diag, installer, parser, scanner};

/// 进度接收方。界面实现成 `app.emit("scan:progress"/"scan:batch")`，
/// HTTP 侧实现成写 job 表，谁都不会漏。
pub trait ScanSink {
    fn progress(&self, done: usize, total: usize);
    fn batch(&self, faces: &[FontFace]);
}

fn file_time(path: &str, birth: bool) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    let t = if birth {
        meta.created().or_else(|_| meta.modified()).ok()?
    } else {
        meta.modified().ok()?
    };
    t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs())
}

fn migrate_note_rules(store: &Store) {
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

/// 扫描全部字体源（系统目录 + 额外目录 + 字库 + 链接字体），返回字面列表。
///
/// 这是**阻塞调用**：几千个字体要几秒到几分钟，调用方必须放到后台线程
/// （命令层用 `spawn_blocking`，HTTP 侧用 `tokio::task::spawn_blocking`）。
pub fn scan_library(store: &Store, sink: &dyn ScanSink) -> Result<Vec<FontFace>, String> {    let (extra, library_dir, linked, unpreviewable) = {
            let state = store.0.lock().map_err(|e| e.to_string())?;
        (
            state.extra_dirs.clone(),
            state.active_library_dir().map(|s| s.to_owned()),
            state.linked.clone(),
            state.unpreviewable.clone(),
        )
    };
    let managed = scanner::effective_managed_dir(library_dir.as_deref());
    migrate_note_rules(store);
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
            if let Ok(mut state) = store.0.lock() {
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
    // 链接进库的字体（导入时选「链接」而非复制）往往有几千个，而且全部躺在扫描目录之外：
    // 先数一遍（只做 is_file，便宜），好把它们算进同一条进度条。
    // 以前它们发生在进度 100% 之后且不发任何进度事件 —— 界面上就是卡在 100%（0.9.8-1 修）。
    let linked_files: Vec<String> = linked
        .iter()
        .filter(|p| std::path::Path::new(p).is_file())
        .cloned()
        .collect();
    let linked_total = linked_files.len();
    // 注册表探测（列出系统已注册的所有字体路径）跟扫描互不依赖，没必要排队：
    // 扫描几千个文件要好几秒，探测也要几百毫秒，串行做的话「进度条 100%」到
    // 「字体真正可用」之间就会多出一段干等。这里开一条线程先跑着，扫完再收。
    let probe_handle = std::thread::spawn(activation::probe);
    let t_scan = std::time::Instant::now();
    // 缓存跟着扫描一起在后台线程里创建并带回来：链接字体那一段要继续用它
    let (mut faces, mut cache, scan_files) = {
        let managed = managed.clone();
        let mut cache = crate::fontcache::FontCache::load();
        let (faces, files) = scanner::scan_all(
            &extra,
            &managed,
            &mut cache,
            linked_total,
            &|done, total| sink.progress(done, total),
            &|batch| sink.batch(batch),
        );
        (faces, cache, files)
    };
    eprintln!("[scan] 解析耗时 {:?}", t_scan.elapsed());
    // 总进度 = 系统/额外目录的文件 + 字库链接字体；两条链共用这一条进度
    let grand_total = scan_files + linked_total;

    // 链接进库的字体（导入时选「链接」而非复制）往往有几千个，而且全部躺在扫描目录之外：
    // 原来这里逐个重新解析，进度条显示 100% 之后还要干等十几秒才轮到它们。
    // 现在同样走解析缓存，边解析边推给界面，并把进度继续往前推（同一条进度条）。
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
    for (done, path) in linked_files.iter().enumerate() {
        // 进度每 25 个推一次（和扫描链同一节奏）；循环末尾补一次，保证不回退也不跳空
        if done % 25 == 0 {
            sink.progress(scan_files + done, grand_total);
        }
        let p = std::path::Path::new(path);
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
                // 目录里有授权文档且能归属到单字族 → 用目录结论；
                // 否则只看这个字面自己的 name 表（目录名不参与判定，见 copyright.rs）
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
            sink.batch(&linked_batch);
            linked_batch.clear();
        }
    }
    if !linked_batch.is_empty() {
        sink.batch(&linked_batch);
    }
    // 收口：进度必须落到 100%，否则前端会停在最后一个 25 的倍数上（看起来像卡住）
    sink.progress(grand_total, grand_total);
    eprintln!(
        "[scan] 链接字体 {} 个，耗时 {:?}",
        linked_total,
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

    // 运行时判过「预览不出来」的字面：结构扫描看不出这一点，这里把标记补回去。
    // 已有的更严重原因（文件损坏等）不覆盖。
    if !unpreviewable.is_empty() {
        for f in faces.iter_mut() {
            if f.incomplete.is_none() && unpreviewable.contains(&f.id) {
                f.incomplete = Some(crate::parser::UNPREVIEWABLE_REASON.to_string());
            }
        }
    }

    diag::index_library(&faces);
    let t_probe = std::time::Instant::now();
    // 并行探测的结果在这里收口；线程意外挂了就退回去自己再探一次
    let probe = probe_handle.join().unwrap_or_else(|_| activation::probe());
    eprintln!("[scan] 等注册表探测 {:?}", t_probe.elapsed());

    // 字库里**已经存在**但损坏 / 不完整的字体：顺手挪进「非完整字体」目录。
    // 导入流程自己会归档，这里兜住「以前就在库里」的那些（用户 2026-10-30 的要求）。
    let moved = installer::relocate_incomplete(&managed, &faces);
    if !moved.is_empty() {
        let old_to_new: std::collections::HashMap<String, String> = moved.into_iter().collect();
        // 路径变了，内存里的字面得按新位置重新解析，否则这一屏全是打不开的字
        let mut fresh: Vec<FontFace> = Vec::new();
        for new in old_to_new.values() {
            for mut f in parser::parse_font_file(std::path::Path::new(new), FontSource::Managed) {
                let (cls, note) = crate::copyright::inspect_face(
                    f.license.as_deref(),
                    f.license_url.as_deref(),
                    f.copyright.as_deref(),
                );
                f.copyright_class = Some(cls.as_str().to_string());
                f.license_note = note;
                fresh.push(f);
            }
        }
        faces.retain(|f| !old_to_new.contains_key(&f.path));
        faces.extend(fresh);
        // 链接记录 / 入库时间跟着换到新路径，不然后台会认为这些字体没了
        if let Ok(mut state) = store.0.lock() {
            for (old, new) in &old_to_new {
                state.linked.remove(old);
                state.linked.insert(new.clone());
                if let Some(t) = state.added.remove(old) {
                    state.added.insert(new.clone(), t);
                }
            }
            let _ = store::save(&state);
        }
        eprintln!("[scan] 已归集 {} 个损坏字体到「非完整字体」", old_to_new.len());
    }

    let mut state = store.0.lock().map_err(|e| e.to_string())?;
    let before = state.linked.len();
    state.linked.retain(|p| std::path::Path::new(p).is_file());
    // `added` 同样要收：删除字体不会清它（uninstall_quiet 只管文件），
    // 长期下来「已删除路径」越攒越多（2026-11-01 实测 5603 条 vs 库里 4211 族）。
    // 它只用来给「最近导入」排序，文件不在了留着没意义。
    let before_added = state.added.len();
    state.added.retain(|p, _| std::path::Path::new(p).is_file());
    if state.linked.len() != before || state.added.len() != before_added {
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
    Ok(faces)}
