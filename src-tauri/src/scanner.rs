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
    let all_files: Vec<(PathBuf, FontSource)> = all_dirs(extra)
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

    let total = files.len();
    let mut faces = Vec::with_capacity(total);
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
