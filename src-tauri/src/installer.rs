use crate::copyright;
use crate::font_types::{FontFace, FontSource, TrashEntry};
use crate::parser;
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

/// 在线下载字体在库目录下的父文件夹名
pub const ONLINE_DIR_NAME: &str = "在线栏目";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub file: String,
    pub done: usize,
    pub total: usize,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub installed: Vec<FontFace>,
    pub errors: Vec<String>,
    pub duplicates: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallMode {
    Link,
    Move,
}

impl InstallMode {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "link" => Ok(Self::Link),
            "move" => Ok(Self::Move),
            _ => Err(format!("unknown install mode: {s}")),
        }
    }
}
pub fn dup_key(face: &FontFace) -> String {
    face.postscript_name
        .clone()
        .unwrap_or_else(|| format!("{} {}", face.family, face.style))
}

fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    fs::copy(from, to).map_err(|e| e.to_string())?;
    recycle(from)
}

fn recycle(path: &Path) -> Result<(), String> {
    trash::delete(path).map_err(|e| e.to_string())
}

fn unique_dest(dir: &Path, file_name: &std::ffi::OsStr) -> PathBuf {
    let mut dest = dir.join(file_name);
    let mut n = 1;
    while dest.exists() {
        dest = dir.join(format!("{n}-{}", file_name.to_string_lossy()));
        n += 1;
    }
    dest
}

/// 暂存/待处理文件：字体 或 版权信息类文件（许可证、版权说明等）
#[derive(Debug, Clone)]
pub struct StagedFile {
    pub path: PathBuf,
    /// 是否为字体文件（false = 版权信息类文件）
    pub is_font: bool,
    /// 在压缩包/拖入文件夹内的相对目录（空 = 根目录），用于把许可证与对应字体归到同一字族
    pub rel: PathBuf,
}

/// 判断是否为值得保留的版权信息类文件（许可证、版权声明、说明文档等）
fn is_info_file(name: &Path) -> bool {
    let Some(fname) = name.file_name().and_then(|f| f.to_str()) else {
        return false;
    };
    let lower = fname.to_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    if matches!(ext, "ttf" | "otf" | "ttc" | "woff" | "woff2") {
        return false;
    }
    let keyword = ["license", "licence", "copyright", "ofl", "readme", "notice", "patents", "授权", "版权", "许可"]
        .iter()
        .any(|k| lower.contains(k));
    matches!(ext, "txt" | "md" | "pdf") || keyword
}

fn expand_dropped(path: &Path, staging: &Path) -> Result<Vec<StagedFile>, String> {
    if path.is_dir() {
        let mut out = Vec::new();
        for e in walkdir::WalkDir::new(path)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
        {
            let p = e.path();
            let rel = p
                .strip_prefix(path)
                .ok()
                .and_then(|r| r.parent().map(|pp| pp.to_path_buf()))
                .unwrap_or_default();
            if parser::is_font_file(p) {
                out.push(StagedFile {
                    path: p.to_path_buf(),
                    is_font: true,
                    rel,
                });
            } else if is_info_file(p) {
                out.push(StagedFile {
                    path: p.to_path_buf(),
                    is_font: false,
                    rel,
                });
            }
        }
        return Ok(out);
    }
    if path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("zip"))
    {
        let file = fs::File::open(path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        fs::create_dir_all(staging).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            let Some(name) = entry.enclosed_name() else { continue };
            let is_font = parser::is_font_file(&name);
            let is_info = !is_font && is_info_file(&name);
            if !is_font && !is_info {
                continue; // 其余文件（安装器、图片等）不保留
            }
            let file_name = name.file_name().ok_or("bad zip entry")?.to_owned();
            let dest = unique_dest(staging, &file_name);
            let mut out_file = fs::File::create(&dest).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
            out.push(StagedFile {
                path: dest,
                is_font,
                rel: name
                    .parent()
                    .map(|pp| pp.to_path_buf())
                    .unwrap_or_default(),
            });
        }
        return Ok(out);
    }
    if parser::is_font_file(path) {
        return Ok(vec![StagedFile {
            path: path.to_path_buf(),
            is_font: true,
            rel: PathBuf::new(),
        }]);
    }
    Err(format!("not a font file: {}", path.display()))
}

pub fn install(
    app: &tauri::AppHandle,
    dropped: Vec<String>,
    existing: &HashSet<String>,
    mode: InstallMode,
    library: &Path,
) -> InstallResult {
    let staging = crate::store::app_data_dir().join("staging");
    let mut result = InstallResult::default();
    let mut known: HashSet<String> = existing.clone();

    if mode == InstallMode::Move {
        if let Err(e) = fs::create_dir_all(library) {
            result.errors.push(e.to_string());
            return result;
        }
    }

    let mut files: Vec<StagedFile> = Vec::new();
    for p in &dropped {
        match expand_dropped(Path::new(p), &staging) {
            Ok(mut f) => files.append(&mut f),
            Err(e) => result.errors.push(e),
        }
    }

    let infos: Vec<StagedFile> = files
        .iter()
        .filter(|f| !f.is_font)
        .cloned()
        .collect();
    let fonts: Vec<StagedFile> = files.into_iter().filter(|f| f.is_font).collect();
    let total = fonts.len();

    // 归档追踪：相对目录 → 该目录中的字体被归入的字族目录；以及本次安装创建的全部字族目录
    let mut rel_family_dirs: std::collections::HashMap<PathBuf, Vec<PathBuf>> =
        std::collections::HashMap::new();
    let mut all_family_dirs: Vec<PathBuf> = Vec::new();

    for (i, staged) in fonts.into_iter().enumerate() {
        let src = staged.path;
        let src_faces = parser::parse_font_file(&src, FontSource::Managed);
        let src_keys: Vec<String> = src_faces.iter().map(dup_key).collect();
        if !src_keys.is_empty() && src_keys.iter().all(|k| known.contains(k)) {
            for k in &src_keys {
                if !result.duplicates.contains(k) {
                    result.duplicates.push(k.clone());
                }
            }
            let _ = app.emit(
                "install:progress",
                InstallProgress {
                    file: src
                        .file_name()
                        .map(|f| f.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    done: i + 1,
                    total,
                    ok: true,
                    error: None,
                },
            );
            continue;
        }
        match mode {
            InstallMode::Link => {
                if src_faces.is_empty() {
                    let name = src
                        .file_name()
                        .map(|f| f.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    let _ = app.emit(
                        "install:progress",
                        InstallProgress {
                            file: name.clone(),
                            done: i + 1,
                            total,
                            ok: false,
                            error: Some("couldn't read font file".to_string()),
                        },
                    );
                    result
                        .errors
                        .push(format!("couldn't read font file: {}", src.display()));
                    continue;
                }
                let _ = app.emit(
                    "install:progress",
                    InstallProgress {
                        file: src
                            .file_name()
                            .map(|f| f.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                        done: i + 1,
                        total,
                        ok: true,
                        error: None,
                    },
                );
                let mut faces = src_faces;
                for face in &mut faces {
                    face.active = false;
                    known.insert(dup_key(face));
                }
                result.installed.extend(faces);
            }
            InstallMode::Move => {
                let file_name = src.file_name().map(|f| f.to_owned()).unwrap_or_default();
                // 按字族归档：<库目录>/<家族名（版权后缀）>/；解析失败时退回库根目录
                let target_dir = match src_faces.first() {
                    Some(f0) => {
                        let class = copyright::classify(f0.license.as_deref());
                        library.join(copyright::family_dir_name(&f0.family, class))
                    }
                    None => library.to_path_buf(),
                };
                let created = fs::create_dir_all(&target_dir).map_err(|e| e.to_string());
                if let Err(e) = created {
                    let _ = app.emit(
                        "install:progress",
                        InstallProgress {
                            file: file_name.to_string_lossy().into_owned(),
                            done: i + 1,
                            total,
                            ok: false,
                            error: Some(e.clone()),
                        },
                    );
                    result.errors.push(e);
                    continue;
                }
                let dest = unique_dest(&target_dir, &file_name);
                let moved = move_file(&src, &dest).map_err(|e| e.to_string());
                let (ok, error) = match &moved {
                    Ok(()) => (true, None),
                    Err(e) => (false, Some(e.clone())),
                };
                let _ = app.emit(
                    "install:progress",
                    InstallProgress {
                        file: file_name.to_string_lossy().into_owned(),
                        done: i + 1,
                        total,
                        ok,
                        error: error.clone(),
                    },
                );
                match moved {
                    Ok(()) => {
                        let mut faces = parser::parse_font_file(&dest, FontSource::Managed);
                        for face in &mut faces {
                            face.active = false;
                            known.insert(dup_key(face));
                        }
                        // 记录字族目录，供版权信息文件归档
                        if let Some(parent) = Path::new(&dest).parent() {
                            if parent != library {
                                if !all_family_dirs.iter().any(|d| d == parent) {
                                    all_family_dirs.push(parent.to_path_buf());
                                }
                                rel_family_dirs
                                    .entry(staged.rel.clone())
                                    .or_default()
                                    .push(parent.to_path_buf());
                            }
                        }
                        result.installed.extend(faces);
                    }
                    Err(e) => result.errors.push(e),
                }
            }
        }
    }

    // 版权信息文件（许可证/版权声明/说明）随字体归档到字族目录：
    // 与字体同处一个子目录且该目录只归入一个字族 → 只进那个字族；
    // 否则若本次安装只产生一个字族 → 进它；多字族时每个字族目录都放一份
    if mode == InstallMode::Move {
        for info in &infos {
            let Some(name) = info.path.file_name().map(|f| f.to_owned()) else {
                continue;
            };
            let mut targets: Vec<PathBuf> = Vec::new();
            if let Some(dirs) = rel_family_dirs.get(&info.rel) {
                let mut uniq: Vec<PathBuf> = Vec::new();
                for d in dirs {
                    if !uniq.contains(d) {
                        uniq.push(d.clone());
                    }
                }
                if uniq.len() == 1 {
                    targets.push(uniq.remove(0));
                }
            }
            if targets.is_empty() {
                if all_family_dirs.len() == 1 {
                    targets.push(all_family_dirs[0].clone());
                } else {
                    targets.extend(all_family_dirs.iter().cloned());
                }
            }
            for t in targets {
                let _ = fs::copy(&info.path, unique_dest(&t, &name));
            }
        }
    }

    let _ = fs::remove_dir_all(&staging);
    refresh_system_font_cache();
    result
}

/// 在线下载字体的安装：
/// 目标结构 <库目录>/在线栏目/<来源缩写>/<家族名（版权后缀）>/，
/// 字体文件移入该目录，许可证文件复制一份进去，最后清掉本次下载的 staging 目录。
pub fn install_online(
    app: &tauri::AppHandle,
    paths: Vec<String>,
    existing: &HashSet<String>,
    family: &str,
    license_path: Option<&str>,
    source: &str,
    library: &Path,
) -> InstallResult {
    let mut result = InstallResult::default();
    let mut known: HashSet<String> = existing.clone();
    let total = paths.len();

    // 许可证文本 → 版权分类 → 目录名后缀
    let license_text = license_path.and_then(|p| fs::read_to_string(p).ok());
    let class = copyright::classify(license_text.as_deref());
    let dir = library
        .join(ONLINE_DIR_NAME)
        .join(sanitize_component(source))
        .join(copyright::family_dir_name(family, class));
    if let Err(e) = fs::create_dir_all(&dir) {
        result.errors.push(e.to_string());
        return result;
    }

    let emit = |file: &str, done: usize, ok: bool, error: Option<String>| {
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                file: file.to_string(),
                done,
                total,
                ok,
                error,
            },
        );
    };

    let mut staging_parent: Option<PathBuf> = None;
    for (i, p) in paths.iter().enumerate() {
        let src = Path::new(p);
        let file_name = src.file_name().map(|f| f.to_owned()).unwrap_or_default();
        let src_faces = parser::parse_font_file(src, FontSource::Managed);
        let src_keys: Vec<String> = src_faces.iter().map(dup_key).collect();
        if !src_keys.is_empty() && src_keys.iter().all(|k| known.contains(k)) {
            for k in &src_keys {
                if !result.duplicates.contains(k) {
                    result.duplicates.push(k.clone());
                }
            }
            emit(&file_name.to_string_lossy(), i + 1, true, None);
            continue;
        }
        let dest = unique_dest(&dir, &file_name);
        match move_file(src, &dest) {
            Ok(()) => {
                if staging_parent.is_none() {
                    staging_parent = src.parent().map(|p| p.to_path_buf());
                }
                let mut faces = parser::parse_font_file(&dest, FontSource::Managed);
                for face in &mut faces {
                    face.active = false;
                    known.insert(dup_key(face));
                }
                result.installed.extend(faces);
                emit(&file_name.to_string_lossy(), i + 1, true, None);
            }
            Err(e) => {
                result.errors.push(e.clone());
                emit(&file_name.to_string_lossy(), i + 1, false, Some(e));
            }
        }
    }

    // 许可证文件复制进字族目录（保留原文件名）
    if let Some(lp) = license_path {
        if let Some(name) = Path::new(lp).file_name() {
            let _ = fs::copy(lp, dir.join(name));
        }
    }
    // 清掉本次下载的 staging 目录
    if let Some(parent) = staging_parent {
        let _ = fs::remove_dir_all(parent);
    }
    refresh_system_font_cache();
    result
}

/// 清理路径组件中的非法字符
fn sanitize_component(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            _ => c,
        })
        .collect();
    cleaned.trim().to_string()
}

pub fn uninstall(path: &str, family: &str) -> Result<TrashEntry, String> {
    #[cfg(target_os = "windows")]
    unregister_user_font(path);

    let trash = crate::store::trash_dir();
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let src = Path::new(path);
    let file_name = src.file_name().ok_or("invalid path")?;
    let dest = unique_dest(&trash, file_name);
    move_file(src, &dest)?;

    let entry = TrashEntry {
        id: dest.to_string_lossy().into_owned(),
        original_path: path.to_string(),
        trashed_path: dest.to_string_lossy().into_owned(),
        family: family.to_string(),
        trashed_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    };

    let meta = dest.with_extension(format!(
        "{}.zfmtrash",
        dest.extension().and_then(|e| e.to_str()).unwrap_or("bin")
    ));
    let _ = fs::write(&meta, serde_json::to_vec(&entry).unwrap_or_default());
    refresh_system_font_cache();
    Ok(entry)
}

pub fn list_trash() -> Vec<TrashEntry> {
    let trash = crate::store::trash_dir();
    let Ok(entries) = fs::read_dir(&trash) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().to_string_lossy().ends_with(".zfmtrash"))
        .filter_map(|e| {
            let bytes = fs::read(e.path()).ok()?;
            serde_json::from_slice::<TrashEntry>(&bytes).ok()
        })
        .filter(|t| Path::new(&t.trashed_path).exists())
        .collect()
}

pub fn restore(entry_id: &str) -> Result<RestoreOutcome, String> {
    let entry = list_trash()
        .into_iter()
        .find(|t| t.id == entry_id)
        .ok_or("trash entry not found")?;
    if entry.original_path == entry.trashed_path {
        if let Some(sidecar) = find_sidecar(&crate::store::trash_dir(), entry_id) {
            let _ = fs::remove_file(sidecar);
        }
        refresh_system_font_cache();
        return Ok(RestoreOutcome::Relinked(entry.original_path));
    }
    if let Some(parent) = Path::new(&entry.original_path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    move_file(Path::new(&entry.trashed_path), Path::new(&entry.original_path))?;
    remove_sidecar(&entry.trashed_path);
    refresh_system_font_cache();
    Ok(RestoreOutcome::Moved)
}

pub fn empty_trash() -> Result<(), String> {
    let trash = crate::store::trash_dir();
    if !trash.exists() {
        return Ok(());
    }
    let mut errors = Vec::new();
    for entry in list_trash() {
        if entry.original_path == entry.trashed_path {
            continue;
        }
        if let Err(e) = recycle(Path::new(&entry.trashed_path)) {
            errors.push(e);
        }
    }
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    fs::remove_dir_all(&trash).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_trash_entry(entry_id: &str) -> Result<(), String> {
    let entry = list_trash()
        .into_iter()
        .find(|t| t.id == entry_id)
        .ok_or("trash entry not found")?;
    if entry.original_path == entry.trashed_path {
        if let Some(sidecar) = find_sidecar(&crate::store::trash_dir(), entry_id) {
            fs::remove_file(sidecar).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    recycle(Path::new(&entry.trashed_path))?;
    remove_sidecar(&entry.trashed_path);
    Ok(())
}

pub enum RestoreOutcome {
    Moved,
    Relinked(String),
}

pub fn unlink(path: &str, family: &str) -> Result<TrashEntry, String> {
    #[cfg(target_os = "windows")]
    unregister_user_font(path);

    let trash = crate::store::trash_dir();
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let trashed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let entry = TrashEntry {
        id: format!("link:{path}"),
        original_path: path.to_string(),
        trashed_path: path.to_string(),
        family: family.to_string(),
        trashed_at,
    };
    let mut sidecar = trash.join(format!("link-{trashed_at}.zfmtrash"));
    let mut n = 1;
    while sidecar.exists() {
        n += 1;
        sidecar = trash.join(format!("link-{trashed_at}-{n}.zfmtrash"));
    }
    fs::write(&sidecar, serde_json::to_vec(&entry).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    refresh_system_font_cache();
    Ok(entry)
}

fn find_sidecar(trash: &Path, entry_id: &str) -> Option<PathBuf> {
    fs::read_dir(trash)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("zfmtrash"))
        .find(|p| {
            fs::read(p)
                .ok()
                .and_then(|b| serde_json::from_slice::<TrashEntry>(&b).ok())
                .is_some_and(|t| t.id == entry_id)
        })
}

fn remove_sidecar(trashed_path: &str) {
    let p = Path::new(trashed_path);
    let meta = p.with_extension(format!(
        "{}.zfmtrash",
        p.extension().and_then(|e| e.to_str()).unwrap_or("bin")
    ));
    let _ = fs::remove_file(meta);
}

fn refresh_system_font_cache() {
    #[cfg(target_os = "linux")]
    {
        if let Ok(mut child) = std::process::Command::new("fc-cache").spawn() {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
    #[cfg(target_os = "windows")]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SendNotifyMessageW, HWND_BROADCAST, WM_FONTCHANGE,
        };
        SendNotifyMessageW(HWND_BROADCAST, WM_FONTCHANGE, 0, 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_info_files() {
        assert!(is_info_file(Path::new("OFL.txt")));
        assert!(is_info_file(Path::new("LICENSE")));
        assert!(is_info_file(Path::new("Font-License.pdf")));
        assert!(is_info_file(Path::new("版权说明.txt")));
        assert!(!is_info_file(Path::new("Font.ttf")));
        assert!(!is_info_file(Path::new("preview.png")));
        assert!(!is_info_file(Path::new("installer.exe")));
    }

    #[test]
    fn uninstall_restore_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("zfm-inst-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();

        unsafe { std::env::set_var("XDG_DATA_HOME", &tmp) };

        let font = tmp.join("Fake Font.ttf");
        fs::write(&font, b"not really a font").unwrap();

        let entry = uninstall(font.to_str().unwrap(), "Fake Font").unwrap();
        assert!(!font.exists(), "file should be moved out");
        assert!(Path::new(&entry.trashed_path).exists());

        let listed = list_trash();
        let found = listed
            .iter()
            .find(|t| t.id == entry.id)
            .expect("our entry should be listed");
        assert_eq!(found.family, "Fake Font");

        restore(&entry.id).unwrap();
        assert!(font.exists(), "file should be back after restore");
        assert!(list_trash().iter().all(|t| t.id != entry.id));

        let _ = fs::remove_dir_all(&tmp);
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn unregister_user_font(path: &str) {
    use crate::registry;
    registry::remove_font_resource(path);
    for name in registry::user_entries_for(path) {
        let _ = registry::delete_user_entry(&name);
    }
    refresh_system_font_cache();
}
