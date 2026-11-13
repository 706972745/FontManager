//! 扫描字体库（业务层版本）。
//!
//! 从 `lib.rs::scan_fonts` 原样搬过来，只把三处 Tauri 依赖换成回调：
//! `app.state::<Store>()` → 传入的 [`Store`]；`app.emit("scan:*")` → [`ScanSink`]。
//! 命令层（WebView）与本地 HTTP API 共用这一份实现 —— 扫描逻辑只有一套。

use crate::font_types::{FontFace, FontSource};
use crate::store::{self, Store};
use crate::{activation, copyright, diag, installer, parser, scanner};
use std::collections::HashSet;

/// 进度接收方。界面实现成 `app.emit("scan:progress")`，
/// HTTP 侧实现成写 job 表，谁都不会漏。
pub trait ScanSink {
    fn progress(&self, done: usize, total: usize);
    fn batch(&self, faces: &[FontFace]);
    /// 首帧种子集合（2.1.4）：只含「上次已启用 + 系统字体 + 分组内 + 快照内」那几百个字面。
    ///
    /// 默认空实现：HTTP 侧的 `NullSink` 不需要这个概念（它靠 job 表轮询拿全量结果）。
    /// **"每进程只发一次"的守卫由实现方负责**（`lib.rs::UiSink` 里的 `UI_SEED_SENT`），
    /// 不能放在 `scan_library` 里 —— HTTP 侧先扫一次就会把这一次「吃掉」，
    /// 界面从此永远收不到种子（ADR-05 记录的那个真 bug）。
    fn seed(&self, _faces: &[FontFace]) {}
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

/// 种子筛选的全部输入（路径均已按 [`activation::norm_path`] 归一化）。
///
/// 抽成纯数据结构是为了能脱离 `Store` / 注册表 / 磁盘单测：种子逻辑一旦掺进 I/O，
/// 就只能靠真机跑一次看首帧对不对，回归成本极高。
pub struct SeedInput {
    /// 上次已启用 = 台账 ∪ 注册表里的非系统路径。
    /// 取并集是为了兼容升级上来的老用户：他们第一次跑 2.1.4 时台账还是空的（D11），
    /// 只有注册表能说出「上次启用了什么」。
    pub activated: HashSet<String>,
    /// 用户明确停用过的路径。R-16：它压过台账 —— Windows 上 `is_active` 完全不看
    /// `deactivated`，所以这道判断必须自己做，否则「用户停用的字体」会被种子拉回来。
    pub deactivated: HashSet<String>,
    /// 分组里的族名（小写）
    pub collection_families: HashSet<String>,
    /// 分组里的字重级成员（`face_key`，与前端同口径）
    pub collection_face_keys: HashSet<String>,
    /// 快照新格式的 key（`face_key`）
    pub snapshot_keys: HashSet<String>,
    /// 快照旧格式的绝对路径（归一化；旧数据的 `key` 是空串，见 `store::de_snapshots`）
    pub snapshot_paths: HashSet<String>,
}

/// 这个字面该不该进种子：命中任意一条即命中。纯函数，不碰磁盘也不碰注册表。
pub fn is_seed_face(face: &FontFace, inp: &SeedInput) -> bool {
    let norm = activation::norm_path(&face.path);
    // ① 系统字体：让「系统字体」分类与套用立即可用（PRD §3.1 第 2 行）。
    //    放在 deactivated 之前：系统字体本来就改不动，它永远该在首帧里。
    if face.source == FontSource::System || activation::is_system_font(&face.path) {
        return true;
    }
    // ② 用户明确停用过的一律不进（R-16「以 deactivated 为准」）
    if inp.deactivated.contains(&norm) {
        return false;
    }
    // ③ 上次启用 = 台账 ∪ 注册表
    if inp.activated.contains(&norm) {
        return true;
    }
    // ④ 分组：整族成员按族名，字重级成员按 faceKey
    if inp.collection_families.contains(&face.family.to_lowercase()) {
        return true;
    }
    let key = crate::services::fonts::face_key(face);
    if inp.collection_face_keys.contains(&key) {
        return true;
    }
    // ⑤ 快照：新格式按 key，旧格式按 path
    if inp.snapshot_keys.contains(&key) {
        return true;
    }
    inp.snapshot_paths.contains(&norm)
}

/// 从解析缓存里挑出种子字面。**不解析任何字体文件**（ADR-02）。
///
/// 缓存里没有的路径直接丢弃，交给紧接着的全量扫描补上：现场解析几十个文件最坏能把
/// 1.5s 的首帧预算吃光，还会和全量扫描重复解析同一批文件（缓存 get 又被打成 miss），
/// 「伪快速启动」比慢启动更难排查。
fn build_seed(cache: &crate::fontcache::FontCache, probe: &activation::Probe, state: &store::AppState) -> Vec<FontFace> {
    let inp = seed_input(probe, state);
    // 去重键用 (归一化路径, face_index)：
    //   · 同一路径可能在多个来源里命中（台账 + 分组 + 快照），必须只出一份；
    //   · 一个 ttc 里有多个字面（face_index 不同），不能按路径去重；
    //   · 不能用 `face.id`：缓存里的 id 是上一次扫描时拼的，历史上出现过路径大小写不一致
    //     导致同一字体两个 id 的情况，按归一化路径更稳。
    let mut seen: HashSet<(String, u32)> = HashSet::new();
    let mut out: Vec<FontFace> = Vec::new();
    let mut gone = 0usize;
    for face in cache.faces() {
        if !is_seed_face(face, &inp) {
            continue;
        }
        let norm = activation::norm_path(&face.path);
        if !seen.insert((norm.clone(), face.face_index)) {
            continue;
        }
        // 预检：种子只有几百个文件，一次 stat 不到 20ms。不预检的反例 ——
        // 「字体被删了但还没触发任何扫描就重启」时，首帧会出现一张永远打不开的卡片
        // （用户在首帧就点了它，全量扫描又要十几秒才把它拿走）。
        if !std::path::Path::new(&face.path).is_file() {
            gone += 1;
            continue;
        }
        let mut f = face.clone();
        // 缓存里的 active / added_at 是上次扫描的旧值，必须用本轮 probe 重算，
        // 否则首帧的「已启用」是错的（AC-12/AC-14）。
        f.active = !inp.deactivated.contains(&norm) && activation::is_active(probe, state, &f);
        f.added_at = state.added.get(&f.path).copied().or_else(|| file_time(&f.path, true));
        if state.unpreviewable.contains(&f.id) && f.incomplete.is_none() {
            f.incomplete = Some(crate::parser::UNPREVIEWABLE_REASON.to_string());
        }
        out.push(f);
    }
    if gone > 0 {
        diag::log(&format!(
            "[seed] {gone} 个种子路径已不存在（文件被删但还没扫描过），已剔除"
        ));
    }
    out
}

/// 把 `Probe` + `AppState` 摊平成种子筛选需要的六份集合。
fn seed_input(probe: &activation::Probe, state: &store::AppState) -> SeedInput {
    let mut activated: HashSet<String> = state
        .activated
        .iter()
        .map(|p| activation::norm_path(p))
        .collect();
    // 注册表并集（D11）。系统目录里的路径不进 `activated` —— 系统字体本来单独入种子，
    // 塞进来只会让集合白白变大，还会让「台账里没有系统字体」这条不变量在调试时看着像坏了。
    for p in probe.registered_paths() {
        if !activation::is_system_font(p) {
            activated.insert(activation::norm_path(p));
        }
    }
    let mut collection_families: HashSet<String> = HashSet::new();
    for (name, members) in &state.collections {
        collection_families.insert(name.to_lowercase());
        for m in members {
            collection_families.insert(m.to_lowercase());
        }
    }
    // `prefs.collectionFaces`：形状 `{分组名: [faceKey…]}`。字段可能不存在（新装用户）
    // 或类型被污染（老版本 / 手工改过 prefs.json）→ 一路 downcast 失败就当空集合，绝不 panic：
    // 种子少几个字体的代价远小于启动崩掉。
    let collection_face_keys = state
        .prefs
        .get("collectionFaces")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.values()
                .filter_map(|v| v.as_array())
                .flatten()
                .filter_map(|v| v.as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let mut snapshot_keys: HashSet<String> = HashSet::new();
    let mut snapshot_paths: HashSet<String> = HashSet::new();
    for snap in &state.snapshots {
        for e in &snap.entries {
            if !e.key.is_empty() {
                snapshot_keys.insert(e.key.clone());
            } else if let Some(p) = &e.path {
                snapshot_paths.insert(activation::norm_path(p));
            }
            // key 与 path 都空 → 这条目匹配不到任何字体，跳过（历史脏数据，不报错）
        }
    }
    SeedInput {
        activated,
        deactivated: state
            .deactivated
            .iter()
            .map(|p| activation::norm_path(p))
            .collect(),
        collection_families,
        collection_face_keys,
        snapshot_keys,
        snapshot_paths,
    }
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
    // 注册表探测从「跟扫描并行」改成「先跑完」（ADR-04，2.1.4）：
    // 种子必须在推给界面**之前**就知道每个字面的真实 active，否则首帧的「已启用」是错的
    // （AC-12/AC-14 直接挂）。原先和扫描重叠能省几十毫秒，省下来的是「错数据」。
    // 同一个 Probe 后面还要给扫描收尾回填 active 复用，不重复枚举注册表。
    let t_seed = std::time::Instant::now();
    let mut cache = crate::fontcache::FontCache::load();
    let probe = activation::probe();
    eprintln!("[scan] probe 耗时 {:?}", t_seed.elapsed());
    {
        let state = store.0.lock().map_err(|e| e.to_string())?;
        let seed = build_seed(&cache, &probe, &state);
        crate::diag::log(&format!(
            "[seed] 缓存 {} 个字面 → 种子 {} 个，耗时 {:?}，台账 {} 条",
            cache.face_count(),
            seed.len(),
            t_seed.elapsed(),
            state.activated.len()
        ));
        if seed.is_empty() {
            // 空种子不浪费一次 IPC（前端会一直等骨架屏，靠全量结果兜底，D-1/D-2）
            crate::diag::log("[seed] 种子为空（缓存缺失 / 无台账无分组），回退骨架屏流程");
        } else {
            // 每次都调：发不发由 sink 自己的一次性守卫决定（ADR-05）
            sink.seed(&seed);
        }
    }
    let t_scan = std::time::Instant::now();
    // 缓存跟着扫描一起在后台线程里更新并带回来：链接字体那一段要继续用它
    let (mut faces, scan_files) = {
        let managed = managed.clone();
        scanner::scan_all(
            &extra,
            &managed,
            &mut cache,
            linked_total,
            &|done, total| sink.progress(done, total),
            // 批次里的 active 仍是「解析那一刻」的旧值（不带 probe）。刻意**不改**
            // `scan_all` 的签名去传 probe：界面侧的批次推送已经整个停用（ADR-06），
            // HTTP 侧只把批次当「又读完几个」的进度用，没有任何一处消费它的 active。
            // 为了一段没人读的字段改一圈函数签名，只会让下次改扫描的人多绕一道。
            &|batch| sink.batch(batch),
        )
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
    // 注册表探测已经在开头同步跑完了（ADR-04），这里不再 join：
    // 同一个 probe 既给了种子，也用来给扫描结果回填 active，两边口径必然一致。

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
    // 台账同样要收（D10）：本轮扫到的路径集合就是「这台机器上还有什么」的权威答案。
    // 用它裁剪而不是逐条 `is_file`（见 `AppState::retain_activated` 的注释）。
    // 反例（不裁剪）：删掉的字体永远留在台账里，每次启动都白算一次种子。
    let alive: HashSet<String> = faces
        .iter()
        .map(|f| activation::norm_path(&f.path))
        .collect();
    let dropped = state.retain_activated(&alive);
    if dropped > 0 {
        crate::diag::log(&format!("[seed] 台账剔除 {dropped} 条已不在库里的路径"));
    }
    if state.linked.len() != before || state.added.len() != before_added || dropped > 0 {
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

#[cfg(test)]
mod seed_tests {
    //! 种子筛选矩阵（2.1.4 §9.1 U1–U11）。
    //!
    //! 全部是纯函数级用例：不读注册表、不解析字体，跑一遍不到 1ms。
    //! 种子一旦错，症状是「首帧少几个字体 / 多一个打不开的卡片」，很难从界面上看出
    //! 是哪一路条件算错的，所以四路并集必须逐条钉住。
    use super::*;
    use crate::font_types::{Classification, FontFace, FontFormat};

    fn face(path: &str, family: &str, ps: Option<&str>) -> FontFace {
        FontFace {
            id: format!("{path}#0"),
            path: path.to_string(),
            preview_path: None,
            face_index: 0,
            family: family.to_string(),
            style: "Regular".to_string(),
            postscript_name: ps.map(str::to_string),
            localized_names: vec![],
            foundry: None,
            license: None,
            license_url: None,
            copyright: None,
            copyright_class: None,
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
            glyph_count: 500,
            incomplete: None,
            name_fallback: false,
            file_size: 1024,
            source: FontSource::User,
            deactivatable: true,
            active: false,
            added_at: None,
        }
    }

    fn input() -> SeedInput {
        SeedInput {
            activated: HashSet::new(),
            deactivated: HashSet::new(),
            collection_families: HashSet::new(),
            collection_face_keys: HashSet::new(),
            snapshot_keys: HashSet::new(),
            snapshot_paths: HashSet::new(),
        }
    }

    fn set(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn set_owned(items: Vec<String>) -> HashSet<String> {
        items.into_iter().collect()
    }

    /// 临时文件：`build_seed` 会做 `is_file` 预检，假路径必须真的存在
    fn touch(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!("zfm-seed-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(format!("{tag}.ttf"));
        std::fs::write(&p, b"x").unwrap();
        p.to_string_lossy().into_owned()
    }

    /// U1：系统字体永远在种子里，即使被写进了 deactivated（它本来就改不动）
    #[test]
    fn system_font_is_always_seeded() {
        let f = face(r"C:/Windows/Fonts/arial.ttf", "Arial", Some("ArialMT"));
        let mut inp = input();
        inp.deactivated = set(&[r"C:/Windows/Fonts/arial.ttf"]);
        let mut sys = f.clone();
        sys.source = FontSource::System;
        assert!(is_seed_face(&sys, &inp));
        #[cfg(target_os = "windows")]
        {
            // 来源标错（User）但路径在系统目录：同样要挡住 deactivated 的排除
            assert!(is_seed_face(&f, &inp));
        }
    }

    /// U2：台账命中就进种子
    #[test]
    fn ledger_hit_is_seeded() {
        let f = face(r"E:\Fonts\mine.ttf", "Mine", None);
        let mut inp = input();
        inp.activated = set_owned(vec![activation::norm_path(r"e:\fonts\MINE.ttf")]);
        assert!(is_seed_face(&f, &inp), "大小写 / 斜杠差异不该影响命中");
    }

    /// U3：R-16 —— deactivated 压过台账
    #[test]
    fn deactivated_beats_ledger() {
        let f = face(r"E:\Fonts\off.ttf", "Off", None);
        let mut inp = input();
        let norm = activation::norm_path(&f.path);
        inp.activated = set_owned(vec![norm.clone()]);
        inp.deactivated = set_owned(vec![norm]);
        assert!(!is_seed_face(&f, &inp));
    }

    /// U4：族名按小写比（分组里存的是用户看到的写法）
    #[test]
    fn collection_family_matches_case_insensitively() {
        let f = face(r"E:\Fonts\x.ttf", "Source Han Sans", None);
        let mut inp = input();
        inp.collection_families = set(&["source han sans"]);
        assert!(is_seed_face(&f, &inp));
    }

    /// U5：分组里的字重级成员（faceKey）—— 有 PostScript 名与没有名各一例
    #[test]
    fn collection_face_key_matches() {
        let with_ps = face(r"E:\Fonts\a.ttf", "Alpha", Some("Alpha-Bold"));
        let without = face(r"E:\Fonts\b.ttf", "Beta", None);
        let mut inp = input();
        inp.collection_face_keys = set_owned(vec![
            crate::services::fonts::face_key(&with_ps),
            crate::services::fonts::face_key(&without),
        ]);
        assert!(is_seed_face(&with_ps, &inp));
        assert!(is_seed_face(&without, &inp));
    }

    /// U6：快照新格式按 key
    #[test]
    fn snapshot_key_matches() {
        let f = face(r"E:\Fonts\s.ttf", "Snap", Some("Snap-Regular"));
        let mut inp = input();
        inp.snapshot_keys = set_owned(vec![crate::services::fonts::face_key(&f)]);
        assert!(is_seed_face(&f, &inp));
    }

    /// U7：快照旧格式（`key` 为空、只存了绝对路径）—— 路径大小写 / 斜杠不同也要命中。
    /// 反例（不兜 path）：升级上来的快照在首帧全部消失，要等全量读完才回来。
    #[test]
    fn snapshot_legacy_path_matches() {
        let f = face(r"E:\Fonts\Legacy.ttf", "Legacy", None);
        let mut inp = input();
        inp.snapshot_paths = set_owned(vec![activation::norm_path("e:/fonts/LEGACY.TTF")]);
        assert!(is_seed_face(&f, &inp));
    }

    /// U8：快照条目 key 与 path 都空（历史脏数据）→ 谁都不匹配，也不能 panic
    #[test]
    fn snapshot_entry_without_key_or_path_matches_nothing() {
        let f = face(r"E:\Fonts\n.ttf", "Nothing", None);
        let inp = input();
        assert!(!is_seed_face(&f, &inp));
    }

    /// 归一化本身：`\\?\` 前缀必须去掉，否则复制/链接进来的字体永远匹配不上
    #[test]
    fn norm_path_strips_long_prefix_and_slashes() {
        assert_eq!(activation::norm_path(r"\\?\E:\Fonts\A.TTF"), r"e:\fonts\a.ttf");
        assert_eq!(activation::norm_path("E:/Fonts/A.TTF"), r"e:\fonts\a.ttf");
    }

    /// U9 + U10：同一个路径被三路同时命中只出一份；ttc 的多个 face_index 不能被压掉
    #[test]
    fn build_seed_dedupes_by_path_and_face_index() {
        let single = touch("dedupe");
        let ttc = touch("ttc");
        let mut f = face(&single, "Dedupe", Some("Dedupe-Regular"));
        f.active = true; // 缓存里的旧值：必须被重算，不能原样带出去
        let mut t0 = face(&ttc, "Ttc", Some("Ttc-Regular"));
        t0.face_index = 0;
        t0.id = format!("{ttc}#0");
        let mut t1 = t0.clone();
        t1.face_index = 1;
        t1.id = format!("{ttc}#1");

        let mut cache = crate::fontcache::FontCache::empty();
        cache.put(&single, 1, 1, FontSource::User, &[f.clone()]);
        cache.put(&ttc, 1, 1, FontSource::User, &[t0, t1]);

        let mut state = store::AppState::default();
        // 三路同时命中：台账 + 分组族名 + 快照 key（ttc 走台账那一路）
        state.activated.insert(single.clone());
        state.activated.insert(ttc.clone());
        state
            .collections
            .insert("组".to_string(), vec!["Dedupe".to_string()]);
        state.snapshots.push(store::Snapshot {
            name: "s".to_string(),
            created_at: 0,
            entries: vec![store::SnapshotEntry {
                key: crate::services::fonts::face_key(&f),
                path: None,
                family: "Dedupe".to_string(),
                style: "Regular".to_string(),
                system: false,
            }],
        });

        let probe = activation::probe();
        let seed = build_seed(&cache, &probe, &state);
        let ids: Vec<&str> = seed.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids.len(), 3, "同路径只出一份，ttc 的两个字面都要在：{ids:?}");
        assert_eq!(seed.iter().filter(|f| f.path == single).count(), 1);
        assert_eq!(seed.iter().filter(|f| f.path == ttc).count(), 2);
        // U11：缓存里写的是 active=true，但那台机器上并没有注册它 → 首帧必须显示停用
        #[cfg(target_os = "windows")]
        assert!(
            !seed.iter().any(|f| f.path == single && f.active),
            "缓存里的旧 active 值污染了首帧"
        );
    }

    /// 文件已被删除（缓存里还有条目）→ 种子直接丢掉，首帧不留打不开的卡片
    #[test]
    fn build_seed_skips_missing_files() {
        let gone = std::env::temp_dir()
            .join(format!("zfm-seed-{}-gone.ttf", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let _ = std::fs::remove_file(&gone);
        let mut cache = crate::fontcache::FontCache::empty();
        cache.put(&gone, 1, 1, FontSource::User, &[face(&gone, "Gone", None)]);
        let mut state = store::AppState::default();
        state.activated.insert(gone.clone());
        let seed = build_seed(&cache, &activation::probe(), &state);
        assert!(seed.is_empty(), "已删除的文件不该进首帧");
    }
}
