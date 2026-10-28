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

pub fn scan_all(
    app: &tauri::AppHandle,
    extra: &[String],
    managed: &Path,
    cache: &mut crate::fontcache::FontCache,
) -> Vec<FontFace> {
    let files: Vec<(PathBuf, FontSource)> = all_dirs(extra)
        .into_iter()
        .flat_map(|(dir, source)| {
            WalkDir::new(dir)
                .follow_links(true)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
                .map(move |e| (e.into_path(), source))
                .filter(|(p, _)| parser::is_font_file(p))
                .collect::<Vec<_>>()
        })
        .collect();

    let total = files.len();
    let mut faces = Vec::with_capacity(total);
    // 字体库里按目录缓存版权判定：目录名 / 同目录的版权信息文件写明的版权，
    // 一个目录只判一次（要读文件，但比解析字体便宜得多）
    let mut dir_class: std::collections::HashMap<PathBuf, String> =
        std::collections::HashMap::new();
    // 解析结果缓存由调用方持有：链接字体那一段也用同一个实例，最后统一落盘
    // 边扫边推：已解析好的字体分批发给前端，界面就能「读到多少显示多少」，
    // 而不是等全部扫完（几千个字体时要好几秒）才一次性出现。
    let mut batch: Vec<FontFace> = Vec::with_capacity(BATCH_FACES);
    // 先把 0% 报出去：界面立刻能显示进度条，而不是空等第一帧解析完
    let _ = app.emit("scan:progress", ScanProgress { done: 0, total });
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
                let class = dir_class
                    .entry(dir.to_path_buf())
                    .or_insert_with(|| {
                        crate::copyright::classify_dir(dir).as_str().to_string()
                    })
                    .clone();
                for face in &mut parsed {
                    face.copyright_class = Some(class.clone());
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
        if done % 25 == 0 || done + 1 == total {
            let _ = app.emit("scan:progress", ScanProgress { done: done + 1, total });
        }
    }
    if !batch.is_empty() {
        let _ = app.emit("scan:batch", &batch);
    }

    faces.sort_by(|a, b| a.id.cmp(&b.id));
    faces.dedup_by(|a, b| a.id == b.id);
    faces
}
