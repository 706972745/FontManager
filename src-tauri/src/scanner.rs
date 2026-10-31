use crate::font_types::{FontFace, FontSource};
use crate::parser;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Emitter;
use walkdir::WalkDir;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub done: usize,
    pub total: usize,
}

pub fn managed_font_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("fonts")
            .join("ZFontManager")
    }
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Library/Fonts")
    }
    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Microsoft\\Windows\\Fonts")
    }
}

pub fn effective_managed_dir(library_dir: Option<&str>) -> PathBuf {
    match library_dir.map(str::trim).filter(|s| !s.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => managed_font_dir(),
    }
}

fn font_dirs() -> Vec<(PathBuf, FontSource)> {
    let mut dirs_list: Vec<(PathBuf, FontSource)> = Vec::new();
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));

    #[cfg(target_os = "linux")]
    {
        dirs_list.push((PathBuf::from("/usr/share/fonts"), FontSource::System));
        dirs_list.push((PathBuf::from("/usr/local/share/fonts"), FontSource::System));
        dirs_list.push((home.join(".local/share/fonts"), FontSource::User));
        dirs_list.push((home.join(".fonts"), FontSource::User));
    }
    #[cfg(target_os = "macos")]
    {
        dirs_list.push((PathBuf::from("/System/Library/Fonts"), FontSource::System));
        dirs_list.push((PathBuf::from("/Library/Fonts"), FontSource::System));
        dirs_list.push((home.join("Library/Fonts"), FontSource::User));
    }
    #[cfg(target_os = "windows")]
    {
        dirs_list.push((PathBuf::from("C:\\Windows\\Fonts"), FontSource::System));
        if let Some(local) = dirs::data_local_dir() {
            dirs_list.push((local.join("Microsoft\\Windows\\Fonts"), FontSource::User));
        }
        let _ = home;
    }

    dirs_list
}

fn classify(path: &std::path::Path, base_source: FontSource, managed: &Path) -> FontSource {
    if base_source == FontSource::User && path.starts_with(managed) {
        FontSource::Managed
    } else {
        base_source
    }
}

/// 字库目录里「直接放进去、没走导入流程」的字体文件。
///
/// 用户会手动往字库文件夹丢字体，点刷新就该看见——但扫描链只认系统目录、额外目录和
/// `state.linked` 里记录过的路径，手动放进去的既不在 linked 也没人遍历，所以刷不出来。
/// 返回的是还没登记过的绝对路径（大小写不敏感比较，避免 Windows 下重复收编）。
pub fn discover_managed(dir: &std::path::Path, known: &std::collections::HashSet<String>) -> Vec<String> {
    if !dir.is_dir() {
        return Vec::new();
    }
    let known_lower: std::collections::HashSet<String> =
        known.iter().map(|s| s.to_lowercase()).collect();
    let mut out: Vec<String> = Vec::new();
    for e in WalkDir::new(dir)
        .follow_links(true)
        .into_iter()
        // 归置过的重复字体不再收编回来，否则用户挪了等于没挪
        .filter_entry(|e| !in_dup_dir(e))
        .filter_map(|e| e.ok())
    {
        if !e.file_type().is_file() {
            continue;
        }
        let p = e.into_path();
        if !parser::is_font_file(&p) {
            continue;
        }
        // woff/woff2 在扫描阶段本来就被挡掉（Windows 加载不了），别收编进来变死面
        let ext = p
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if matches!(ext.as_str(), "woff" | "woff2") {
            continue;
        }
        let key = p.to_string_lossy().to_string();
        if known_lower.contains(&key.to_lowercase()) {
            continue;
        }
        out.push(key);
    }
    out.sort();
    out
}

/// 库内「与系统字体重复」的文件归置到这个目录；扫描时整体跳过。
///
/// 用户 2026-10-31 定：既然系统已经装了这个字体，库里那份就是多余的 ——
/// 挪进这个目录留档（不删），软件不再扫描/展示它。名字以下划线开头，
/// 和字体库里 `_02_其他字体` 这类内部命名保持一致，排序时也会沉到下面。
pub const DUPLICATE_DIR: &str = "_重复字体";

/// `discover_managed` 用：路径里是否带着「重复字体」这一层
fn in_dup_dir(e: &walkdir::DirEntry) -> bool {
    e.file_name()
        .to_str()
        .map(|s| s.eq_ignore_ascii_case(DUPLICATE_DIR))
        .unwrap_or(false)
}

/// 系统已安装字体的 PostScript 名（小写），进程内只算一次。
///
/// 导入时要按它挡掉「系统已经有了、还要再往库里复制一份」的操作（用户 2026-10-31：
/// 「以后的系统字体还会不会自动再复制一份」）。扫一次系统目录约 1~2 秒，缓存住即可。
pub fn system_postscript_names() -> &'static std::collections::HashSet<String> {
    static CACHE: std::sync::OnceLock<std::collections::HashSet<String>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        let mut set = std::collections::HashSet::new();
        let Some(dir) = system_font_dir() else {
            return set;
        };
        for e in WalkDir::new(&dir)
            .follow_links(true)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if !e.file_type().is_file() {
                continue;
            }
            let p = e.into_path();
            if !parser::is_font_file(&p) {
                continue;
            }
            for f in parser::parse_font_file(&p, FontSource::System) {
                if let Some(ps) = f.postscript_name {
                    set.insert(ps.to_lowercase());
                }
            }
        }
        set
    })
}

/// 归置记录里的一条：从哪来、到哪去
#[derive(Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DedupeItem {
    pub from: String,
    pub to: String,
}

/// `_重复字体/_归置记录.json`：每次归置都往里追加，支持「一键还原」。
///
/// 归置本身是移动、不删文件，但没有清单的话用户只能自己去目录里翻。
/// 有了它，误归置（比如两个字体真的同名但不是同一份）也能原路退回。
#[derive(Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DedupeLog {
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub items: Vec<DedupeItem>,
}

fn one() -> u32 {
    1
}

pub fn dedupe_log_path(library: &Path) -> PathBuf {
    library.join(DUPLICATE_DIR).join("_归置记录.json")
}

/// 读已有清单；坏文件当成空（不能因为一条记录读不出来就拒绝归置）
pub fn read_dedupe_log(library: &Path) -> DedupeLog {
    std::fs::read_to_string(dedupe_log_path(library))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 把归置过的字体全部搬回原位；原位已被占用就跳过（不覆盖任何东西）。
pub fn restore_deduped(library: &Path) -> DedupeReport {
    let log = read_dedupe_log(library);
    let mut report = DedupeReport {
        moved: 0,
        failed: 0,
        bytes: 0,
        dest: library.to_string_lossy().to_string(),
        dry_run: false,
        samples: Vec::new(),
        skipped_different: 0,
        skipped_partial: 0,
    };
    let mut remain: Vec<DedupeItem> = Vec::new();
    for item in log.items {
        let from = PathBuf::from(&item.from);
        let to = PathBuf::from(&item.to);
        if !to.is_file() {
            continue; // 文件已经不在了，记录也就没意义
        }
        if from.exists() {
            remain.push(item); // 原位被占，保留记录让用户自己决定
            report.failed += 1;
            continue;
        }
        if let Some(parent) = from.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let ok = std::fs::rename(&to, &from).is_ok()
            || (std::fs::copy(&to, &from).is_ok() && std::fs::remove_file(&to).is_ok());
        if ok {
            report.moved += 1;
        } else {
            remain.push(item);
            report.failed += 1;
        }
    }
    let left = DedupeLog {
        version: 1,
        items: remain,
    };
    if let Ok(s) = serde_json::to_string_pretty(&left) {
        let _ = std::fs::write(dedupe_log_path(library), s);
    }
    report
}

/// 一次「归置重复字体」的结果
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeReport {
    /// 计划 / 实际移动的文件数
    pub moved: usize,
    pub failed: usize,
    pub bytes: u64,
    /// 归置目标目录（绝对路径）
    pub dest: String,
    /// true = 只是试算，没有真的动文件
    pub dry_run: bool,
    /// 前几个被归置的文件名（提示里给用户看一眼）
    pub samples: Vec<String>,
    /// 名字对上了，但**内容和系统那份不一样**（多半是另一个版本）→ 保留不动，由用户自己决定
    #[serde(default)]
    pub skipped_different: usize,
    /// **整个文件都能被系统替代**这个条件不成立 → 保留不动。
    /// 两种来源：文件里夹着系统没有的字族（TTC），或 PS 名对不上 ——
    /// 后者最常见的其实是「文件名撞车，其实是完全不同的两个字体」（实测 arialn.ttf
    /// 在系统里是 ArialNarrow、库里那份是 LiHeiPro）。
    #[serde(default)]
    pub skipped_partial: usize,
}

/// 系统字体目录（只有 Windows 有「系统已经装了一份」这个概念）
fn system_font_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let d = PathBuf::from(r"C:\Windows\Fonts");
        if d.is_dir() {
            return Some(d);
        }
    }
    None
}

/// 两个文件是否**逐字节相同**（先比长度，再分块比对，不整份读进内存）。
///
/// 归置前必须过这一关：PostScript 名只说明「同一个字体谱系」，不说明「同一份文件」——
/// 系统里是 v7、库里是 v5，名字一模一样但笔画细节不同，替用户挪走就是毁资料。
fn same_bytes(a: &Path, b: &Path) -> bool {
    use std::io::Read;
    let (Ok(ma), Ok(mb)) = (std::fs::metadata(a), std::fs::metadata(b)) else {
        return false;
    };
    if ma.len() != mb.len() {
        return false;
    }
    let (Ok(mut fa), Ok(mut fb)) = (std::fs::File::open(a), std::fs::File::open(b)) else {
        return false;
    };
    let mut ba = vec![0u8; 64 * 1024];
    let mut bb = vec![0u8; 64 * 1024];
    loop {
        let na = match fa.read(&mut ba) {
            Ok(n) => n,
            Err(_) => return false,
        };
        let nb = match fb.read(&mut bb) {
            Ok(n) => n,
            Err(_) => return false,
        };
        if na != nb {
            return false;
        }
        if na == 0 {
            return true;
        }
        if ba[..na] != bb[..nb] {
            return false;
        }
    }
}

/// 把字体库里「与系统已安装字体重复」的文件挪进 `<库>/_重复字体/`。
///
/// 判重比的是 **PostScript 名**（系统里叫 arial.ttf、库里可能被改成别的文件名），
/// 但全量解析 6000 个文件太慢。所以先用**文件名**筛候选（库里的重复大多是原样拷过来的，
/// 文件名和系统一致），只解析这些候选 —— 实测候选三百来个，两三秒能跑完。
///
/// `dry_run = true` 只统计不移动，先给用户一个「这次会动多少个文件」的预览。
/// 移动时保留相对目录结构，方便日后原样找回（不删任何文件）。
///
/// **判重口径（0.9.9-13 收紧）**：光「PostScript 名撞上」不算重复，必须同时满足
/// ① 文件里每个字面都能在系统找到同名字面；② 缺 PostScript 名的不碰；
/// ③ 与系统那份**逐字节相同**。见循环里的注释与 `same_bytes`。
pub fn dedupe_library(library: &Path, dry_run: bool) -> DedupeReport {
    let mut report = DedupeReport {
        moved: 0,
        failed: 0,
        bytes: 0,
        dest: library.join(DUPLICATE_DIR).to_string_lossy().to_string(),
        dry_run,
        samples: Vec::new(),
        skipped_different: 0,
        skipped_partial: 0,
    };
    let Some(sys_dir) = system_font_dir() else {
        return report;
    };
    if !library.is_dir() {
        return report;
    }

    // 1) 系统侧：PostScript 名 + 文件名 + 名→系统文件路径，三份索引都留着
    //    （路径那份用于「内容是否真的逐字节相同」的复核，见第 2 步）
    let mut sys_ps: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut sys_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut sys_by_ps: std::collections::HashMap<String, Vec<PathBuf>> =
        std::collections::HashMap::new();
    for e in WalkDir::new(&sys_dir)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !e.file_type().is_file() {
            continue;
        }
        let p = e.into_path();
        if !parser::is_font_file(&p) {
            continue;
        }
        if let Some(n) = p.file_name().and_then(|s| s.to_str()) {
            sys_names.insert(n.to_lowercase());
        }
        for f in parser::parse_font_file(&p, FontSource::System) {
            if let Some(ps) = f.postscript_name {
                let k = ps.to_lowercase();
                sys_ps.insert(k.clone());
                sys_by_ps.entry(k).or_default().push(p.clone());
            }
        }
    }
    if sys_ps.is_empty() {
        return report;
    }
    // 库目录万一是指向系统目录的链接，挪动它就等于挪系统字体 —— 这种一律不动
    let sys_root = sys_dir.canonicalize().unwrap_or_else(|_| sys_dir.clone());

    // 2) 库内候选：文件名与系统重合的才解析确认，避免全库重解析
    let dest_root = library.join(DUPLICATE_DIR);
    let mut todo: Vec<(PathBuf, u64)> = Vec::new();
    let mut skipped_different = 0usize;
    let mut skipped_partial = 0usize;
    for e in WalkDir::new(library)
        .follow_links(true)
        .into_iter()
        .filter_entry(|e| !in_dup_dir(e))
        .filter_map(|e| e.ok())
    {
        if !e.file_type().is_file() {
            continue;
        }
        let p = e.into_path();
        if !parser::is_font_file(&p) {
            continue;
        }
        let same_name = p
            .file_name()
            .and_then(|s| s.to_str())
            .map(|n| sys_names.contains(&n.to_lowercase()))
            .unwrap_or(false);
        if !same_name {
            continue;
        }
        // 文件本身就在系统目录里（库目录是指向 C:\Windows\Fonts 的链接）→ 绝不动
        let canon = p.canonicalize().unwrap_or_else(|_| p.clone());
        if canon.starts_with(&sys_root) {
            skipped_partial += 1;
            continue;
        }
        // 严格三条（0.9.9-13，用户问「怎么防止归置错误」）：
        // ① 文件里**每一个**字面都要能在系统里找到同 PostScript 名的字体
        //    —— 原来只要命中任意一个就整份搬走，TTC 里夹着的别的字族会被连坐搬走；
        // ② 缺 PostScript 名的一律不碰（没法确认它是谁）；
        // ③ 内容必须与系统那份**逐字节相同** —— 只是同名不同版本（旧版 / 子集 / 重导出）
        //    的留在库里，不替用户决定「哪个版本更好」。
        let faces = parser::parse_font_file(&p, FontSource::User);
        if faces.is_empty() {
            skipped_partial += 1;
            continue;
        }
        let mut keys: Vec<String> = Vec::with_capacity(faces.len());
        let mut all_known = true;
        for f in &faces {
            match f.postscript_name.as_ref().map(|s| s.to_lowercase()) {
                Some(k) if sys_ps.contains(&k) => keys.push(k),
                _ => {
                    all_known = false;
                    break;
                }
            }
        }
        if !all_known {
            skipped_partial += 1;
            continue;
        }
        // 只要有一个字面能对上「内容完全一样的系统文件」就够：整份文件逐字节相同，
        // 意味着这个文件里的所有字面系统都装了一份一模一样的。
        let identical = keys.iter().any(|k| {
            sys_by_ps
                .get(k)
                .map(|paths| paths.iter().any(|sp| same_bytes(&p, sp)))
                .unwrap_or(false)
        });
        if !identical {
            skipped_different += 1;
            continue;
        }
        let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        todo.push((p, size));
    }
    // 上面两个计数器：分别代表「版本不同已保留」「整包不完全重复已保留」
    report.skipped_different = skipped_different;
    report.skipped_partial = skipped_partial;

    report.moved = todo.len();
    report.bytes = todo.iter().map(|(_, s)| s).sum();
    for (p, _) in todo.iter().take(5) {
        if let Some(n) = p.file_name().and_then(|s| s.to_str()) {
            report.samples.push(n.to_string());
        }
    }
    if dry_run {
        return report;
    }

    // 3) 真移动：保留相对目录结构，跨盘时退化成「复制 + 删除」。
    //    每成功一个就记进清单，事后能原路还原。
    let mut moved_ok = 0usize;
    let mut failed = 0usize;
    let mut items: Vec<DedupeItem> = Vec::new();
    for (p, _) in todo {
        let rel = p.strip_prefix(library).unwrap_or(&p).to_path_buf();
        let target = dest_root.join(rel);
        if let Some(parent) = target.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                failed += 1;
                continue;
            }
        }
        let ok = std::fs::rename(&p, &target).is_ok()
            || (std::fs::copy(&p, &target).is_ok() && std::fs::remove_file(&p).is_ok());
        if ok {
            moved_ok += 1;
            items.push(DedupeItem {
                from: p.to_string_lossy().to_string(),
                to: target.to_string_lossy().to_string(),
            });
        } else {
            failed += 1;
        }
    }
    if !items.is_empty() {
        let mut log = read_dedupe_log(library);
        log.version = 1;
        log.items.extend(items);
        if let Ok(s) = serde_json::to_string_pretty(&log) {
            let _ = std::fs::write(dedupe_log_path(library), s);
        }
    }
    report.moved = moved_ok;
    report.failed = failed;
    report
}

pub fn all_dirs(extra: &[String]) -> Vec<(PathBuf, FontSource)> {
    let mut dirs_list = font_dirs();
    for d in extra {
        dirs_list.push((PathBuf::from(d), FontSource::User));
    }
    dirs_list
}

/// 每批推送多少个字面（face）给前端。
/// 太小会刷爆 IPC，太大又失去「边读边出现」的观感；120 个大约 30~60ms 一批。
const BATCH_FACES: usize = 120;

/// 扫描系统目录 + 额外目录。
///
/// `progress_offset`：这条链之后还有多少个文件要解析（链接进库的字体）。
/// 进度条是用户眼里的「一个」动作，所以两条链共用同一条进度：
/// 这里的 total 要把 offset 算进去，done 从 offset 起算。
/// 以前只报这一段的文件数，字库里几千个字体是在进度到 100% **之后**才解析的，
/// 而且一个进度事件都不发 —— 界面上就是一条永远停在 100% 的进度条（0.9.8-1 修）。
///
/// 返回值第二个是这一阶段实际的文件总数，调用方接着用它算总进度。
pub fn scan_all(
    app: &tauri::AppHandle,
    extra: &[String],
    managed: &Path,
    cache: &mut crate::fontcache::FontCache,
    progress_offset: usize,
) -> (Vec<FontFace>, usize) {
    let all_files: Vec<(PathBuf, FontSource)> = all_dirs(extra)
        .into_iter()
        .flat_map(|(dir, source)| {
            WalkDir::new(dir)
                .follow_links(true)
                .into_iter()
                .filter_entry(|e| !in_dup_dir(e))
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
                .map(move |e| (e.into_path(), source))
                .filter(|(p, _)| parser::is_font_file(p))
                .collect::<Vec<_>>()
        })
        .collect();

    // WOFF/WOFF2 快速判重（纯路径判断，零读取开销）：同目录同名的 ttf/otf 已在列，
    // 而 Windows 加载不了 woff——不为它建 face，省得出现「永远无法启用」的死面。
    // 内容级判重与解包在导入层做（见 webfonts 模块注释），这里只挡扫描。
    let native_stems: std::collections::HashSet<(PathBuf, String)> = all_files
        .iter()
        .filter_map(|(p, _)| {
            let ext = p.extension()?.to_str()?.to_ascii_lowercase();
            if !matches!(ext.as_str(), "ttf" | "otf") {
                return None;
            }
            Some((
                p.parent()?.to_path_buf(),
                p.file_stem()?.to_str()?.to_lowercase(),
            ))
        })
        .collect();
    let files: Vec<(PathBuf, FontSource)> = all_files
        .into_iter()
        .filter(|(p, _)| {
            let ext = match p.extension().and_then(|e| e.to_str()) {
                Some(e) => e.to_ascii_lowercase(),
                None => return true,
            };
            if !matches!(ext.as_str(), "woff" | "woff2") {
                return true;
            }
            let is_twin = p
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| Some((p.parent()?.to_path_buf(), s.to_lowercase())))
                .is_some_and(|k| native_stems.contains(&k));
            !is_twin
        })
        .collect();

    let files_len = files.len();
    let total = files_len + progress_offset;
    let mut faces = Vec::with_capacity(files_len);
    // 字体库里按目录缓存版权判定：目录名 / 同目录的版权信息文件写明的版权，
    // 一个目录只判一次（要读文件，但比解析字体便宜得多）
    // 目录 → (版权分类, 备注留痕)：同一个目录只读一次授权文件，
    // 分类和「判定依据」一起带出来（详情面板的备注要能追溯是哪段原文下的结论）
    let mut dir_info: std::collections::HashMap<PathBuf, crate::copyright::DirCopyright> =
        std::collections::HashMap::new();
    // 解析结果缓存由调用方持有：链接字体那一段也用同一个实例，最后统一落盘
    // 边扫边推：已解析好的字体分批发给前端，界面就能「读到多少显示多少」，
    // 而不是等全部扫完（几千个字体时要好几秒）才一次性出现。
    let mut batch: Vec<FontFace> = Vec::with_capacity(BATCH_FACES);
    // 先把 0% 报出去：界面立刻能显示进度条，而不是空等第一帧解析完
    let _ = app.emit(
        "scan:progress",
        ScanProgress {
            done: progress_offset,
            total,
        },
    );
    for (done, (path, base_source)) in files.into_iter().enumerate() {
        let source = classify(&path, base_source, managed);
        let key = path.to_string_lossy().to_string();
        // 修改时间 + 大小作为「这个文件有没有变过」的判据，比读一遍文件便宜得多
        let meta = std::fs::metadata(&path).ok();
        let mtime = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let mut parsed = match cache.get(&key, mtime, size, source) {
            Some(hit) => hit,
            None => {
                let fresh = parser::parse_font_file(&path, source);
                cache.put(&key, mtime, size, source, &fresh);
                fresh
            }
        };
        if source == FontSource::Managed {
            if let Some(dir) = path.parent() {
                let found = dir_info
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
        }
        batch.extend(parsed.iter().cloned());
        faces.extend(parsed);
        // 攒够一批就发出去（最后一批在循环结束后补发）
        if batch.len() >= BATCH_FACES {
            let _ = app.emit("scan:batch", &batch);
            batch.clear();
        }
        if done % 25 == 0 || done + 1 == files_len {
            let _ = app.emit(
                "scan:progress",
                ScanProgress {
                    done: progress_offset + done + 1,
                    total,
                },
            );
        }
    }
    if !batch.is_empty() {
        let _ = app.emit("scan:batch", &batch);
    }

    faces.sort_by(|a, b| a.id.cmp(&b.id));
    faces.dedup_by(|a, b| a.id == b.id);
    (faces, files_len)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_fonts_not_yet_registered() {
        let dir = std::env::temp_dir().join("zfm-discover-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("A.ttf"), b"x").unwrap();
        std::fs::write(dir.join("B.otf"), b"x").unwrap();
        // woff2 / 说明文件不该被收编
        std::fs::write(dir.join("C.woff2"), b"x").unwrap();
        std::fs::write(dir.join("note.txt"), b"x").unwrap();

        let known = std::collections::HashSet::new();
        let got = discover_managed(&dir, &known);
        assert_eq!(got.len(), 2, "{got:?}");

        // 已经登记过的不会再返回（刷新按钮重复点也不会重复收编）
        let known: std::collections::HashSet<String> = got.iter().cloned().collect();
        assert!(discover_managed(&dir, &known).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
